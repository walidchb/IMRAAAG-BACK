import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../../../common/errors/app-exception';
import { AppErrorCode } from '../../../../common/errors/error-codes.enum';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  DeliveryCompanyHandler,
  BulkOrderResult,
  DeliveryStatusContext,
  DeliveryStatusEntry,
  DeliveryStatusParcel,
  DeliveryStatusSearchResult,
  DeliveryLabelContext,
  DeliveryLabelDocument,
  DeliveryLabelFailure,
  DeliveryLabelOrder,
  DeliveryLabelResult,
} from '../interfaces/delivery-company-handler.interface';
import { DeliveryConfig, DeliveryConfigDocument } from '../../schemas/delivery-config.schema';
import { Commune, CommuneDocument } from '../../../territories/schemas/commune.schema';
import { Order } from '../../../orders/schemas/order.schema';
import { decryptRecord } from '../../../../common/encryption.util';
import { fetchWithRetry } from '../../../../common/fetch-with-retry';
import { isPdf, mapWithConcurrency, parseRetryAfter } from './order-label.util';
import type { SignalOverrides, StateOverrides } from '../../delivery-status/carrier/carrier-signal';
import {
  MappedDhdHistoryEntry,
  MappedDhdParcel,
  mapDhdHistoryEntries,
  mapDhdParcel,
  normalizeDhdOffset,
} from './dhd/dhd-status.mapper';
import type {
  DhdActivityDto,
  DhdHistoryResponseDto,
  DhdParcelDto,
  DhdStatusResponseDto,
} from './dhd/dhd-status.types';

const DHD_STATUS_BREAKER_PREFIX = 'dhd-status:';
const DHD_STATUS_TIMEOUT_MS = 15000;
const DHD_STATUS_BATCH_SIZE = 100;
const DHD_HISTORY_CACHE_TTL_MS = 10 * 60_000;
const DHD_HISTORY_CACHE_MAX = 2000;

const DHD_LABEL_BREAKER_PREFIX = 'dhd-labels:';
const DHD_LABEL_TIMEOUT_MS = 15000;
const DHD_LABEL_MAX_BYTES = 20 * 1024 * 1024;
const DHD_LABEL_CONCURRENCY = 5;

interface DhdStatusCredentials {
  apiToken: string;
  tenantId: string;
  overrides: StateOverrides | null;
  signalOverrides: SignalOverrides | null;
}

interface DhdHistoryCacheEntry {
  dto: DhdParcelDto;
  fetchedAt: number;
}

class DhdInvalidTrackingError extends Error {
  constructor() {
    super('The carrier rejected a tracking identifier');
  }
}

interface DhdOrderPayload {
  reference?: string;
  nom_client: string;
  telephone: string;
  telephone_2?: string;
  adresse: string;
  commune: string;
  code_wilaya: string;
  montant: number;
  remarque?: string;
  produit: string;
  type: number;
  stop_desk: number;
  poids?: number;
}

interface DhdBulkResponse {
  results?: Record<string, DhdSingleResult | Record<string, string[]>>;
}

interface DhdSingleResult {
  success: boolean;
  tracking?: string;
  error?: string;
  message?: string;
}

@Injectable()
export class DhdHandler implements DeliveryCompanyHandler {
  readonly companyId = 'dhd';
  private readonly apiBase = 'https://platform.dhd-dz.com';
  private readonly logger = new Logger(DhdHandler.name);
  private readonly historyCache = new Map<string, DhdHistoryCacheEntry>();

  constructor(
    @InjectModel(DeliveryConfig.name)
    private configModel: Model<DeliveryConfigDocument>,
    @InjectModel(Commune.name)
    private communeModel: Model<CommuneDocument>,
    private readonly configService: ConfigService,
  ) {}

  private get encryptionKey(): string {
    return this.configService.get<string>('deliveryEncryptionKey') || '';
  }

  private labelConcurrency(): number {
    const configured = Number(this.configService.get<number>('orderLabels.carrierConcurrency'));
    return Number.isFinite(configured) && configured > 0
      ? Math.min(10, Math.floor(configured))
      : DHD_LABEL_CONCURRENCY;
  }

  async createOrder(order: Order): Promise<{ parcelId: string }> {
    const apiToken = await this.getApiToken(order.vendorEmail);
    if (!apiToken) {
      throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, { company: 'DHD', vendor: order.vendorEmail });
    }

    const communeName = await this.resolveCommuneName(order.customer.wilaya, order.customer.commune);
    const payload = this.buildPayload(order, communeName);

    const params = new URLSearchParams();
    if (payload.reference) params.append('reference', payload.reference);
    params.append('nom_client', payload.nom_client);
    params.append('telephone', payload.telephone);
    params.append('adresse', payload.adresse);
    params.append('commune', payload.commune);
    params.append('code_wilaya', payload.code_wilaya);
    params.append('montant', String(payload.montant));
    params.append('produit', payload.produit);
    params.append('type', String(payload.type));
    params.append('stop_desk', String(payload.stop_desk));
    if (payload.telephone_2) params.append('telephone_2', payload.telephone_2);
    if (payload.remarque) params.append('remarque', payload.remarque);
    if (payload.poids) params.append('weight', String(payload.poids));

    try {
      const url = `${this.apiBase}/api/v1/create/order?${params.toString()}`;
      this.logger.log(`DHD order URL (truncated): ${url.slice(0, 300)}...`);

      const response = await fetchWithRetry(
        url,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            Accept: 'application/json',
          },
          timeout: 10000,
        },
        {
          circuitBreakerName: 'dhd',
          onRetry: (attempt, err) => this.logger.warn(`DHD create order retry ${attempt}: ${err instanceof Error ? err.message : 'HTTP ' + err.status}`),
        },
      );

      const text = await response.text();
      this.logger.log(`DHD create order response (${response.status}): ${text}`);

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }

      if (body.success === true && body.tracking) {
        return { parcelId: String(body.tracking) };
      }

      const msg = body.message || body.error || text;
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, { company: 'DHD', status: response.status, text: msg });
    } catch (err) {
      if (err instanceof AppException) throw err;
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`DHD create order failed for ${order.orderNo}: ${message}`);
      throw new AppException(AppErrorCode.DELIVERY_UNKNOWN_ERROR, { company: 'DHD', orderNo: order.orderNo, message });
    }
  }

  async createBulkOrders(orders: Order[]): Promise<BulkOrderResult[]> {
    if (orders.length === 0) return [];
    if (orders.length > 100) {
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: 'Max 100 orders per bulk request' }));
    }

    const apiToken = await this.getApiToken(orders[0].vendorEmail);
    if (!apiToken) {
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: 'DHD API token not configured' }));
    }

    const ordersPayload: Record<string, DhdOrderPayload> = {};
    for (let i = 0; i < orders.length; i++) {
      const communeName = await this.resolveCommuneName(orders[i].customer.wilaya, orders[i].customer.commune);
      ordersPayload[String(i)] = this.buildPayload(orders[i], communeName);
    }

    try {
      this.logger.log(`DHD bulk payload for ${orders.length} orders`);

      const response = await fetchWithRetry(
        `${this.apiBase}/api/v1/create/orders`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ orders: ordersPayload }),
          timeout: 15000,
        },
        {
          circuitBreakerName: 'dhd',
          onRetry: (attempt, err) => this.logger.warn(`DHD bulk create retry ${attempt}: ${err instanceof Error ? err.message : 'HTTP ' + err.status}`),
        },
      );

      const responseText = await response.text();
      let body: DhdBulkResponse;
      try {
        body = JSON.parse(responseText);
      } catch {
        body = {};
      }

      this.logger.log(`DHD bulk response (${response.status}): ${JSON.stringify(body).slice(0, 800)}`);

      const results: BulkOrderResult[] = [];
      const resultMap = body.results;

      if (resultMap) {
        for (let i = 0; i < orders.length; i++) {
          const order = orders[i];
          const ref = order.orderNo;
          const entry = resultMap[ref] || resultMap[String(i)];

          if (!entry) {
            results.push({ orderNo: order.orderNo, success: false, error: 'Order not included in API response' });
            continue;
          }

          if ('success' in entry && typeof entry.success === 'boolean') {
            const result = entry as DhdSingleResult;
            if (result.success && result.tracking) {
              results.push({ orderNo: order.orderNo, success: true, parcelId: result.tracking });
            } else {
              const msg = result.message || result.error || 'Unknown error';
              results.push({ orderNo: order.orderNo, success: false, error: msg });
            }
          } else {
            const errors = Object.values(entry).flat().join('; ');
            results.push({ orderNo: order.orderNo, success: false, error: errors || 'Unknown error' });
          }
        }
      } else {
        return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: 'Unexpected DHD API response format' }));
      }

      return results;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`DHD bulk API call failed: ${message}`);
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: message }));
    }
  }

  async searchStatusParcels(
    context: DeliveryStatusContext,
  ): Promise<DeliveryStatusSearchResult> {
    const credentials = await this.resolveStatusCredentials(context);
    const ids = [...new Set((context.parcelIds ?? []).map((id) => String(id).trim()).filter(Boolean))];

    if (ids.length === 0) {
      return { parcels: [], totalCount: 0, hasNext: false, missingParcelIds: [] };
    }

    const page = context.page && context.page > 0 ? Math.floor(context.page) : null;
    const pageSize =
      context.limit && context.limit > 0
        ? Math.min(Math.floor(context.limit), DHD_STATUS_BATCH_SIZE)
        : null;
    const selected = page
      ? ids.slice((page - 1) * (pageSize ?? ids.length), (page - 1) * (pageSize ?? ids.length) + (pageSize ?? ids.length))
      : ids;
    const hasNext = page !== null && page * (pageSize ?? ids.length) < ids.length;

    const scattered = await this.fetchParcelsByIds(selected, credentials);
    const parcels: DeliveryStatusParcel[] = [];
    const missingParcelIds: string[] = [];

    for (const id of selected) {
      const dto = scattered.parcels.get(id);
      if (!dto) {
        missingParcelIds.push(id);
        continue;
      }
      this.rememberHistory(credentials, id, dto);
      parcels.push(this.toStatusParcel(dto, credentials));
    }

    this.logger.debug(
      `DHD status discovery: requested ${selected.length}, found ${parcels.length}, missing ${missingParcelIds.length}.`,
    );

    return {
      parcels,
      totalCount: ids.length,
      hasNext,
      missingParcelIds: [...new Set([...missingParcelIds, ...scattered.missing])],
    };
  }

  async fetchStatusHistory(
    context: DeliveryStatusContext,
    parcelId: string,
  ): Promise<DeliveryStatusEntry[]> {
    const credentials = await this.resolveStatusCredentials(context);
    const tracking = String(parcelId ?? '').trim();
    if (!tracking) return [];

    const cached = this.cachedHistory(credentials, tracking);
    if (cached && cached.activity && cached.activity.length > 0) {
      return this.toStatusEntries(tracking, cached.activity, credentials);
    }

    const body = await this.getStatusJson<DhdHistoryResponseDto>(
      '/api/v1/get/tracking/info',
      { tracking },
      credentials,
    );
    const activity = this.extractActivity(body);
    this.rememberHistory(credentials, tracking, { tracking, activity });
    return this.toStatusEntries(tracking, activity, credentials);
  }

  async fetchStatusHistories(
    context: DeliveryStatusContext,
    parcelIds: string[],
  ): Promise<Record<string, DeliveryStatusEntry[]>> {
    const result: Record<string, DeliveryStatusEntry[]> = {};
    for (const parcelId of [...new Set(parcelIds.map((id) => String(id).trim()).filter(Boolean))]) {
      try {
        result[parcelId] = await this.fetchStatusHistory(context, parcelId);
      } catch (err) {
        this.logger.warn(
          `DHD status history failed for ${parcelId}: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
        result[parcelId] = [];
      }
    }
    return result;
  }

  async resolveStatusTenant(context: DeliveryStatusContext): Promise<string | null> {
    const credentials = await this.resolveStatusCredentials(context);
    return credentials.tenantId;
  }

  private async fetchParcelsByIds(
    ids: string[],
    credentials: DhdStatusCredentials,
  ): Promise<{ parcels: Map<string, DhdParcelDto>; missing: string[] }> {
    const parcels = new Map<string, DhdParcelDto>();
    const missing: string[] = [];

    for (let start = 0; start < ids.length; start += DHD_STATUS_BATCH_SIZE) {
      const chunk = ids.slice(start, start + DHD_STATUS_BATCH_SIZE);
      const found = await this.fetchParcelChunk(chunk, credentials);
      for (const [tracking, dto] of found.parcels) parcels.set(tracking, dto);
      missing.push(...found.missing);
    }

    return { parcels, missing: [...new Set(missing)] };
  }

  private async fetchParcelChunk(
    ids: string[],
    credentials: DhdStatusCredentials,
  ): Promise<{ parcels: Map<string, DhdParcelDto>; missing: string[] }> {
    try {
      const body = await this.getStatusJson<DhdStatusResponseDto>(
        '/api/v1/get/trackings/info',
        { 'trackings[]': ids },
        credentials,
      );
      return { parcels: this.extractParcels(body, ids), missing: [] };
    } catch (err) {
      if (!(err instanceof DhdInvalidTrackingError)) throw err;
      if (ids.length === 1) return { parcels: new Map(), missing: ids };
      const middle = Math.ceil(ids.length / 2);
      const left = await this.fetchParcelChunk(ids.slice(0, middle), credentials);
      const right = await this.fetchParcelChunk(ids.slice(middle), credentials);
      for (const [tracking, dto] of right.parcels) left.parcels.set(tracking, dto);
      return { parcels: left.parcels, missing: [...left.missing, ...right.missing] };
    }
  }

  private extractParcels(
    body: DhdStatusResponseDto,
    requested: readonly string[],
  ): Map<string, DhdParcelDto> {
    const result = new Map<string, DhdParcelDto>();
    const requestedSet = new Set(requested);
    const data = body.data;

    const add = (tracking: unknown, value: unknown): void => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const record = value as Record<string, unknown>;
      const orderInfo =
        record.OrderInfo && typeof record.OrderInfo === 'object' && !Array.isArray(record.OrderInfo)
          ? (record.OrderInfo as Record<string, unknown>)
          : null;
      const candidate = { ...(orderInfo ?? {}), ...record } as DhdParcelDto;
      const key = String(tracking ?? candidate.tracking ?? '').trim();
      if (!key) return;
      const candidateTracking = String(candidate.tracking ?? '').trim();
      if (!requestedSet.has(key) && !requestedSet.has(candidateTracking)) return;
      if (!candidate.tracking) candidate.tracking = key;
      if (!candidate.reference && orderInfo?.reference) {
        candidate.reference = String(orderInfo.reference);
      }
      result.set(key, candidate);
      for (const alias of [candidate.tracking, candidate.reference]) {
        const value = String(alias ?? '').trim();
        if (value && !result.has(value)) result.set(value, candidate);
      }
    };

    if (Array.isArray(data)) {
      for (const parcel of data) add(parcel?.tracking, parcel);
    } else if (data && typeof data === 'object') {
      for (const [tracking, parcel] of Object.entries(data)) add(tracking, parcel);
    }

    for (const parcel of body.trackings ?? []) add(parcel?.tracking, parcel);
    for (const [tracking, parcel] of Object.entries(body.orders ?? {})) add(tracking, parcel);

    const envelopeKeys = new Set(['data', 'trackings', 'orders', 'success', 'message']);
    for (const [tracking, parcel] of Object.entries(body)) {
      if (envelopeKeys.has(tracking)) continue;
      add(tracking, parcel);
    }

    if (result.size === 0 && requested.length === 1) {
      const single = body as unknown as DhdParcelDto;
      if (single.tracking) add(single.tracking, single);
    }

    if (result.size === 0) {
      this.logger.debug(
        `DHD status response did not contain a parcel; top-level keys: ${Object.keys(body)
          .slice(0, 10)
          .join(', ') || '(none)'}.`,
      );
    }

    return result;
  }

  private extractActivity(body: DhdHistoryResponseDto): DhdActivityDto[] {
    const activity = body.activity ?? body.data?.activity;
    return Array.isArray(activity) ? activity : [];
  }

  /* ------------------------------------------------------------------ *
   * Carrier label capability (L1)
   *
   * DHD returns a raw PDF. Its page geometry has not been verified live, so the document is
   * passed through unchanged (no guessed crop). Bearer is the default; the `api_token` query mode
   * remains opt-in and must be verified before production use.
   * ------------------------------------------------------------------ */

  async createLabels(
    orders: DeliveryLabelOrder[],
    context: DeliveryLabelContext,
  ): Promise<DeliveryLabelResult> {
    const documents: DeliveryLabelDocument[] = [];
    const failures: DeliveryLabelFailure[] = [];
    const printable = orders.filter((order) => String(order.trackingNumber ?? '').trim());

    for (const order of orders) {
      if (!String(order.trackingNumber ?? '').trim()) {
        failures.push(
          this.labelFailure(
            order,
            'ORDER_LABEL_TRACKING_UNAVAILABLE',
            'The carrier did not return a tracking number for this parcel.',
            true,
          ),
        );
      }
    }

    if (printable.length === 0) return { documents, failures };

    let credentials: DhdStatusCredentials;
    try {
      credentials = await this.resolveStatusCredentials({
        storeId: context.storeId,
        vendorEmail: context.vendorEmail ?? null,
      });
    } catch {
      for (const order of printable) {
        failures.push(
          this.labelFailure(
            order,
            'ORDER_LABEL_CARRIER_FAILED',
            'DHD credentials are not configured for this store.',
            false,
          ),
        );
      }
      return { documents, failures };
    }

    const results = await mapWithConcurrency(printable, this.labelConcurrency(), async (order) => {
      try {
        const tracking = String(order.trackingNumber);
        const bytes = await this.downloadDhdLabel(tracking, credentials, context.timeoutMs);
        return {
          document: {
            orderNo: order.orderNo,
            trackingNumber: tracking,
            contentType: 'application/pdf',
            bytes,
          } satisfies DeliveryLabelDocument,
          failure: null,
        };
      } catch (err) {
        return {
          document: null,
          failure: this.labelFailure(
            order,
            this.dhdLabelErrorCode(err),
            this.dhdLabelErrorMessage(err),
            this.isRetryableDhdLabelError(err),
          ),
        };
      }
    });

    for (const result of results) {
      if (result.document) documents.push(result.document);
      if (result.failure) failures.push(result.failure);
    }

    return { documents, failures };
  }

  private async downloadDhdLabel(
    tracking: string,
    credentials: DhdStatusCredentials,
    timeoutMs: number,
  ): Promise<Buffer> {
    const params = new URLSearchParams({ tracking });
    const authMode = this.configService.get<string>('orderLabels.dhdLabelAuthMode') || 'bearer';
    const headers: Record<string, string> = { Accept: 'application/pdf' };
    if (authMode === 'query') {
      params.set('api_token', credentials.apiToken);
    } else {
      headers.Authorization = `Bearer ${credentials.apiToken}`;
    }

    const url = `${this.labelApiBase()}/get/order/label?${params.toString()}`;
    let response: Response;
    try {
      response = await fetchWithRetry(
        url,
        {
          method: 'GET',
          headers,
          timeout: Math.min(timeoutMs || DHD_LABEL_TIMEOUT_MS, DHD_LABEL_TIMEOUT_MS),
        },
        {
          maxRetries: 2,
          circuitBreakerName: `${DHD_LABEL_BREAKER_PREFIX}${credentials.tenantId}`,
          retryOn: (candidate) => candidate.status !== 429,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (/timeout|timed out|aborted/i.test(message)) {
        throw new AppException(AppErrorCode.DELIVERY_API_TIMEOUT, { company: 'DHD' });
      }
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, {
        company: 'DHD',
        message,
      });
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new AppException(AppErrorCode.ORDER_LABEL_NOT_FOUND_AT_CARRIER, {
          company: 'DHD',
        });
      }
      if (response.status === 429) {
        throw new AppException(AppErrorCode.DELIVERY_API_RATE_LIMITED, {
          company: 'DHD',
          retryAfterSeconds: parseRetryAfter(response),
        });
      }
      if (response.status === 401 || response.status === 403) {
        throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, {
          company: 'DHD',
        });
      }
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, {
        company: 'DHD',
        status: response.status,
      });
    }

    const declared = Number.parseInt(response.headers.get('content-length') || '', 10);
    if (Number.isFinite(declared) && declared > DHD_LABEL_MAX_BYTES) {
      throw new AppException(AppErrorCode.ORDER_LABEL_RENDER_FAILED, {
        company: 'DHD',
        message: 'The carrier label file is too large.',
      });
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > DHD_LABEL_MAX_BYTES || !isPdf(bytes)) {
      throw new AppException(AppErrorCode.ORDER_LABEL_RENDER_FAILED, {
        company: 'DHD',
        message: 'The carrier returned an invalid PDF.',
      });
    }

    return bytes;
  }

  private labelApiBase(): string {
    const configured = this.configService.get<string>('orderLabels.dhdLabelApiBase');
    return (configured || 'https://platform.dhd-dz.com/api/v1').replace(/\/+$/, '');
  }

  private labelFailure(
    order: DeliveryLabelOrder,
    code: string,
    message: string,
    retryable: boolean,
  ): DeliveryLabelFailure {
    return {
      orderNo: order.orderNo,
      trackingNumber: order.trackingNumber ?? null,
      code,
      message,
      retryable,
    };
  }

  private dhdLabelErrorCode(err: unknown): string {
    if (err instanceof AppException) {
      if (err.errorCode === AppErrorCode.ORDER_LABEL_NOT_FOUND_AT_CARRIER) {
        return 'ORDER_LABEL_NOT_FOUND_AT_CARRIER';
      }
      if (err.errorCode === AppErrorCode.ORDER_LABEL_RENDER_FAILED) {
        return 'ORDER_LABEL_RENDER_FAILED';
      }
      if (err.errorCode === AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED) {
        return 'ORDER_LABEL_CARRIER_FAILED';
      }
      if (err.errorCode === AppErrorCode.DELIVERY_API_RATE_LIMITED) {
        return 'ORDER_LABEL_CARRIER_FAILED';
      }
    }
    return 'ORDER_LABEL_CARRIER_FAILED';
  }

  private dhdLabelErrorMessage(err: unknown): string {
    if (err instanceof AppException) {
      if (err.errorCode === AppErrorCode.ORDER_LABEL_NOT_FOUND_AT_CARRIER) {
        return 'The carrier could not find this parcel.';
      }
      if (err.errorCode === AppErrorCode.DELIVERY_API_RATE_LIMITED) {
        return 'The carrier rate limit was reached. Retry in a few minutes.';
      }
      if (err.errorCode === AppErrorCode.DELIVERY_API_TIMEOUT) {
        return 'The carrier timed out while generating the label.';
      }
      if (err.errorCode === AppErrorCode.ORDER_LABEL_RENDER_FAILED) {
        return 'The carrier returned an invalid label file.';
      }
      if (err.errorCode === AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED) {
        return 'DHD credentials are not configured for this store.';
      }
    }
    return 'The carrier could not generate the label.';
  }

  private isRetryableDhdLabelError(err: unknown): boolean {
    if (!(err instanceof AppException)) return true;
    return ![
      AppErrorCode.ORDER_LABEL_NOT_FOUND_AT_CARRIER,
      AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED,
      AppErrorCode.ORDER_LABEL_RENDER_FAILED,
    ].includes(err.errorCode as never);
  }

  private async resolveStatusCredentials(
    context: DeliveryStatusContext,
  ): Promise<DhdStatusCredentials> {
    const config = await this.findStatusConfig(context);
    if (!config) {
      throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, {
        company: 'DHD',
      });
    }
    this.guardStatusConfig(config, context);

    const company = config.companies?.[this.companyId];
    if (!company || company.status === 'disabled') {
      throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, {
        company: 'DHD',
      });
    }

    const creds = decryptRecord(company.credentials ?? {}, this.encryptionKey);
    const apiToken = (creds.apiToken || '').trim();
    if (!apiToken) {
      throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, {
        company: 'DHD',
      });
    }

    return {
      apiToken,
      tenantId: createHash('sha256').update(apiToken).digest('hex').slice(0, 16),
      overrides: config.statusStateOverrides?.[this.companyId] ?? null,
      signalOverrides: config.statusSignalOverrides?.[this.companyId] ?? null,
    };
  }

  private async findStatusConfig(
    context: DeliveryStatusContext,
  ): Promise<DeliveryConfig | null> {
    const storeId = String(context.storeId ?? '').trim();
    if (storeId && Types.ObjectId.isValid(storeId)) {
      return this.configModel
        .findOne({ storeId: new Types.ObjectId(storeId) })
        .lean<DeliveryConfig>()
        .exec();
    }

    const vendorEmail = String(context.vendorEmail ?? '').trim();
    if (!vendorEmail) return null;
    return this.configModel.findOne({ vendorEmail }).lean<DeliveryConfig>().exec();
  }

  private guardStatusConfig(
    config: DeliveryConfig,
    context: DeliveryStatusContext,
  ): void {
    const expectedStore = String(context.storeId ?? '').trim();
    if (expectedStore) {
      const actualStore = String(config.storeId ?? '').trim();
      if (actualStore && actualStore !== expectedStore) {
        throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, {
          company: 'DHD',
        });
      }
      return;
    }

    const expectedEmail = String(context.vendorEmail ?? '').trim().toLowerCase();
    const actualEmail = String(config.vendorEmail ?? '').trim().toLowerCase();
    if (expectedEmail && actualEmail && expectedEmail !== actualEmail) {
      throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, {
        company: 'DHD',
      });
    }
  }

  private toStatusParcel(
    dto: DhdParcelDto,
    credentials: DhdStatusCredentials,
  ): DeliveryStatusParcel {
    return mapDhdParcel(dto, credentials.overrides, {
      utcOffset: this.dhdOffset(),
    }) as unknown as DeliveryStatusParcel;
  }

  private toStatusEntries(
    tracking: string,
    activity: readonly DhdActivityDto[] | null | undefined,
    credentials: DhdStatusCredentials,
  ): DeliveryStatusEntry[] {
    return mapDhdHistoryEntries(tracking, activity, credentials.overrides, {
      utcOffset: this.dhdOffset(),
    }).map((entry: MappedDhdHistoryEntry) => ({
      ...entry,
      situationFlags: [...new Set(entry.situations.flatMap((situation) => situation.flags))],
    })) as unknown as DeliveryStatusEntry[];
  }

  private historyCacheKey(credentials: DhdStatusCredentials, tracking: string): string {
    return `${credentials.tenantId}:${tracking}`;
  }

  private cachedHistory(
    credentials: DhdStatusCredentials,
    tracking: string,
  ): DhdParcelDto | null {
    const key = this.historyCacheKey(credentials, tracking);
    const cached = this.historyCache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.fetchedAt > DHD_HISTORY_CACHE_TTL_MS) {
      this.historyCache.delete(key);
      return null;
    }
    this.historyCache.delete(key);
    this.historyCache.set(key, cached);
    return cached.dto;
  }

  private rememberHistory(
    credentials: DhdStatusCredentials,
    tracking: string,
    dto: DhdParcelDto,
  ): void {
    const key = this.historyCacheKey(credentials, tracking);
    this.historyCache.delete(key);
    this.historyCache.set(key, { dto, fetchedAt: Date.now() });

    const now = Date.now();
    for (const [candidate, entry] of this.historyCache) {
      if (now - entry.fetchedAt > DHD_HISTORY_CACHE_TTL_MS) {
        this.historyCache.delete(candidate);
      }
    }
    while (this.historyCache.size > DHD_HISTORY_CACHE_MAX) {
      const oldest = this.historyCache.keys().next().value;
      if (oldest === undefined) break;
      this.historyCache.delete(oldest);
    }
  }

  private dhdOffset(): string {
    return normalizeDhdOffset(this.configService.get<string>('dhdStatusSync.utcOffset'));
  }

  private statusApiBase(): string {
    const configured = this.configService.get<string>('dhdStatusSync.apiBase');
    return (configured || this.apiBase).replace(/\/+$/, '');
  }

  private async getStatusJson<T>(
    path: string,
    query: Record<string, string | readonly string[]>,
    credentials: DhdStatusCredentials,
  ): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        for (const item of value) params.append(key, item);
      } else if (value !== null && value !== undefined && String(value) !== '') {
        params.set(key, String(value));
      }
    }

    const authMode = this.configService.get<string>('dhdStatusSync.authMode') || 'bearer';
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (authMode === 'query') {
      params.set('api_token', credentials.apiToken);
    } else {
      headers.Authorization = `Bearer ${credentials.apiToken}`;
    }

    const url = `${this.statusApiBase()}${path}?${params.toString()}`;
    let response: Response;

    try {
      response = await fetchWithRetry(
        url,
        { method: 'GET', headers, timeout: DHD_STATUS_TIMEOUT_MS },
        {
          maxRetries: 2,
          circuitBreakerName: `${DHD_STATUS_BREAKER_PREFIX}${credentials.tenantId}`,
          retryOn: (candidate) => candidate.status !== 429,
        },
      );
    } catch (err) {
      if (err instanceof AppException) throw err;
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (/timeout|timed out|aborted/i.test(message)) {
        throw new AppException(AppErrorCode.DELIVERY_API_TIMEOUT, { company: 'DHD' });
      }
      throw new AppException(AppErrorCode.DELIVERY_UNKNOWN_ERROR, {
        company: 'DHD',
        message,
      });
    }

    const text = await response.text();
    let body: unknown = {};
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new AppException(AppErrorCode.DELIVERY_API_ERROR, {
          company: 'DHD',
          status: response.status,
          text: 'Malformed response body',
        });
      }
    }

    if (response.ok) return body as T;

    const payload =
      body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const message = String(payload.message ?? payload.error ?? text).slice(0, 500);
    this.logger.debug(`DHD ${path} answered HTTP ${response.status}: ${message.slice(0, 300)}`);

    if (response.status === 401 || response.status === 403) {
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, {
        company: 'DHD',
        status: response.status,
        text: message,
      });
    }
    if (response.status === 422) {
      throw new DhdInvalidTrackingError();
    }
    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get('retry-after') || '', 10);
      throw new AppException(AppErrorCode.DELIVERY_API_RATE_LIMITED, {
        company: 'DHD',
        retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60,
      });
    }

    throw new AppException(AppErrorCode.DELIVERY_API_ERROR, {
      company: 'DHD',
      status: response.status,
      text: message,
    });
  }

  private buildPayload(order: Order, communeName: string): DhdOrderPayload {
    const isStopDesk = order.shippingMethod === 'stopdesk';

    const produit =
      order.items
        ?.map((item) => item.productName || `Product ${item.productId || ''}`)
        .filter(Boolean)
        .join(', ')
        .slice(0, 255) || `Order ${order.orderNo}`;

    const weight = order.items?.reduce((sum, item) => sum + (item.weight || 0) * (item.quantity || 1), 0) || 0;

    const payload: DhdOrderPayload = {
      reference: order.orderNo,
      nom_client: (order.customer.name || 'Client').slice(0, 255),
      telephone: this.cleanPhone(order.customer.phone || ''),
      adresse: (order.customer.address || '').slice(0, 255) || 'N/A',
      commune: communeName,
      code_wilaya: order.customer.wilaya || '',
      montant: order.total || 0,
      produit: produit.slice(0, 255),
      type: 1,
      stop_desk: isStopDesk ? 1 : 0,
    };

    if (order.customer.email) {
      payload.telephone_2 = this.cleanPhone(order.customer.email);
    }

    if (order.customer.note) {
      payload.remarque = order.customer.note.slice(0, 255);
    }

    if (weight > 0) {
      payload.poids = weight;
    }

    return payload;
  }

  private async resolveCommuneName(wilayaCode: string, communeValue: string): Promise<string> {
    try {
      const isObjectId = /^[a-fA-F0-9]{24}$/.test(communeValue);

      const query: Record<string, unknown> = { wilaya_code: wilayaCode };
      if (isObjectId) {
        query._id = communeValue;
      } else {
        query.post_code = communeValue;
      }

      const commune = await this.communeModel.findOne(query).exec();
      if (commune) {
        return commune.name;
      }
    } catch (err) {
      this.logger.warn(`Failed to lookup commune ${communeValue}: ${err instanceof Error ? err.message : ''}`);
    }

    this.logger.warn(`Commune ${communeValue} not found in DB, sending as-is`);
    return communeValue;
  }

  private async getApiToken(vendorEmail: string): Promise<string | null> {
    try {
      const config = await this.configModel.findOne({ vendorEmail }).lean().exec();
      const rawCreds = config?.companies?.['dhd']?.credentials || {};
      const creds = decryptRecord(rawCreds, this.encryptionKey);
      return creds.apiToken || null;
    } catch {
      return null;
    }
  }

  private cleanPhone(phone: string): string {
    return phone.replace(/[^0-9]/g, '').slice(0, 10);
  }
}
