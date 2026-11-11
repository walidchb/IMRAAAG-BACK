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
  DeliveryLabelPreparation,
  DeliveryLabelPreparationContext,
  DeliveryLabelResult,
} from '../interfaces/delivery-company-handler.interface';
import { DeliveryConfig, DeliveryConfigDocument } from '../../schemas/delivery-config.schema';
import { Wilaya, WilayaDocument } from '../../../territories/schemas/wilaya.schema';
import { Commune, CommuneDocument } from '../../../territories/schemas/commune.schema';
import { Order } from '../../../orders/schemas/order.schema';
import { decryptRecord } from '../../../../common/encryption.util';
import { fetchWithRetry } from '../../../../common/fetch-with-retry';
import { describeOrderItem } from './order-item-description';
import {
  mapHistoryEntry,
  mapParcel,
  flagsForSituations,
  SignalOverrides,
  StateOverrides,
} from './zr-express/zr-status.mapper';
import {
  ZrParcelDto,
  ZrSearchParcelsRequest,
  ZrSearchParcelsResponse,
  ZrStateHistoryEntryDto,
} from './zr-express/zr-status.types';

interface ZrCreateParcelPayload {
  customer: {
    customerId: string;
    name: string;
    phone: { number1: string };
  };
  deliveryAddress: {
    cityTerritoryId: string;
    districtTerritoryId: string;
    street?: string;
  };
  orderedProducts: Array<{
    productId: string;
    productName: string;
    productSku: string;
    unitPrice: number;
    quantity: number;
    stockType: string;
  }>;
  amount: number;
  description: string;
  deliveryType: string;
  weight?: { weight: number };
  externalId?: string;
  hubId?: string;
}

/** The circuit-breaker namespace for the status sync. One breaker per tenant. */
const ZR_STATUS_BREAKER_PREFIX = 'zr-express-status:';
/** The status endpoints get a shorter budget than parcel creation — they are polled. */
const ZR_STATUS_TIMEOUT_MS = 15000;
/** How many parcels a discovery call asks for. */
const ZR_STATUS_DEFAULT_PAGE_SIZE = 20;

/** Label endpoints are deliberately separate from the status/creation namespace. */
const ZR_LABEL_BREAKER_PREFIX = 'zr-express-labels:';
const ZR_LABEL_TIMEOUT_MS = 15000;
const ZR_LABEL_MAX_BYTES = 5 * 1024 * 1024;
const ZR_LABEL_INDIVIDUAL_CHUNK = 50;
const ZR_LABEL_MULTIPLE_LIMIT = 250;

/**
 * Provisional crop of one label from ZR's A4 individual sheet.
 *
 * ZR's individual endpoint repeats the same label four times on A4. The documented label size is
 * 10 x 14.85 cm, so the top-left A4 quadrant is used until L0 captures a real sheet and confirms
 * whether the page has margins. The box is in PDF points from the bottom-left.
 */
const ZR_INDIVIDUAL_CROP = {
  x: 0,
  y: (297 - 148.5) * (72 / 25.4),
  width: 105 * (72 / 25.4),
  height: 148.5 * (72 / 25.4),
};

interface ZrLabelFile {
  trackingNumber?: string;
  fileUrl?: string;
  url?: string;
  file?: string;
}

interface ZrMultipleLabelResponse {
  fileUrl?: string | null;
  url?: string | null;
  labelFileUrl?: string | null;
  failedTrackingNumbers?: unknown[];
}

interface ZrIndividualLabelResponse {
  parcelLabelFiles?: ZrLabelFile[];
  labelFiles?: ZrLabelFile[];
  files?: ZrLabelFile[];
  failedTrackingNumbers?: unknown[];
}

/** True when the value looks like a MongoDB ObjectId hex string. */
function isObjectIdLike(value: string): boolean {
  return /^[a-fA-F0-9]{24}$/.test(value);
}

@Injectable()
export class ZrExpressHandler implements DeliveryCompanyHandler {
  readonly companyId = 'zr-express';
  private readonly apiBase = 'https://api.zrexpress.app/api/v1.0';
  private readonly logger = new Logger(ZrExpressHandler.name);

  constructor(
    @InjectModel(DeliveryConfig.name)
    private configModel: Model<DeliveryConfigDocument>,
    @InjectModel(Wilaya.name)
    private wilayaModel: Model<WilayaDocument>,
    @InjectModel(Commune.name)
    private communeModel: Model<CommuneDocument>,
    private readonly configService: ConfigService,
  ) {}

  private get encryptionKey(): string {
    return this.configService.get<string>('deliveryEncryptionKey') || '';
  }

  async createOrder(order: Order): Promise<{ parcelId: string }> {
    const config = await this.configModel.findOne({ vendorEmail: order.vendorEmail }).exec();
    const { apiKey, tenantId } = this.getCredentials(config);

    if (!apiKey || !tenantId) {
      throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, { company: 'ZR Express', vendor: order.vendorEmail });
    }

    const cityTerritoryId = await this.resolveCityTerritoryId(order.customer.wilaya);
    if (!cityTerritoryId) {
      throw new AppException(AppErrorCode.DELIVERY_TERRITORY_NOT_SYNCED, { type: 'wilaya', code: order.customer.wilaya, company: 'ZR Express' });
    }

    const districtTerritoryId = await this.resolveDistrictTerritoryId(order.customer.wilaya, order.customer.commune);
    if (!districtTerritoryId) {
      throw new AppException(AppErrorCode.DELIVERY_TERRITORY_NOT_SYNCED, { type: 'commune', code: order.customer.commune, company: 'ZR Express' });
    }

    const payload = await this.buildZrPayload(order, cityTerritoryId, districtTerritoryId);

    try {
      this.logger.log(`ZR Express request for ${order.orderNo}: POST ${this.apiBase}/parcels`);
      this.logger.log(`ZR Express payload for ${order.orderNo}: ${JSON.stringify(payload)}`);
      this.logger.log(`ZR Express headers: X-Tenant=${tenantId}, X-Api-Key=${apiKey.slice(0, 8)}...`);

      const response = await fetchWithRetry(
        `${this.apiBase}/parcels`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Tenant': tenantId,
            'X-Api-Key': apiKey,
          },
          body: JSON.stringify(payload),
          timeout: 10000,
        },
        {
          circuitBreakerName: 'zr-express',
          onRetry: (attempt, err) => this.logger.warn(`ZR create order retry ${attempt}: ${err instanceof Error ? err.message : 'HTTP ' + err.status}`),
        },
      );

      const responseStatus = response.status;
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        responseHeaders[k] = v;
      });
      this.logger.log(`ZR Express response status: ${responseStatus}`);
      this.logger.log(`ZR Express response headers: ${JSON.stringify(responseHeaders)}`);

      const errorBody = await response.text();
      this.logger.log(`ZR Express response body for ${order.orderNo}: ${errorBody}`);

      if (!response.ok) {
        this.logger.error(`ZR Express API error (${responseStatus}): ${errorBody}`);
        throw new AppException(AppErrorCode.DELIVERY_API_ERROR, { company: 'ZR Express', status: responseStatus, text: errorBody });
      }

      let result: { id: string };
      try {
        result = JSON.parse(errorBody) as { id: string };
      } catch {
        this.logger.error(`ZR Express response for ${order.orderNo} is not valid JSON: ${errorBody}`);
        throw new AppException(AppErrorCode.DELIVERY_API_ERROR, { company: 'ZR Express', status: responseStatus, text: 'Invalid JSON response' });
      }

      this.logger.log(`ZR Express parcel created: ${result.id} for order ${order.orderNo}`);
      return { parcelId: result.id };
    } catch (err) {
      if (err instanceof AppException) throw err;
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`ZR Express API call failed for order ${order.orderNo}: ${message}`);
      throw new AppException(AppErrorCode.DELIVERY_UNKNOWN_ERROR, { company: 'ZR Express', orderNo: order.orderNo, message });
    }
  }

  async createBulkOrders(orders: Order[]): Promise<BulkOrderResult[]> {
    if (orders.length === 0) return [];
    if (orders.length > 100) {
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: 'Max 100 orders per bulk request' }));
    }

    const config = await this.configModel.findOne({ vendorEmail: orders[0].vendorEmail }).exec();
    const { apiKey, tenantId } = this.getCredentials(config);

    if (!apiKey || !tenantId) {
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: 'ZR Express credentials not configured' }));
    }

    const parcels: ZrCreateParcelPayload[] = [];
    for (const order of orders) {
      const cityTerritoryId = await this.resolveCityTerritoryId(order.customer.wilaya);
      const districtTerritoryId = await this.resolveDistrictTerritoryId(order.customer.wilaya, order.customer.commune);
      if (!cityTerritoryId || !districtTerritoryId) {
        return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: `Territory IDs not resolved. Run territory sync first.` }));
      }
      parcels.push(await this.buildZrPayload(order, cityTerritoryId, districtTerritoryId));
    }

    try {
      this.logger.log(`ZR Express bulk request: POST ${this.apiBase}/parcels/bulk for ${orders.length} orders`);
      this.logger.log(`ZR Express bulk headers: X-Tenant=${tenantId}, X-Api-Key=${apiKey.slice(0, 8)}...`);

      const response = await fetchWithRetry(
        `${this.apiBase}/parcels/bulk`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Tenant': tenantId,
            'X-Api-Key': apiKey,
          },
          body: JSON.stringify(parcels),
          timeout: 30000,
        },
        {
          circuitBreakerName: 'zr-express',
          onRetry: (attempt, err) => this.logger.warn(`ZR bulk create retry ${attempt}: ${err instanceof Error ? err.message : 'HTTP ' + err.status}`),
        },
      );

      const responseStatus = response.status;
      const responseText = await response.text();
      this.logger.log(`ZR Express bulk response status: ${responseStatus}`);
      this.logger.log(`ZR Express bulk response body: ${responseText.slice(0, 2000)}`);

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(responseText);
      } catch {
        this.logger.error(`ZR Express bulk response is not valid JSON: ${responseText}`);
        return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: `ZR Express returned invalid JSON: ${responseText}` }));
      }

      if (!response.ok) {
        this.logger.error(`ZR Express bulk API error (${responseStatus}): ${responseText}`);
        return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: `ZR Express API returned ${responseStatus}` }));
      }

      const successes = (body as any).successes as Array<{ index: number; parcelId: string; trackingNumber: string }> | undefined;
      const failures = (body as any).failures as Array<{ index: number; errorCode: string; errorMessage: string; externalId: string }> | undefined;

      const results: BulkOrderResult[] = [];

      if (successes) {
        for (const s of successes) {
          const order = orders[s.index];
          if (order) {
            results.push({ orderNo: order.orderNo, success: true, parcelId: s.parcelId });
          }
        }
      }

      if (failures) {
        for (const f of failures) {
          const order = orders[f.index];
          if (order) {
            results.push({ orderNo: order.orderNo, success: false, error: f.errorMessage });
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
      this.logger.error(`ZR Express bulk API call failed: ${message}`);
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: message }));
    }
  }

  /* ------------------------------------------------------------------ *
   * Carrier label capability (L1)
   *
   * ZR has two label endpoints:
   *   - `multiple`   — one A4 sheet of distinct labels (fast path for native/4-up);
   *   - `individual` — one A4 sheet per tracking with the same label four times.
   *
   * The individual sheet is cropped to its top-left label before composition. SAS URLs are
   * downloaded immediately and never returned to the caller.
   * ------------------------------------------------------------------ */

  /**
   * ZR does not expose the tracking number at dispatch. Resolve the whole group through status
   * discovery so the platform's label pipeline stays carrier-neutral and needs no ZR branch.
   */
  async prepareLabels(
    orders: DeliveryLabelOrder[],
    context: DeliveryLabelPreparationContext,
  ): Promise<DeliveryLabelPreparation> {
    const result = await this.searchStatusParcels({
      storeId: context.storeId,
      vendorEmail: context.vendorEmail ?? null,
      parcelIds: [...new Set(orders.map((order) => order.parcelId))],
      limit: Math.min(100, orders.length),
    });
    const trackingByParcel = new Map(
      result.parcels.map((parcel) => [String(parcel.parcelId), parcel.trackingNumber]),
    );
    return {
      orders: orders.map((order) => ({
        ...order,
        trackingNumber: trackingByParcel.get(order.parcelId) ?? null,
      })),
    };
  }

  async createLabels(
    orders: DeliveryLabelOrder[],
    context: DeliveryLabelContext,
  ): Promise<DeliveryLabelResult> {
    const documents: DeliveryLabelDocument[] = [];
    const failures: DeliveryLabelFailure[] = [];
    const warnings: Array<{ orderNo: string; code: string; message: string }> = [];

    const withTracking = orders.filter((order) => String(order.trackingNumber ?? '').trim());
    for (const order of orders) {
      if (!String(order.trackingNumber ?? '').trim()) {
        failures.push(this.labelFailure(
          order,
          'ORDER_LABEL_TRACKING_UNAVAILABLE',
          'The carrier did not return a tracking number for this parcel.',
          true,
        ));
      }
    }

    if (withTracking.length === 0) return { documents, failures, warnings };

    let credentials: { apiKey: string; tenantId: string };
    try {
      const resolved = await this.resolveStatusCredentials({
        storeId: context.storeId,
        vendorEmail: context.vendorEmail ?? null,
      });
      credentials = { apiKey: resolved.apiKey, tenantId: resolved.tenantId };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'ZR Express credentials are not configured.';
      for (const order of withTracking) {
        failures.push(this.labelFailure(order, 'ORDER_LABEL_CARRIER_FAILED', message, false));
      }
      return { documents, failures, warnings };
    }

    if (
      context.format === 'native' ||
      (context.format === 'a4_4up' && context.allOrdersSameCarrier)
    ) {
      const sheet = await this.createMultipleSheet(withTracking, credentials, context);
      documents.push(...sheet.documents);
      failures.push(...sheet.failures);
      if (sheet.documents.length > 0) {
        warnings.push({
          orderNo: withTracking[0].orderNo,
          code: 'ORDER_LABEL_NATIVE_SHEET',
          message:
            'ZR supplied its native A4 sheet. It contains four different labels per page.',
        });
      }
      return { documents, failures, warnings };
    }

    const individual = await this.createIndividualLabels(withTracking, credentials, context);
    documents.push(...individual.documents);
    failures.push(...individual.failures);
    return { documents, failures, warnings };
  }

  private async createMultipleSheet(
    orders: DeliveryLabelOrder[],
    credentials: { apiKey: string; tenantId: string },
    context: DeliveryLabelContext,
  ): Promise<{ documents: DeliveryLabelDocument[]; failures: DeliveryLabelFailure[] }> {
    const trackings = orders
      .map((order) => String(order.trackingNumber))
      .slice(0, ZR_LABEL_MULTIPLE_LIMIT);
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const payload = (await this.requestZrLabel(
          '/parcels/labels/multiple',
          trackings,
          credentials,
          context.timeoutMs,
        )) as ZrMultipleLabelResponse;

        const failed = new Set(this.normalizeFailedTrackings(payload?.failedTrackingNumbers));
        const successful = orders.filter((order) => !failed.has(String(order.trackingNumber)));
        const fileUrl = payload?.fileUrl || payload?.labelFileUrl || payload?.url || null;

        if (!fileUrl) {
          if (attempt === 0) continue;
          return {
            documents: [],
            failures: successful.map((order) =>
              this.labelFailure(
                order,
                'ORDER_LABEL_SOURCE_EXPIRED',
                'The carrier did not return a label file.',
                true,
              ),
            ),
          };
        }

        const file = await this.downloadLabelFile(fileUrl, context.timeoutMs);
        const failures = orders
          .filter((order) => failed.has(String(order.trackingNumber)))
          .map((order) =>
            this.labelFailure(
              order,
              'ORDER_LABEL_CARRIER_FAILED',
              'The carrier could not generate this label.',
              true,
            ),
          );

        if (successful.length === 0) return { documents: [], failures };

        return {
          documents: [
            {
              orderNo: successful[0].orderNo,
              orderNos: successful.map((order) => order.orderNo),
              trackingNumber: String(successful[0].trackingNumber),
              trackingNumbers: successful.map((order) => String(order.trackingNumber)),
              contentType: file.contentType,
              bytes: file.bytes,
              sheet: true,
            },
          ],
          failures,
        };
      } catch (err) {
        lastError = err;
      }
    }

    const message = this.safeLabelError(lastError);
    return {
      documents: [],
      failures: orders.map((order) =>
        this.labelFailure(order, 'ORDER_LABEL_CARRIER_FAILED', message, this.isRetryable(lastError)),
      ),
    };
  }

  private async createIndividualLabels(
    orders: DeliveryLabelOrder[],
    credentials: { apiKey: string; tenantId: string },
    context: DeliveryLabelContext,
  ): Promise<{ documents: DeliveryLabelDocument[]; failures: DeliveryLabelFailure[] }> {
    const documents: DeliveryLabelDocument[] = [];
    const failures: DeliveryLabelFailure[] = [];
    for (let start = 0; start < orders.length; start += ZR_LABEL_INDIVIDUAL_CHUNK) {
      const chunk = orders.slice(start, start + ZR_LABEL_INDIVIDUAL_CHUNK);
      const trackings = chunk.map((order) => String(order.trackingNumber));

      try {
        let payload = (await this.requestZrLabel(
          '/parcels/labels/individual',
          trackings,
          credentials,
          context.timeoutMs,
        )) as ZrIndividualLabelResponse;

        let files = this.zrLabelFiles(payload);
        const failed = new Set(this.normalizeFailedTrackings(payload?.failedTrackingNumbers));

        for (const order of chunk) {
          const tracking = String(order.trackingNumber);
          if (failed.has(tracking)) {
            failures.push(
              this.labelFailure(
                order,
                'ORDER_LABEL_CARRIER_FAILED',
                'The carrier could not generate this label.',
                true,
              ),
            );
            continue;
          }

          const source = files.get(tracking);
          if (!source) {
            failures.push(
              this.labelFailure(
                order,
                'ORDER_LABEL_TRACKING_UNAVAILABLE',
                'The carrier did not return a label for this tracking number.',
                true,
              ),
            );
            continue;
          }

          try {
            let file = await this.downloadLabelFile(source, context.timeoutMs);
            documents.push({
              orderNo: order.orderNo,
              trackingNumber: tracking,
              contentType: file.contentType,
              bytes: file.bytes,
              widthMm: 105,
              heightMm: 148.5,
              sheet: true,
              cropBox: ZR_INDIVIDUAL_CROP,
            });
          } catch (firstDownloadError) {
            // A SAS URL can expire between the API response and the download. Regenerate the
            // document once, then retry the download.
            try {
              payload = (await this.requestZrLabel(
                '/parcels/labels/individual',
                trackings,
                credentials,
                context.timeoutMs,
              )) as ZrIndividualLabelResponse;
              files = this.zrLabelFiles(payload);
              const regenerated = files.get(tracking);
              if (!regenerated) throw firstDownloadError;
              const file = await this.downloadLabelFile(regenerated, context.timeoutMs);
              documents.push({
                orderNo: order.orderNo,
                trackingNumber: tracking,
                contentType: file.contentType,
                bytes: file.bytes,
                widthMm: 105,
                heightMm: 148.5,
                sheet: true,
                cropBox: ZR_INDIVIDUAL_CROP,
              });
            } catch (err) {
              failures.push(
                this.labelFailure(
                  order,
                  'ORDER_LABEL_SOURCE_EXPIRED',
                  'The carrier label file could not be downloaded.',
                  true,
                ),
              );
            }
          }
        }
      } catch (err) {
        const message = this.safeLabelError(err);
        for (const order of chunk) {
          failures.push(
            this.labelFailure(
              order,
              'ORDER_LABEL_CARRIER_FAILED',
              message,
              this.isRetryable(err),
            ),
          );
        }
      }
    }

    // Keep the requested order stable even if a provider returned files in another order.
    documents.sort((a, b) => {
      const left = orders.findIndex((order) => order.orderNo === a.orderNo);
      const right = orders.findIndex((order) => order.orderNo === b.orderNo);
      return left - right;
    });

    return { documents, failures };
  }

  private zrLabelFiles(payload: ZrIndividualLabelResponse): Map<string, string> {
    const files = new Map<string, string>();
    const entries = payload?.parcelLabelFiles ?? payload?.labelFiles ?? payload?.files ?? [];
    for (const entry of entries) {
      const tracking = String(entry?.trackingNumber ?? '').trim();
      const url = entry?.fileUrl || entry?.url || entry?.file || '';
      if (tracking && url) files.set(tracking, url);
    }
    return files;
  }

  private normalizeFailedTrackings(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object') {
          const record = entry as Record<string, unknown>;
          return String(record.trackingNumber ?? record.tracking ?? record.value ?? '');
        }
        return '';
      })
      .map((entry) => entry.trim())
      .filter(Boolean);
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

  private safeLabelError(err: unknown): string {
    if (err instanceof AppException) {
      switch (err.errorCode) {
        case AppErrorCode.DELIVERY_API_RATE_LIMITED:
          return 'The carrier rate limit was reached. Retry in a few minutes.';
        case AppErrorCode.DELIVERY_API_TIMEOUT:
          return 'The carrier timed out while generating the label.';
        case AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED:
          return 'ZR Express credentials are not configured for this store.';
        default:
          return 'The carrier could not generate the label.';
      }
    }
    if (err instanceof Error && /timeout|timed out|aborted/i.test(err.message)) {
      return 'The carrier timed out while generating the label.';
    }
    return 'The carrier could not generate the label.';
  }

  private isRetryable(err: unknown): boolean {
    return !(err instanceof AppException) || err.errorCode !== AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED;
  }

  private labelApiBase(): string {
    const configured = this.configService.get<string>('orderLabels.zrLabelApiBase');
    return (configured || 'https://api.zrexpress.app/api/v1').replace(/\/+$/, '');
  }

  private async requestZrLabel(
    path: string,
    trackingNumbers: string[],
    credentials: { apiKey: string; tenantId: string },
    timeoutMs: number,
  ): Promise<unknown> {
    const url = `${this.labelApiBase()}${path}`;
    const body = JSON.stringify({ trackingNumbers });
    const timeout = Math.min(timeoutMs || ZR_LABEL_TIMEOUT_MS, ZR_LABEL_TIMEOUT_MS);

    const execute = (headers: Record<string, string>) =>
      fetchWithRetry(
        url,
        {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Tenant': credentials.tenantId,
          },
          body,
          timeout,
        },
        {
          maxRetries: 2,
          circuitBreakerName: `${ZR_LABEL_BREAKER_PREFIX}${credentials.tenantId}`,
          onRetry: (attempt) =>
            this.logger.warn(`ZR Express label request ${path} retry ${attempt}`),
        },
      );

    let response = await execute({ Authorization: `Bearer ${credentials.apiKey}` });
    if (response.status === 401 || response.status === 403) {
      response = await execute({ 'X-Api-Key': credentials.apiKey });
    }

    if (!response.ok) {
      if (response.status === 429) {
        const retryAfter = Number.parseInt(response.headers.get('retry-after') || '', 10);
        throw new AppException(AppErrorCode.DELIVERY_API_RATE_LIMITED, {
          company: 'ZR Express',
          retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
        });
      }
      if (response.status === 401 || response.status === 403) {
        throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, {
          company: 'ZR Express',
        });
      }
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, {
        company: 'ZR Express',
        status: response.status,
      });
    }

    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, {
        company: 'ZR Express',
        status: response.status,
        text: 'Invalid JSON response',
      });
    }
  }

  private async downloadLabelFile(
    url: string,
    timeoutMs: number,
  ): Promise<{ bytes: Buffer; contentType: 'text/html' | 'application/pdf' }> {
    let response: Response;
    try {
      response = await fetchWithRetry(
        url,
        { method: 'GET', timeout: Math.min(timeoutMs || ZR_LABEL_TIMEOUT_MS, ZR_LABEL_TIMEOUT_MS) },
        {
          maxRetries: 2,
          circuitBreakerName: ZR_LABEL_BREAKER_PREFIX + 'download',
        },
      );
    } catch (err) {
      throw new AppException(AppErrorCode.ORDER_LABEL_SOURCE_EXPIRED, {
        message: err instanceof Error ? err.message : 'Label download failed',
      });
    }

    if (!response.ok) {
      throw new AppException(AppErrorCode.ORDER_LABEL_SOURCE_EXPIRED, {
        status: response.status,
      });
    }

    const declared = Number.parseInt(response.headers.get('content-length') || '', 10);
    if (Number.isFinite(declared) && declared > ZR_LABEL_MAX_BYTES) {
      throw new AppException(AppErrorCode.ORDER_LABEL_RENDER_FAILED, {
        message: 'The carrier label file is too large.',
      });
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > ZR_LABEL_MAX_BYTES) {
      throw new AppException(AppErrorCode.ORDER_LABEL_RENDER_FAILED, {
        message: 'The carrier returned an empty or oversized label file.',
      });
    }

    const contentType = response.headers.get('content-type') || '';
    return {
      bytes,
      contentType:
        bytes.subarray(0, 5).toString('ascii') === '%PDF-' || contentType.includes('pdf')
          ? 'application/pdf'
          : 'text/html',
    };
  }

  private async buildZrPayload(order: Order, cityTerritoryId: string, districtTerritoryId: string): Promise<ZrCreateParcelPayload> {
    const isPickupPoint = order.shippingMethod === 'stopdesk';
    const weight = order.items?.reduce((sum, item) => sum + (item.weight || 0) * (item.quantity || 1), 0) || 1;

    const payload: ZrCreateParcelPayload = {
      customer: {
        customerId: crypto.randomUUID(),
        name: order.customer.name || 'Client',
        phone: { number1: this.cleanPhone(order.customer.phone || '') },
      },
      deliveryAddress: {
        cityTerritoryId,
        districtTerritoryId,
        street: order.customer.address || undefined,
      },
      orderedProducts: order.items.map((item) => ({
        productId: crypto.randomUUID(),
        productName: describeOrderItem(item),
        productSku: `SKU-${item.productId || 'unknown'}`,
        unitPrice: item.price || 0,
        quantity: item.quantity || 1,
        stockType: 'local',
      })),
      amount: order.total || 0,
      description: `Order ${order.orderNo}`,
      deliveryType: isPickupPoint ? 'pickup-point' : 'home',
      weight: { weight },
      externalId: order.orderNo,
    };

    if (isPickupPoint && order.stopDeskCode) {
      payload.hubId = order.stopDeskCode;
    }

    return payload;
  }

  private async resolveCityTerritoryId(wilayaCode: string): Promise<string | undefined> {
    const wilaya = await this.wilayaModel.findOne({ code: wilayaCode }).exec();
    if (wilaya?.zrexpress_uuid) {
      return wilaya.zrexpress_uuid;
    }
    this.logger.warn(`Wilaya ${wilayaCode} has no zrexpress_uuid set`);
    return undefined;
  }

  private async resolveDistrictTerritoryId(wilayaCode: string, communeValue: string): Promise<string | undefined> {
    try {
      const isObjectId = /^[a-fA-F0-9]{24}$/.test(communeValue);

      const query: Record<string, unknown> = { wilaya_code: wilayaCode };
      if (isObjectId) {
        query._id = communeValue;
      } else {
        query.post_code = communeValue;
      }

      const commune = await this.communeModel.findOne(query).exec();
      if (commune?.zrexpress_uuid) {
        return commune.zrexpress_uuid;
      }

      this.logger.warn(`Commune ${communeValue} found but no zrexpress_uuid set`);
      return undefined;
    } catch (err) {
      this.logger.warn(`Failed to lookup commune ${communeValue}: ${err instanceof Error ? err.message : ''}`);
      return undefined;
    }
  }

  private cleanPhone(phone: string): string {
    const digits = phone.replace(/[^0-9]/g, '');
    if (digits.startsWith('213')) return `+${digits}`;
    if (digits.startsWith('0')) return `+213${digits.slice(1)}`;
    return `+213${digits}`;
  }

  private getCredentials(config: DeliveryConfig | null): { apiKey: string; tenantId: string } {
    const rawCreds = config?.companies?.['zr-express']?.credentials || {};
    const creds = decryptRecord(rawCreds, this.encryptionKey);
    return {
      apiKey: creds.apiKey || '',
      tenantId: creds.tenantId || '',
    };
  }

  /* ------------------------------------------------------------------ *
   * Status sync (Phase 1) — the read-only carrier status capability
   *
   * Two calls, both read-only:
   *   - `searchStatusParcels` — discovery: which of our parcels changed?
   *   - `fetchStatusHistory`  — detail: the full transition timeline of one parcel.
   *
   * Neither call ever writes to the carrier, and neither advances an order. Deciding what an
   * order does with a carrier status is the sync's job (Phase 2+), not the provider's.
   * ------------------------------------------------------------------ */

  async searchStatusParcels(context: DeliveryStatusContext): Promise<DeliveryStatusSearchResult> {
    const { apiKey, tenantId, overrides, signalOverrides } =
      await this.resolveStatusCredentials(context);

    const request: ZrSearchParcelsRequest = {
      pageNumber: context.page ?? 1,
      pageSize: context.limit ?? ZR_STATUS_DEFAULT_PAGE_SIZE,
      // The carrier's documented sort. Q-2 (whether `advancedFilter` accepts `externalId` and
      // `lastStateUpdateAt`) is still unverified against a live tenant, so the discovery call
      // sorts on the carrier and filters client-side — the fallback the roadmap pins.
      orderBy: ['lastStateUpdateAt desc'],
    };

    const response = await this.zrStatusFetch(tenantId, `${this.apiBase}/parcels/search`, {
      method: 'POST',
      headers: this.zrStatusHeaders(tenantId, apiKey),
      body: JSON.stringify(request),
    });

    const payload = (await this.readStatusJson(response)) as ZrSearchParcelsResponse | null;
    const items: ZrParcelDto[] = payload && Array.isArray(payload.items) ? payload.items : [];

    const externalIds =
      context.externalIds && context.externalIds.length > 0 ? new Set(context.externalIds) : null;
    const updatedAfter = context.updatedAfter ? context.updatedAfter.getTime() : null;

    const parcels: DeliveryStatusParcel[] = [];
    for (const item of items) {
      const mapped = mapParcel(item, overrides, signalOverrides);
      if (!mapped.parcelId) continue;
      if (externalIds && !externalIds.has(mapped.externalId ?? '')) continue;
      if (
        updatedAfter !== null &&
        (!mapped.lastStateUpdateAt || mapped.lastStateUpdateAt.getTime() <= updatedAfter)
      ) {
        continue;
      }
      parcels.push({
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
        situation: mapped.rawSituation
          ? {
              slug: mapped.rawSituation.slug ?? null,
              name: mapped.rawSituation.name ?? null,
              description: mapped.rawSituation.description ?? null,
              flags: flagsForSituations([mapped.rawSituation]),
            }
          : null,
        rawSituation: mapped.rawSituation,
        raw: mapped.raw,
      });
    }

    return {
      parcels,
      totalCount: typeof payload?.totalCount === 'number' ? payload.totalCount : null,
      hasNext: payload?.hasNext === true,
    };
  }

  async fetchStatusHistory(
    context: DeliveryStatusContext,
    parcelId: string,
  ): Promise<DeliveryStatusEntry[]> {
    if (!parcelId) {
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, {
        company: 'ZR Express',
        message: 'parcelId is required',
      });
    }

    const { apiKey, tenantId, overrides } = await this.resolveStatusCredentials(context);

    const response = await this.zrStatusFetch(
      tenantId,
      `${this.apiBase}/parcels/${encodeURIComponent(parcelId)}/state-history`,
      {
        method: 'GET',
        headers: this.zrStatusHeaders(tenantId, apiKey),
      },
    );

    const payload = await this.readStatusJson(response);
    const entries: ZrStateHistoryEntryDto[] = Array.isArray(payload)
      ? (payload as ZrStateHistoryEntryDto[])
      : [];

    return entries
      .map((entry) => {
        const mapped = mapHistoryEntry(entry, overrides);
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
          situationFlags: mapped.situations.flatMap((situation) => situation.flags),
          situations: mapped.situations.map((situation) => ({
            slug: situation.slug,
            name: situation.name,
            description: situation.description,
            flags: situation.flags,
          })),
          raw: mapped.raw,
        } satisfies DeliveryStatusEntry;
      })
      .sort((a, b) => {
        const left = a.at ? a.at.getTime() : Number.POSITIVE_INFINITY;
        const right = b.at ? b.at.getTime() : Number.POSITIVE_INFINITY;
        return left - right;
      });
  }

  /**
   * Resolves the store's delivery configuration, **store-first**.
   *
   * `storeId` is the canonical seller identity and is queried first. `vendorEmail` is accepted
   * only as a read fallback for rows written before the store-id migration, and only when the
   * `storeId` query missed — a single `$or` would let a foreign legacy row win the match, which
   * is exactly the class of bug the store-id migration exists to remove.
   */
  private async findStatusConfig(context: DeliveryStatusContext): Promise<DeliveryConfig | null> {
    if (context.storeId && isObjectIdLike(context.storeId)) {
      const byStore = await this.configModel
        .findOne({ storeId: new Types.ObjectId(context.storeId) })
        .lean()
        .exec();
      if (byStore) {
        return this.guardStatusConfig(byStore as DeliveryConfig, context);
      }
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

  /**
   * The tenancy guard. When the caller named a store, the configuration must belong to that
   * store. A legacy row that predates `storeId` is accepted; a row owned by a *different* store
   * is not, even when the legacy email branch matched it.
   */
  private guardStatusConfig(
    config: DeliveryConfig,
    context: DeliveryStatusContext,
  ): DeliveryConfig | null {
    if (context.storeId && config.storeId && String(config.storeId) !== String(context.storeId)) {
      return null;
    }
    return config;
  }

  /** Resolves and validates the ZR credentials for the store. Never logs the key. */
  private async resolveStatusCredentials(
    context: DeliveryStatusContext,
  ): Promise<{
    apiKey: string;
    tenantId: string;
    overrides: StateOverrides | null;
    signalOverrides: SignalOverrides | null;
  }> {
    const config = await this.findStatusConfig(context);
    const company = config?.companies?.['zr-express'];

    // A missing `status` means a legacy row written before the field existed — treated as
    // enabled, exactly as the delivery flow treats it.
    if (!config || !company || company.status === 'disabled') {
      throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, {
        company: 'ZR Express',
        storeId: context.storeId ?? null,
        vendorEmail: context.vendorEmail ?? null,
      });
    }

    const { apiKey, tenantId } = this.getCredentials(config);
    if (!apiKey || !tenantId) {
      throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, {
        company: 'ZR Express',
        storeId: context.storeId ?? null,
        vendorEmail: context.vendorEmail ?? null,
      });
    }

    // The store's per-tenant state remapping (roadmap §11.3). Absent — the common case — the
    // built-in catalogue applies.
    const overrides = config.statusStateOverrides?.['zr-express'] ?? null;
    const signalOverrides = config.statusSignalOverrides?.['zr-express'] ?? null;

    return { apiKey, tenantId, overrides, signalOverrides };
  }

  /**
   * The carrier tenant the store's configuration points at (roadmap §18.3).
   *
   * Returns `null` — never a credential — when the store has no usable ZR configuration. The
   * poller uses the tenant id to group stores under one call budget and to name its circuit
   * breaker; it never sees the API key.
   */
  async resolveStatusTenant(context: DeliveryStatusContext): Promise<string | null> {
    try {
      const { tenantId } = await this.resolveStatusCredentials(context);
      return tenantId || null;
    } catch {
      // A store without usable credentials is simply skipped by the poller (§18.4) — it is not
      // an error, so it is not surfaced as one.
      return null;
    }
  }

  /** The status endpoints' headers. The API key travels in `X-Api-Key` and is never logged. */
  private zrStatusHeaders(tenantId: string, apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Tenant': tenantId,
      'X-Api-Key': apiKey,
    };
  }

  /**
   * Performs one status call and maps every failure onto the delivery error codes the platform
   * already exposes. The status sync introduces no new error codes.
   */
  private async zrStatusFetch(
    tenantId: string,
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<Response> {
    try {
      const response = await fetchWithRetry(
        url,
        { timeout: ZR_STATUS_TIMEOUT_MS, ...init },
        {
          circuitBreakerName: `${ZR_STATUS_BREAKER_PREFIX}${tenantId}`,
          onRetry: (attempt, err) =>
            this.logger.warn(
              `ZR Express status call failed (attempt ${attempt}): ${
                err instanceof Error ? err.message : `HTTP ${err.status}`
              }`,
            ),
        },
      );

      if (response.ok) return response;

      if (response.status === 429) {
        // The carrier may tell us how long to wait (roadmap §14.3, open question Q-5). The
        // header is passed on when it is present and parseable; the poller honours it in
        // preference to its own backoff ladder, capped at 60 minutes.
        const retryAfterHeader = response.headers?.get?.('retry-after');
        const retryAfterSeconds = Number.parseInt(retryAfterHeader ?? '', 10);
        throw new AppException(AppErrorCode.DELIVERY_API_RATE_LIMITED, {
          company: 'ZR Express',
          status: response.status,
          retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
        });
      }

      const body = await response.text().catch(() => '');
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, {
        company: 'ZR Express',
        status: response.status,
        body: body.slice(0, 500),
      });
    } catch (err) {
      if (err instanceof AppException) throw err;
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (/timed out|timeout/i.test(message)) {
        throw new AppException(AppErrorCode.DELIVERY_API_TIMEOUT, {
          company: 'ZR Express',
          message,
        });
      }
      throw new AppException(AppErrorCode.DELIVERY_UNKNOWN_ERROR, {
        company: 'ZR Express',
        message,
      });
    }
  }

  /** Reads a status response body as JSON, tolerating an empty body. */
  private async readStatusJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      this.logger.error(`ZR Express status response was not valid JSON: ${text.slice(0, 500)}`);
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, {
        company: 'ZR Express',
        message: 'Invalid JSON response',
      });
    }
  }
}
