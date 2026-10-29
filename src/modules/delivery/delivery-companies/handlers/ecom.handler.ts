import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../../../common/errors/app-exception';
import { AppErrorCode } from '../../../../common/errors/error-codes.enum';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  BulkOrderResult,
  DeliveryCompanyHandler,
  DeliveryStatusContext,
  DeliveryStatusEntry,
  DeliveryStatusParcel,
  DeliveryStatusSearchResult,
  DeliveryLabelContext,
  DeliveryLabelDocument,
  DeliveryLabelFailure,
  DeliveryLabelOrder,
  DeliveryLabelResult,
  OrderLabelFormat,
} from '../interfaces/delivery-company-handler.interface';
import { DeliveryConfig, DeliveryConfigDocument } from '../../schemas/delivery-config.schema';
import { Commune, CommuneDocument } from '../../../territories/schemas/commune.schema';
import { Order } from '../../../orders/schemas/order.schema';
import { decryptRecord } from '../../../../common/encryption.util';
import { fetchWithRetry } from '../../../../common/fetch-with-retry';
import { isPdf, mapWithConcurrency, parseRetryAfter } from './order-label.util';
import type { SignalOverrides, StateOverrides } from '../../delivery-status/carrier/carrier-signal';
import {
  MappedEcomHistoryEntry,
  MappedEcomParcel,
  mapEcomHistoryEntries,
  mapEcomParcel,
} from './ecom/ecom-status.mapper';
import type {
  EcomHistoryResponseDto,
  EcomStatusResponseDto,
} from './ecom/ecom-status.types';

const ECOM_STATUS_BREAKER_PREFIX = 'ecom-status:';
const ECOM_STATUS_TIMEOUT_MS = 15000;
const ECOM_STATUS_BATCH_SIZE = 100;
const ECOM_HISTORY_BATCH_SIZE = 40;

const ECOM_LABEL_BREAKER_PREFIX = 'ecom-labels:';
const ECOM_LABEL_TIMEOUT_MS = 15000;
const ECOM_LABEL_MAX_BYTES = 5 * 1024 * 1024;
const ECOM_LABEL_BATCH_SIZE = 100;
const ECOM_LABEL_CONCURRENCY = 5;

interface EcomLabelFile {
  bytes: Buffer;
  contentType: 'text/html' | 'application/pdf';
}

interface EcomParcelPayload {
  nom_complet: string;
  mobile_1: string;
  id_wilaya: number;
  commune?: string;
  code_stopdesk?: string;
  article: string;
  mobile_2?: string;
  adresse?: string;
  quantite?: number;
  total?: number;
  stopdesk?: number;
  note_fournisseur?: string;
  id_externe?: string;
}

interface EcomResultItem {
  index: number;
  ok: boolean;
  tracking: string | null;
  id_colis: number | null;
  tarif_si_livrer: number | null;
  tarif_si_annuler: number | null;
  erreur: string | null;
}

interface EcomCreateResponse {
  total: number;
  crees: number;
  echecs: number;
  resultats: EcomResultItem[];
}

interface EcomStatusCredentials {
  apiKey: string;
  apiToken: string;
  tenantId: string;
  overrides: StateOverrides | null;
  signalOverrides: SignalOverrides | null;
}

@Injectable()
export class EcomHandler implements DeliveryCompanyHandler {
  readonly companyId = 'ecom-delivery';
  private readonly apiBase = 'https://ecom-dz.com/api_v2';
  private readonly logger = new Logger(EcomHandler.name);

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
      : ECOM_LABEL_CONCURRENCY;
  }

  async createOrder(order: Order): Promise<{ parcelId: string }> {
    const results = await this.createBulkOrders([order]);
    if (results[0]?.success && results[0].parcelId) {
      return { parcelId: results[0].parcelId };
    }
    throw new AppException(AppErrorCode.DELIVERY_API_ERROR, { company: 'Ecom', orderNo: order.orderNo, error: results[0]?.error || 'Unknown error' });
  }

  async createBulkOrders(orders: Order[]): Promise<BulkOrderResult[]> {
    if (orders.length === 0) return [];
    if (orders.length > 100) {
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: 'Max 100 orders per bulk request' }));
    }

    const storeIds = new Set(
      orders
        .map((order) =>
          order.storeId
            ? `store:${String(order.storeId)}`
            : order.vendorEmail
              ? `email:${order.vendorEmail}`
              : '',
        )
        .filter(Boolean),
    );
    if (storeIds.size > 1) {
      return orders.map((o) => ({
        orderNo: o.orderNo,
        success: false,
        error: 'Ecom bulk requests cannot mix stores',
      }));
    }

    const config = await this.findStatusConfig({
      storeId: orders[0].storeId ? String(orders[0].storeId) : null,
      vendorEmail: orders[0].vendorEmail ?? null,
    });
    const rawCreds = config?.companies?.['ecom-delivery']?.credentials || {};
    const creds = decryptRecord(rawCreds, this.encryptionKey);
    const apiKey: string | undefined = creds.key;
    const apiToken: string | undefined = creds.token;

    if (!apiKey || !apiToken) {
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: 'Ecom Delivery credentials not configured' }));
    }

    const parcels: EcomParcelPayload[] = [];
    for (const order of orders) {
      const communeName = await this.resolveCommuneName(order.customer.wilaya, order.customer.commune);
      const payload = this.buildPayload(order, communeName);
      parcels.push(payload);
    }

    try {
      this.logger.log(`Ecom payload for ${orders.length} orders: ${JSON.stringify(parcels).slice(0, 500)}...`);

      const response = await fetchWithRetry(
        `${this.apiBase}/colis`,
        {
          method: 'POST',
          headers: {
            'X-API-Key': apiKey,
            'X-API-Token': apiToken,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(parcels),
          timeout: 15000,
        },
        {
          circuitBreakerName: 'ecom',
          onRetry: (attempt, err) => this.logger.warn(`Ecom create orders retry ${attempt}: ${err instanceof Error ? err.message : 'HTTP ' + err.status}`),
        },
      );

      const responseText = await response.text();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(responseText);
      } catch {
        body = { raw: responseText };
      }

      this.logger.log(`Ecom response (${response.status}): ${JSON.stringify(body).slice(0, 500)}`);

      if (!response.ok) {
        const errorMsg = body?.error ? (typeof body.error === 'object' ? (body.error as Record<string, unknown>).message || JSON.stringify(body.error) : String(body.error)) : `HTTP ${response.status}`;
        return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: `Ecom API error: ${errorMsg}` }));
      }

      const resultats = (body as unknown as EcomCreateResponse).resultats;
      if (!resultats || !Array.isArray(resultats)) {
        return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: 'Unexpected Ecom API response format' }));
      }

      const results: BulkOrderResult[] = [];
      for (const r of resultats) {
        const order = orders[r.index];
        if (order) {
          if (r.ok && r.tracking) {
            results.push({ orderNo: order.orderNo, success: true, parcelId: r.tracking });
          } else {
            results.push({ orderNo: order.orderNo, success: false, error: r.erreur || 'Unknown error' });
          }
        }
      }

      const returnedOrderNos = new Set(results.map((r) => r.orderNo));
      for (const order of orders) {
        if (!returnedOrderNos.has(order.orderNo)) {
          results.push({ orderNo: order.orderNo, success: false, error: 'Order not included in API response' });
        }
      }

      return results;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Ecom API call failed: ${message}`);
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: message }));
    }
  }

  /* ------------------------------------------------------------------ *
   * Carrier label capability (L1)
   *
   * Ecom's single endpoint is authoritative and maps one response to one order. The bulk
   * endpoint is used only for `native`, where the whole multi-page document is passed through;
   * page order is still unverified live, so composed layouts stay on the single endpoint.
   * ------------------------------------------------------------------ */

  async createLabels(
    orders: DeliveryLabelOrder[],
    context: DeliveryLabelContext,
  ): Promise<DeliveryLabelResult> {
    const documents: DeliveryLabelDocument[] = [];
    const failures: DeliveryLabelFailure[] = [];

    for (const order of orders) {
      if (!String(order.trackingNumber ?? order.parcelId ?? '').trim()) {
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

    const printable = orders.filter((order) =>
      String(order.trackingNumber ?? order.parcelId ?? '').trim(),
    );
    if (printable.length === 0) return { documents, failures };

    let credentials: EcomStatusCredentials;
    try {
      credentials = await this.resolveStatusCredentials({
        storeId: context.storeId,
        vendorEmail: context.vendorEmail ?? null,
      });
    } catch (err) {
      const message =
        err instanceof AppException && err.errorCode === AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED
          ? 'Ecom Delivery credentials are not configured for this store.'
          : 'Ecom Delivery could not authenticate the label request.';
      for (const order of printable) {
        failures.push(this.labelFailure(order, 'ORDER_LABEL_CARRIER_FAILED', message, false));
      }
      return { documents, failures };
    }

    if (context.format === 'native' && printable.length > 1) {
      try {
        const bulk = await this.createNativeBulk(printable, credentials, context);
        if (bulk) return { documents: [bulk], failures };
      } catch {
        // Fall through to the single endpoint: a bulk failure must not fail the whole batch.
      }
    }

    const results = await mapWithConcurrency(printable, this.labelConcurrency(), async (order) => {
      try {
        const tracking = String(order.trackingNumber ?? order.parcelId);
        const file = await this.downloadEcomLabel(tracking, context.format, credentials, context.timeoutMs);
        return {
          document: {
            orderNo: order.orderNo,
            trackingNumber: tracking,
            contentType: file.contentType,
            bytes: file.bytes,
            widthMm: 100,
            heightMm: this.labelFormatFor(context.format) === '10x10' ? 100 : 130,
          } satisfies DeliveryLabelDocument,
          failure: null,
        };
      } catch (err) {
        return {
          document: null,
          failure: this.labelFailure(
            order,
            this.ecomLabelErrorCode(err),
            this.ecomLabelErrorMessage(err),
            this.isRetryableEcomLabelError(err),
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

  private async createNativeBulk(
    orders: DeliveryLabelOrder[],
    credentials: EcomStatusCredentials,
    context: DeliveryLabelContext,
  ): Promise<DeliveryLabelDocument | null> {
    if (orders.length > ECOM_LABEL_BATCH_SIZE) return null;

    const trackings = orders.map((order) => String(order.trackingNumber ?? order.parcelId));
    const response = await fetchWithRetry(
      `${this.labelApiBase()}/colis/bordereaux`,
      {
        method: 'POST',
        headers: this.labelHeaders(credentials, 'application/pdf, text/html, */*', true),
        body: JSON.stringify({ trackings, format: this.labelFormatFor(context.format) }),
        timeout: Math.min(context.timeoutMs, ECOM_LABEL_TIMEOUT_MS),
      },
      {
        maxRetries: 2,
        circuitBreakerName: `${ECOM_LABEL_BREAKER_PREFIX}${credentials.tenantId}`,
      },
    );

    if (!response.ok) return null;

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > ECOM_LABEL_MAX_BYTES) {
      throw new AppException(AppErrorCode.ORDER_LABEL_RENDER_FAILED, {
        company: 'Ecom Delivery',
      });
    }

    return {
      orderNo: orders[0].orderNo,
      orderNos: orders.map((order) => order.orderNo),
      trackingNumber: trackings[0],
      trackingNumbers: trackings,
      contentType: isPdf(bytes) ? 'application/pdf' : 'text/html',
      bytes,
      sheet: true,
    };
  }

  private async downloadEcomLabel(
    tracking: string,
    format: OrderLabelFormat,
    credentials: EcomStatusCredentials,
    timeoutMs: number,
  ): Promise<EcomLabelFile> {
    const labelFormat = this.labelFormatFor(format);
    const url = `${this.labelApiBase()}/colis/${encodeURIComponent(tracking)}/bordereau?format=${labelFormat}`;

    let response: Response;
    try {
      response = await fetchWithRetry(
        url,
        {
          method: 'GET',
          headers: this.labelHeaders(credentials, 'application/pdf, text/html, */*'),
          timeout: Math.min(timeoutMs || ECOM_LABEL_TIMEOUT_MS, ECOM_LABEL_TIMEOUT_MS),
        },
        {
          maxRetries: 2,
          circuitBreakerName: `${ECOM_LABEL_BREAKER_PREFIX}${credentials.tenantId}`,
        },
      );
    } catch (err) {
      throw new AppException(AppErrorCode.DELIVERY_API_TIMEOUT, {
        company: 'Ecom Delivery',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new AppException(AppErrorCode.ORDER_LABEL_NOT_FOUND_AT_CARRIER, {
          company: 'Ecom Delivery',
        });
      }
      if (response.status === 422) {
        throw new AppException(AppErrorCode.ORDER_LABEL_LAYOUT_UNSUPPORTED, {
          company: 'Ecom Delivery',
        });
      }
      if (response.status === 429) {
        throw new AppException(AppErrorCode.DELIVERY_API_RATE_LIMITED, {
          company: 'Ecom Delivery',
          retryAfterSeconds: parseRetryAfter(response),
        });
      }
      if (response.status === 401 || response.status === 403) {
        throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, {
          company: 'Ecom Delivery',
        });
      }
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, {
        company: 'Ecom Delivery',
        status: response.status,
      });
    }

    const declared = Number.parseInt(response.headers.get('content-length') || '', 10);
    if (Number.isFinite(declared) && declared > ECOM_LABEL_MAX_BYTES) {
      throw new AppException(AppErrorCode.ORDER_LABEL_RENDER_FAILED, {
        company: 'Ecom Delivery',
        message: 'The carrier label file is too large.',
      });
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > ECOM_LABEL_MAX_BYTES) {
      throw new AppException(AppErrorCode.ORDER_LABEL_RENDER_FAILED, {
        company: 'Ecom Delivery',
      });
    }

    return { bytes, contentType: isPdf(bytes) ? 'application/pdf' : 'text/html' };
  }

  private labelFormatFor(format: OrderLabelFormat): '10x10' | '10x13' {
    return format === '10x10' ? '10x10' : '10x13';
  }

  private labelApiBase(): string {
    const configured = this.configService.get<string>('orderLabels.ecomLabelApiBase');
    return (configured || 'https://ecom-dz.com/api_v2').replace(/\/+$/, '');
  }

  private labelFailure(
    order: DeliveryLabelOrder,
    code: string,
    message: string,
    retryable: boolean,
  ): DeliveryLabelFailure {
    return {
      orderNo: order.orderNo,
      trackingNumber: order.trackingNumber ?? order.parcelId ?? null,
      code,
      message,
      retryable,
    };
  }

  private ecomLabelErrorCode(err: unknown): string {
    if (err instanceof AppException) {
      if (err.errorCode === AppErrorCode.ORDER_LABEL_NOT_FOUND_AT_CARRIER) {
        return 'ORDER_LABEL_NOT_FOUND_AT_CARRIER';
      }
      if (err.errorCode === AppErrorCode.ORDER_LABEL_LAYOUT_UNSUPPORTED) {
        return 'ORDER_LABEL_LAYOUT_UNSUPPORTED';
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

  private ecomLabelErrorMessage(err: unknown): string {
    if (err instanceof AppException) {
      if (err.errorCode === AppErrorCode.ORDER_LABEL_NOT_FOUND_AT_CARRIER) {
        return 'The carrier could not find this parcel.';
      }
      if (err.errorCode === AppErrorCode.ORDER_LABEL_LAYOUT_UNSUPPORTED) {
        return 'The carrier rejected the requested label format.';
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
        return 'Ecom Delivery credentials are not configured for this store.';
      }
    }
    return 'The carrier could not generate the label.';
  }

  private isRetryableEcomLabelError(err: unknown): boolean {
    if (!(err instanceof AppException)) return true;
    return ![
      AppErrorCode.ORDER_LABEL_NOT_FOUND_AT_CARRIER,
      AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED,
      AppErrorCode.ORDER_LABEL_LAYOUT_UNSUPPORTED,
    ].includes(err.errorCode as never);
  }

  async searchStatusParcels(
    context: DeliveryStatusContext,
  ): Promise<DeliveryStatusSearchResult> {
    const credentials = await this.resolveStatusCredentials(context);
    const parcelIds = this.uniqueIds(context.parcelIds);
    const externalIds = this.uniqueIds(context.externalIds);

    if (parcelIds.length === 0 && externalIds.length === 0) {
      return { parcels: [], totalCount: 0, hasNext: false };
    }

    const parcels: DeliveryStatusParcel[] = [];
    const found = new Set<string>();
    const missingParcelIds: string[] = [];

    for (const chunk of this.chunks(parcelIds, ECOM_STATUS_BATCH_SIZE)) {
      const body = await this.postStatusJson('/colis/statuts', { trackings: chunk }, credentials);
      for (const dto of body?.trackings ?? []) {
        if (dto?.trouve === false) continue;
        const mapped = mapEcomParcel(dto, credentials.overrides);
        if (!mapped.parcelId) continue;
        parcels.push(this.toStatusParcel(mapped));
        found.add(mapped.parcelId);
      }
      for (const id of chunk) {
        if (!found.has(id)) missingParcelIds.push(id);
      }
    }

    for (const chunk of this.chunks(externalIds, ECOM_STATUS_BATCH_SIZE)) {
      const body = await this.postStatusJson(
        '/colis/statuts',
        { id_externes: chunk },
        credentials,
      );
      for (const result of body?.id_externes ?? []) {
        for (const dto of result?.colis ?? []) {
          if (dto?.trouve === false) continue;
          const mapped = mapEcomParcel(dto, credentials.overrides);
          if (!mapped.parcelId) continue;
          parcels.push(this.toStatusParcel(mapped));
          found.add(mapped.parcelId);
        }
      }
    }

    return {
      parcels,
      totalCount: parcels.length,
      hasNext: false,
      missingParcelIds,
    };
  }

  async fetchStatusHistory(
    context: DeliveryStatusContext,
    parcelId: string,
  ): Promise<DeliveryStatusEntry[]> {
    if (!parcelId) {
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, {
        company: 'Ecom Delivery',
        message: 'parcelId is required',
      });
    }
    const histories = await this.fetchStatusHistories(context, [parcelId]);
    return histories[parcelId] ?? [];
  }

  async fetchStatusHistories(
    context: DeliveryStatusContext,
    parcelIds: string[],
  ): Promise<Record<string, DeliveryStatusEntry[]>> {
    const credentials = await this.resolveStatusCredentials(context);
    const requested = this.uniqueIds(parcelIds);
    const result: Record<string, DeliveryStatusEntry[]> = {};
    for (const id of requested) result[id] = [];

    for (const chunk of this.chunks(requested, ECOM_HISTORY_BATCH_SIZE)) {
      const body = await this.postStatusJson(
        '/colis/historique',
        { trackings: chunk },
        credentials,
      );
      for (const entry of body?.resultats ?? []) {
        const tracking = entry?.tracking ? String(entry.tracking) : null;
        if (!tracking || !(tracking in result)) continue;
        if (entry.trouve === false) continue;
        result[tracking] = mapEcomHistoryEntries(
          tracking,
          entry.historique ?? [],
          credentials.overrides,
        ).map((mapped) => this.toStatusEntry(mapped));
      }
    }

    return result;
  }

  async resolveStatusTenant(context: DeliveryStatusContext): Promise<string | null> {
    try {
      const credentials = await this.resolveStatusCredentials(context);
      return credentials.tenantId || null;
    } catch {
      return null;
    }
  }

  private async postStatusJson(
    path: string,
    payload: Record<string, unknown>,
    credentials: EcomStatusCredentials,
  ): Promise<EcomStatusResponseDto & EcomHistoryResponseDto> {
    try {
      const response = await fetchWithRetry(
        `${this.apiBase}${path}`,
        {
          method: 'POST',
          headers: this.statusHeaders(credentials),
          body: JSON.stringify(payload),
          timeout: ECOM_STATUS_TIMEOUT_MS,
        },
        {
          circuitBreakerName: `${ECOM_STATUS_BREAKER_PREFIX}${credentials.tenantId}`,
          onRetry: (attempt, err) =>
            this.logger.warn(
              `Ecom status call failed (attempt ${attempt}): ${
                err instanceof Error ? err.message : `HTTP ${err.status}`
              }`,
            ),
        },
      );

      if (response.ok) {
        return ((await this.readStatusJson(response)) ?? {}) as EcomStatusResponseDto &
          EcomHistoryResponseDto;
      }

      if (response.status === 429) {
        const retryAfterHeader = response.headers?.get?.('retry-after');
        const retryAfterSeconds = Number.parseInt(retryAfterHeader ?? '', 10);
        throw new AppException(AppErrorCode.DELIVERY_API_RATE_LIMITED, {
          company: 'Ecom Delivery',
          status: response.status,
          retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
        });
      }

      const body = await response.text().catch(() => '');
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, {
        company: 'Ecom Delivery',
        status: response.status,
        body: body.slice(0, 500),
      });
    } catch (err) {
      if (err instanceof AppException) throw err;
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (/timed out|timeout/i.test(message)) {
        throw new AppException(AppErrorCode.DELIVERY_API_TIMEOUT, {
          company: 'Ecom Delivery',
          message,
        });
      }
      throw new AppException(AppErrorCode.DELIVERY_UNKNOWN_ERROR, {
        company: 'Ecom Delivery',
        message,
      });
    }
  }

  private async readStatusJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private statusHeaders(credentials: EcomStatusCredentials): Record<string, string> {
    return {
      'X-API-Key': credentials.apiKey,
      'X-API-Token': credentials.apiToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /** Label endpoints return HTML or PDF, so they must not inherit the status `Accept`. */
  private labelHeaders(
    credentials: EcomStatusCredentials,
    accept: string,
    jsonBody = false,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'X-API-Key': credentials.apiKey,
      'X-API-Token': credentials.apiToken,
      Accept: accept,
    };
    if (jsonBody) headers['Content-Type'] = 'application/json';
    return headers;
  }

  /**
   * Resolves the store's delivery configuration, **store-first**.
   *
   * `storeId` is the canonical seller identity and is queried first. `vendorEmail` is accepted
   * only as a read fallback for rows written before the store-id migration, and only when the
   * `storeId` query missed.
   */
  private async findStatusConfig(context: DeliveryStatusContext): Promise<DeliveryConfig | null> {
    if (context.storeId && Types.ObjectId.isValid(context.storeId)) {
      const byStore = await this.configModel
        .findOne({ storeId: new Types.ObjectId(context.storeId) })
        .lean()
        .exec();
      if (byStore) return this.guardStatusConfig(byStore as DeliveryConfig, context);
    }

    if (context.vendorEmail) {
      const byEmail = await this.configModel
        .findOne({ vendorEmail: context.vendorEmail })
        .lean()
        .exec();
      if (!byEmail) return null;
      return this.guardStatusConfig(byEmail as DeliveryConfig, context);
    }

    return null;
  }

  private guardStatusConfig(
    config: DeliveryConfig,
    context: DeliveryStatusContext,
  ): DeliveryConfig | null {
    if (context.storeId && config.storeId && String(config.storeId) !== String(context.storeId)) {
      return null;
    }
    return config;
  }

  private async resolveStatusCredentials(
    context: DeliveryStatusContext,
  ): Promise<EcomStatusCredentials> {
    const config = await this.findStatusConfig(context);
    const company = config?.companies?.['ecom-delivery'];

    if (!config || !company || company.status === 'disabled') {
      throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, {
        company: 'Ecom Delivery',
        storeId: context.storeId ?? null,
        vendorEmail: context.vendorEmail ?? null,
      });
    }

    const credentials = decryptRecord(company.credentials || {}, this.encryptionKey);
    const apiKey = typeof credentials.key === 'string' ? credentials.key : '';
    const apiToken = typeof credentials.token === 'string' ? credentials.token : '';
    if (!apiKey || !apiToken) {
      throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, {
        company: 'Ecom Delivery',
        storeId: context.storeId ?? null,
        vendorEmail: context.vendorEmail ?? null,
      });
    }

    return {
      apiKey,
      apiToken,
      tenantId: createHash('sha256').update(`${apiKey}:${apiToken}`).digest('hex').slice(0, 16),
      overrides: config.statusStateOverrides?.['ecom-delivery'] ?? null,
      signalOverrides: config.statusSignalOverrides?.['ecom-delivery'] ?? null,
    };
  }

  private toStatusParcel(mapped: MappedEcomParcel): DeliveryStatusParcel {
    const situation = mapped.rawSituation
      ? {
          slug: mapped.rawSituation.situation
            ? String(mapped.rawSituation.situation).trim().toLowerCase() || null
            : null,
          name: mapped.rawSituation.situation
            ? String(mapped.rawSituation.situation)
            : null,
          description: mapped.rawSituation.etat_logistique
            ? String(mapped.rawSituation.etat_logistique)
            : null,
          flags: mapped.situationFlags,
        }
      : null;

    return {
      parcelId: mapped.parcelId,
      externalId: mapped.externalId,
      trackingNumber: mapped.trackingNumber,
      deliveryStatus: mapped.deliveryStatus,
      carrierStateId: mapped.carrierStateId,
      carrierStateName: mapped.carrierStateName,
      carrierStateDescription: mapped.carrierStateDescription,
      carrierStateRank: mapped.carrierStateRank,
      carrierStateLocked: mapped.carrierStateLocked,
      terminal: mapped.terminal,
      situationFlags: mapped.situationFlags,
      lastStateUpdateAt: mapped.lastStateUpdateAt,
      deliveryType: mapped.deliveryType,
      situation,
      rawSituation: mapped.rawSituation,
      raw: mapped.raw,
    };
  }

  private toStatusEntry(mapped: MappedEcomHistoryEntry): DeliveryStatusEntry {
    return {
      providerEntryId: mapped.providerEntryId,
      parcelId: mapped.parcelId,
      fromState: mapped.fromState,
      toState: mapped.toState,
      fromStatus: mapped.fromStatus,
      toStatus: mapped.toStatus,
      at: mapped.at,
      comment: mapped.comment,
      hubName: mapped.hubName,
      hubCity: mapped.hubCity,
      hubDistrict: mapped.hubDistrict,
      modifiedBy: mapped.modifiedBy,
      situationFlags: mapped.situations[0]?.flags ?? [],
      situations: mapped.situations.map((situation) => ({
        slug: situation.slug,
        name: situation.name,
        description: situation.description,
        flags: situation.flags,
      })),
      raw: mapped.raw,
    };
  }

  private uniqueIds(ids: readonly string[] | null | undefined): string[] {
    if (!ids) return [];
    return [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
  }

  private chunks<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  }

  private buildPayload(order: Order, communeName: string): EcomParcelPayload {
    const isStopDesk = order.shippingMethod === 'stopdesk';

    const article =
      order.items
        ?.map((item) => item.productName || `Product ${item.productId || ''}`)
        .filter(Boolean)
        .join(', ')
        .slice(0, 255) || `Order ${order.orderNo}`;

    const customerName = order.customer.name || 'Client';
    if (customerName.length > 20) {
      this.logger.warn(`Truncated customer name for order ${order.orderNo}: "${customerName}" (${customerName.length} chars → 20)`);
    }

    const payload: EcomParcelPayload = {
      nom_complet: customerName.slice(0, 20),
      mobile_1: this.cleanPhone(order.customer.phone || ''),
      id_wilaya: parseInt(order.customer.wilaya, 10) || 0,
      article,
      total: order.total || 0,
      id_externe: order.orderNo.slice(0, 20),
    };

    if (isStopDesk) {
      payload.stopdesk = 1;
      if (order.stopDeskCode) {
        if (order.stopDeskCode.length > 10) {
          this.logger.warn(`Truncated stopDeskCode for order ${order.orderNo}: "${order.stopDeskCode}" (${order.stopDeskCode.length} chars → 10)`);
        }
        payload.code_stopdesk = order.stopDeskCode.slice(0, 10);
      }
    } else {
      payload.stopdesk = 0;
      payload.commune = communeName;
    }

    if (order.customer.address) {
      if (order.customer.address.length > 30) {
        this.logger.warn(`Truncated address for order ${order.orderNo}: "${order.customer.address}" (${order.customer.address.length} chars → 30)`);
      }
      payload.adresse = order.customer.address.slice(0, 30);
    }

    if (order.customer.email) {
      payload.mobile_2 = this.cleanPhone(order.customer.email);
    }

    if (order.customer.note) {
      payload.note_fournisseur = order.customer.note.slice(0, 255);
    }

    const totalQty = order.items?.reduce((sum, item) => sum + (item.quantity || 1), 0) || 1;
    if (totalQty > 1) {
      payload.quantite = totalQty;
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

      if (commune?.ecomdelivery_uuid) {
        this.logger.log(`Resolved commune "${communeValue}" → ecom name "${commune.ecomdelivery_uuid}"`);
        return commune.ecomdelivery_uuid;
      }

      if (commune) {
        this.logger.warn(`Commune ${communeValue} found but no ecomdelivery_uuid set, falling back to DB name "${commune.name}"`);
        return commune.name;
      }
    } catch (err) {
      this.logger.warn(`Failed to lookup commune ${communeValue}: ${err instanceof Error ? err.message : ''}`);
    }

    this.logger.warn(`Commune ${communeValue} not found in DB, sending as-is`);
    return communeValue;
  }

  private cleanPhone(phone: string): string {
    return phone.replace(/[^0-9]/g, '').slice(0, 10);
  }
}
