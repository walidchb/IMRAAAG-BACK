import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../../../common/errors/app-exception';
import { AppErrorCode } from '../../../../common/errors/error-codes.enum';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  DeliveryCompanyHandler,
  BulkOrderResult,
  CarrierCommuneOption,
  DeliveryStatusContext,
  DeliveryStatusSearchResult,
  DeliveryStatusEntry,
  DeliveryStatusParcel,
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
import { isNormalizedStatus } from '../../delivery-status/carrier/carrier-signal';
import { createHash } from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { isPdf, mapWithConcurrency, parseRetryAfter } from './order-label.util';
import {
  mapNoestDiscoveryEntry,
  normalizeNoestEvent,
} from './noest/noest-status.mapper';
import type { NoestDiscoveryResponseDto } from './noest/noest-status.types';
import {
  NoestCommuneOption,
  isNoestDispatchable,
  isNoestMappingValid,
} from '../noest-commune';

const NOEST_LABEL_BREAKER_PREFIX = 'noest-labels:';
/** Dedicated breaker for the commune list: never the shared `noest` create breaker. */
const NOEST_COMMUNES_BREAKER_PREFIX = 'noest-communes:';
const NOEST_LABEL_TIMEOUT_MS = 15000;
const NOEST_LABEL_MAX_BYTES = 10 * 1024 * 1024;
const NOEST_LABEL_CONCURRENCY = 5;

/**
 * Noest returns an A4 page whose printable slip occupies the top-left quadrant (verified live on
 * two separate labels on 2026-10-28: both content boxes were 285.837 x 406.676 pt at (7.5,
 * 427.714)). Cropping to the verified region keeps the thermal formats usable instead of shrinking
 * a mostly blank A4 sheet. The crop is applied only to a single A4-sized page; any other geometry
 * is passed through uncropped.
 */
const NOEST_A4_PT = { width: 595.28, height: 841.89 } as const;
const NOEST_A4_TOLERANCE_PT = 2;
const NOEST_LABEL_CROP_PT = {
  x: 7.5,
  y: 427.714,
  width: 285.837,
  height: 406.676,
} as const;
const PT_TO_MM = 25.4 / 72;


interface NoestCreateOrderPayload {
  user_guid: string;
  reference?: string;
  client: string;
  phone: string;
  phone_2?: string;
  adresse: string;
  wilaya_id: number;
  commune: string;
  montant: number;
  remarque?: string;
  produit: string;
  type_id: number;
  poids?: number;
  stop_desk: number;
  station_code?: string;
  can_open?: number;
  shop_name?: string;
}

interface NoestCreateOrderResponse {
  success: boolean;
  tracking?: string;
  reference?: string;
  message?: string;
}

@Injectable()
export class NoestHandler implements DeliveryCompanyHandler {
  readonly companyId = 'noest';
  private readonly apiBase = 'https://app.noest-dz.com';
  private readonly logger = new Logger(NoestHandler.name);
  /** Provider states already reported as unmapped, so a repeat poll does not spam the log. */
  private readonly loggedUnknownStates = new Set<string>();

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

  /**
   * The carrier's commune list for one wilaya.
   *
   * `GET /api/public/get/communes/{wilaya_id}` needs only the Bearer token — `user_guid` is not
   * required. The response is a bare array (`[{ nom, wilaya_id, code_postal, is_active }]`): no
   * UUID and **no stop-desk flag**, so the normalised options carry no `hasStopDesk` key.
   */
  async listCommunes(
    wilayaCode: string,
    context: DeliveryStatusContext,
  ): Promise<CarrierCommuneOption[]> {
    const credentials = await this.resolveStatusCredentials(context);
    const wilayaId = String(Number(wilayaCode));

    const response = await fetchWithRetry(
      `${this.apiBase}/api/public/get/communes/${wilayaId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${credentials.apiKey}`,
          Accept: 'application/json',
        },
        timeout: 15000,
      },
      {
        circuitBreakerName: `${NOEST_COMMUNES_BREAKER_PREFIX}${credentials.tenantId}`,
        retryOn: (res) => [408, 429, 500, 502, 503, 504].includes(res.status),
        onRetry: (attempt, err) =>
          this.logger.warn(
            `[Noest] Communes retry ${attempt}: ${err instanceof Error ? err.message : 'HTTP ' + err.status}`,
          ),
      },
    );

    if (response.status === 401 || response.status === 403) {
      throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, {
        company: 'Noest',
      });
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      throw new AppException(AppErrorCode.RATE_LIMIT_EXCEEDED, {
        company: 'Noest',
        retryAfter: retryAfter ? parseInt(retryAfter, 10) : 60,
      });
    }

    if (!response.ok) {
      const text = await response.text();
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, {
        company: 'Noest',
        status: response.status,
        text: text.slice(0, 300),
      });
    }

    const body = await response.json().catch(() => null);
    return normalizeNoestCommunes(body, wilayaId);
  }

  /**
   * Rollout gate for the commune-mapping *requirement*. When off, dispatch keeps today's legacy
   * behaviour: the commune is resolved from the platform `communes` collection and sent verbatim.
   * A valid saved selection is used either way. Default `false`, so the gate stays dark and rolls
   * back instantly.
   */
  private communeMappingEnabled(): boolean {
    return this.configService.get<boolean>('noestCommuneMapping.enabled') === true;
  }

  /**
   * The authoritative Noest commune for a dispatch. An explicit, valid operator selection always
   * wins, even while the rollout flag is off: the selector is available to vendors regardless of
   * the flag, so ignoring a saved selection would send the carrier a different commune than the
   * one the operator chose.
   *
   * With no usable selection, the platform location registry is consulted: a populated
   * `communes.noestexpress_uuid` means the commune is already Noest-recognized, so no manual
   * mapping is needed and its value is sent verbatim as `commune`. Only a commune with an empty
   * `noestexpress_uuid` still needs the operator to pick one from Noest's list.
   */
  private async resolveDispatchCommune(order: Order): Promise<Order['noestCommune'] | null> {
    if (isNoestDispatchable(order)) return order.noestCommune ?? null;
    return this.communeFromRegistry(order);
  }

  /**
   * Looks the order's customer commune up in the platform `communes` collection and turns its
   * `noestexpress_uuid` (the Noest commune name) into a dispatch selection. Returns `null` when the
   * commune has no Noest counterpart — exactly the "Noest commune missing" case the vendor UI
   * shows.
   */
  private async communeFromRegistry(order: Order): Promise<Order['noestCommune'] | null> {
    const wilayaCode = String(order.customer?.wilaya ?? '').trim();
    const communeValue = String(order.customer?.commune ?? '').trim();
    const wilayaId = String(Number(wilayaCode));
    if (!communeValue || !/^\d{1,2}$/.test(wilayaId)) return null;

    try {
      const query: Record<string, unknown> = { wilaya_code: wilayaCode };
      if (/^[a-fA-F0-9]{24}$/.test(communeValue)) {
        query._id = communeValue;
      } else {
        query.$or = [{ post_code: communeValue }, { name: communeValue }];
      }

      const commune = await this.communeModel.findOne(query).lean().exec();
      const noestName =
        typeof commune?.noestexpress_uuid === 'string' ? commune.noestexpress_uuid.trim() : '';
      if (!noestName) return null;

      const postalCode = typeof commune?.post_code === 'string' ? commune.post_code.trim() : '';
      return {
        name: noestName,
        wilayaId,
        postalCode: postalCode || null,
      };
    } catch (err) {
      this.logger.warn(
        `Failed to resolve Noest commune for order ${order.orderNo}: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      return null;
    }
  }

  /**
   * Pre-dispatch assertion delegated from `DeliveryService.assertCanCreateDelivery`. Only Noest
   * orders are gated, and only while the feature is enabled; everything else is a no-op so the
   * other carriers' dispatch paths are untouched.
   *
   * A commune whose platform row already carries a `noestexpress_uuid` is dispatchable with no
   * manual mapping. Only a commune with an empty mapping (and no explicit selection) is refused —
   * before any Noest HTTP call, so nothing is booked and no stock moves.
   */
  async assertDispatchable(order: Order): Promise<void> {
    if (!this.communeMappingEnabled()) return;
    if (order.deliveryCompanyId !== 'noest') return;
    if (isNoestDispatchable(order)) return;

    // An explicit selection that fails validation is never silently replaced: the operator chose
    // it, so the save must be corrected rather than dispatched with a different commune.
    if (order.noestCommune?.name?.trim()) {
      throw new AppException(
        isNoestMappingValid(order)
          ? AppErrorCode.DELIVERY_COMMUNE_NOT_MAPPED
          : AppErrorCode.DELIVERY_COMMUNE_INVALID,
        {
          orderNo: order.orderNo,
          wilaya: order.customer?.wilaya,
        },
      );
    }

    const registrySelection = await this.communeFromRegistry(order);
    if (registrySelection) return;

    throw new AppException(AppErrorCode.DELIVERY_COMMUNE_NOT_MAPPED, {
      orderNo: order.orderNo,
      wilaya: order.customer?.wilaya,
    });
  }

  async createOrder(order: Order): Promise<{ parcelId: string }> {
    const config = await this.configModel.findOne({ vendorEmail: order.vendorEmail }).exec();
    const rawCreds = config?.companies?.['noest']?.credentials || {};
    const creds = decryptRecord(rawCreds, this.encryptionKey);

    const apiToken: string | undefined = creds.apiToken;
    const userGuid: string | undefined = creds.guid;

    if (!apiToken || !userGuid) {
      throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, { company: 'Noest', vendor: order.vendorEmail });
    }

    const selection = await this.resolveDispatchCommune(order);
    const communeName = selection
      ? ''
      : await this.resolveCommuneName(order.customer.wilaya, order.customer.commune);

    const payload = this.buildNoestPayload(order, userGuid, communeName, selection);

    if (payload.wilaya_id < 1 || payload.wilaya_id > 58) {
      throw new AppException(AppErrorCode.DELIVERY_INVALID_WILAYA, { wilaya: payload.wilaya_id, orderNo: order.orderNo });
    }

    try {
      this.logger.log(`Noest payload for ${order.orderNo}: ${JSON.stringify(payload)}`);

      const response = await fetchWithRetry(
        `${this.apiBase}/api/public/create/order`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(payload),
          timeout: 10000,
        },
        {
          circuitBreakerName: 'noest',
          onRetry: (attempt, err) => this.logger.warn(`Noest create order retry ${attempt}: ${err instanceof Error ? err.message : 'HTTP ' + err.status}`),
        },
      );

      const responseText = await response.text();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(responseText);
      } catch {
        body = { raw: responseText };
      }

      this.logger.log(`Noest response for ${order.orderNo} (${response.status}): ${JSON.stringify(body)}`);

      if (!response.ok || body.success !== true) {
        throw new AppException(AppErrorCode.DELIVERY_API_ERROR, { company: 'Noest', status: response.status, text: responseText });
      }

      const tracking = body.tracking as string | undefined;
      if (!tracking) {
        throw new AppException(AppErrorCode.DELIVERY_ORDER_NOT_IN_RESPONSE, { orderNo: order.orderNo, company: 'Noest' });
      }

      this.logger.log(`Noest order created: ${tracking} for order ${order.orderNo}`);
      return { parcelId: tracking };
    } catch (err) {
      if (err instanceof AppException) throw err;
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Noest API call failed for order ${order.orderNo}: ${message}`);
      throw new AppException(AppErrorCode.DELIVERY_UNKNOWN_ERROR, { company: 'Noest', orderNo: order.orderNo, message });
    }
  }

  async createBulkOrders(orders: Order[]): Promise<BulkOrderResult[]> {
    if (orders.length === 0) return [];
    if (orders.length > 100) {
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: 'Max 100 orders per bulk request' }));
    }

    // Tenancy guard (mirrors DHD): one batch is always one store's batch.
    if (new Set(orders.map((o) => String(o.storeId ?? ''))).size > 1) {
      throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, { field: 'orders' });
    }

    // Resolve every order's Noest commune once and reuse it for the partition and the payload.
    // An explicit selection wins; otherwise the platform commune's `noestexpress_uuid` is the
    // mapping, and a commune with neither still needs the operator to pick one.
    const selections = new Map<Order, Order['noestCommune'] | null>();
    for (const order of orders) {
      selections.set(order, await this.resolveDispatchCommune(order));
    }

    if (!this.communeMappingEnabled()) {
      return this.dispatchBulkOrders(orders, selections);
    }

    const validOrders: Order[] = [];
    const invalidResults: BulkOrderResult[] = [];

    for (const order of orders) {
      const explicitlySelected = !!order.noestCommune?.name?.trim();
      // A valid explicit selection dispatches; so does a commune the platform already maps to
      // Noest via `noestexpress_uuid`. Anything else needs the operator to pick a Noest commune.
      const dispatchable =
        isNoestDispatchable(order) || (!explicitlySelected && !!selections.get(order));
      if (!dispatchable) {
        invalidResults.push({
          orderNo: order.orderNo,
          success: false,
          code: AppErrorCode.DELIVERY_COMMUNE_NOT_MAPPED,
          error: 'Noest commune not selected or not mapped for this wilaya',
        });
      } else {
        validOrders.push(order);
      }
    }

    // Zero HTTP calls when the whole batch is unmapped.
    if (validOrders.length === 0) return invalidResults;

    return [...invalidResults, ...(await this.dispatchBulkOrders(validOrders, selections))];
  }

  /**
   * Sends one Noest bulk request for the orders it is given.
   *
   * Noest's `passed`/`failed` keys are indices into the array **we sent**, so every lookup goes
   * through `orders[index]` — the array this method receives. After partitioning that is the
   * `validOrders` array, never the caller's pre-partition batch; resolving against the wrong array
   * would attach a tracking number to the wrong order.
   */
  private async dispatchBulkOrders(
    orders: Order[],
    resolvedSelections?: Map<Order, Order['noestCommune'] | null>,
  ): Promise<BulkOrderResult[]> {
    if (orders.length === 0) return [];

    const config = await this.configModel.findOne({ vendorEmail: orders[0].vendorEmail }).exec();
    const rawCreds = config?.companies?.['noest']?.credentials || {};
    const creds = decryptRecord(rawCreds, this.encryptionKey);
    const apiToken = creds.apiToken;
    const userGuid = creds.guid;

    if (!apiToken || !userGuid) {
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: 'Noest credentials not configured' }));
    }

    const orderPayloads: NoestCreateOrderPayload[] = [];
    for (const order of orders) {
      const selection = resolvedSelections
        ? resolvedSelections.get(order) ?? null
        : await this.resolveDispatchCommune(order);
      const communeName = selection
        ? ''
        : await this.resolveCommuneName(order.customer.wilaya, order.customer.commune);
      const payload = this.buildNoestPayload(order, userGuid, communeName, selection);

      if (payload.wilaya_id < 1 || payload.wilaya_id > 58) {
        return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: `Invalid wilaya_id ${payload.wilaya_id} for order ${order.orderNo}` }));
      }

      orderPayloads.push(payload);
    }

    try {
      this.logger.log(`Noest bulk payload for ${orders.length} orders`);

      const response = await fetchWithRetry(
        `${this.apiBase}/api/public/create/orders`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ user_guid: userGuid, orders: orderPayloads }),
          timeout: 15000,
        },
        {
          circuitBreakerName: 'noest',
          onRetry: (attempt, err) => this.logger.warn(`Noest bulk create retry ${attempt}: ${err instanceof Error ? err.message : 'HTTP ' + err.status}`),
        },
      );

      const responseText = await response.text();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(responseText);
      } catch {
        body = { raw: responseText };
      }

      this.logger.log(`Noest bulk response (${response.status}): ${JSON.stringify(body)}`);

      const results: BulkOrderResult[] = [];
      const passed = body.passed as Record<string, { success: boolean; tracking?: string }> | undefined;
      const failed = body.failed as Record<string, { reference?: string; errors?: string }> | undefined;

      if (passed) {
        for (const [indexStr, result] of Object.entries(passed)) {
          const index = parseInt(indexStr, 10);
          const order = orders[index];
          if (order) {
            results.push({ orderNo: order.orderNo, success: true, parcelId: result.tracking });
          }
        }
      }

      if (failed) {
        for (const [indexStr, result] of Object.entries(failed)) {
          const index = parseInt(indexStr, 10);
          const order = orders[index];
          if (order) {
            results.push({ orderNo: order.orderNo, success: false, error: result.errors || 'Unknown error' });
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
      this.logger.error(`Noest bulk API call failed: ${message}`);
      return orders.map((o) => ({ orderNo: o.orderNo, success: false, error: message }));
    }
  }

  /**
   * Builds the Noest create-order payload.
   *
   * A resolved commune mapping is authoritative (`commune` + `wilaya_id`). Its `postalCode` is
   * deliberately **never** sent: Noest accepts no `code_postal` on create, and its `zip_code`
   * field *replaces* `wilaya_id`/`commune`, which would silently discard the mapping.
   */
  private buildNoestPayload(
    order: Order,
    userGuid: string,
    communeName: string,
    selection: Order['noestCommune'] | null = null,
  ): NoestCreateOrderPayload {
    const weight = order.items?.reduce((sum, item) => sum + (item.weight || 0) * (item.quantity || 1), 0) || 1;

    const produit =
      order.items
        ?.map((item) => item.productName || `Product ${item.productId || ''}`)
        .filter(Boolean)
        .join(', ') || `Order ${order.orderNo}`;

    const isStopDesk = order.shippingMethod === 'stopdesk';

    const commune = selection?.name ?? communeName;
    const wilayaId = selection
      ? Number(selection.wilayaId)
      : parseInt(order.customer.wilaya, 10) || 0;

    const payload: NoestCreateOrderPayload = {
      user_guid: userGuid,
      reference: order.orderNo,
      client: order.customer.name || 'Client',
      phone: this.cleanPhone(order.customer.phone || ''),
      adresse: order.customer.address || commune,
      wilaya_id: wilayaId,
      commune,
      montant: order.total || 0,
      produit,
      type_id: 1,
      stop_desk: isStopDesk ? 1 : 0,
      poids: weight,
      can_open: 1,
    };

    if (isStopDesk && order.stopDeskCode) {
      payload.station_code = order.stopDeskCode;
    }

    if (order.customer.note) {
      payload.remarque = order.customer.note;
    }

    if (order.customer.email) {
      payload.phone_2 = this.cleanPhone(order.customer.email);
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

      if (commune?.noestexpress_uuid) {
        this.logger.log(`Resolved commune "${communeValue}" → noest name "${commune.noestexpress_uuid}"`);
        return commune.noestexpress_uuid;
      }

      if (commune) {
        this.logger.warn(`Commune ${communeValue} found but no noestexpress_uuid set, falling back to DB name "${commune.name}"`);
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

  /**
   * Batch discovery — POST /api/public/get/trackings/info
   */
  async searchStatusParcels(
    context: DeliveryStatusContext,
  ): Promise<DeliveryStatusSearchResult> {
    const credentials = await this.resolveStatusCredentials(context);
    const ids = [...new Set((context.parcelIds ?? []).map((id) => String(id).trim()).filter(Boolean))];

    if (ids.length === 0) {
      return { parcels: [], totalCount: 0, hasNext: false, missingParcelIds: [] };
    }

    const data = await this.requestDiscovery(credentials, ids);

    // Response is a top-level object keyed by tracking
    const parcels: DeliveryStatusParcel[] = [];
    const missingParcelIds: string[] = [];

    for (const tracking of ids) {
      if (data[tracking]) {
        const snapshot = mapNoestDiscoveryEntry(data[tracking], tracking);
        this.warnOnceForUnknownState(snapshot);
        parcels.push(this.toStatusParcel(snapshot, tracking));
      } else {
        missingParcelIds.push(tracking);
      }
    }

    this.logger.log(
      `[Noest] Discovery: requested=${ids.length}, found=${parcels.length}, missing=${missingParcelIds.length}`,
    );

    return { parcels, totalCount: ids.length, hasNext: false, missingParcelIds };
  }

  /**
   * Single-parcel history, derived from the discovery endpoint.
   *
   * Noest exposes no working per-parcel history route: GET /api/public/get/tracking/history/:id
   * answers 404 for every parcel (verified live). The discovery endpoint returns the complete
   * `activity[]` timeline for each requested tracking, so a detail call is the same request with
   * a one-item batch.
   */
  async fetchStatusHistory(
    context: DeliveryStatusContext,
    parcelId: string,
  ): Promise<DeliveryStatusEntry[]> {
    const credentials = await this.resolveStatusCredentials(context);
    const tracking = String(parcelId ?? '').trim();
    if (!tracking) return [];

    const data = await this.requestDiscovery(credentials, [tracking]);
    const entry = data[tracking];

    if (!entry) {
      this.logger.warn(`[Noest] History: tracking ${tracking} was not returned by discovery.`);
      return [];
    }

    const snapshot = mapNoestDiscoveryEntry(entry, tracking);
    const entries = this.toStatusEntries(snapshot.timeline, tracking);

    this.logger.log(
      `[Noest] History for ${tracking}: ${entries.length} timeline entry(ies), ` +
        `status=${snapshot.normalizedStatus}, state=${snapshot.providerState}.`,
    );

    return entries;
  }

  /**
   * The one working status route: POST /api/public/get/trackings/info.
   *
   * Shared by discovery and history so both use the same contract, error mapping and logging.
   * `fetchWithRetry` returns non-retryable non-2xx responses unchanged, so the status is checked
   * here.
   */
  private async requestDiscovery(
    credentials: { apiKey: string; tenantId: string },
    ids: string[],
  ): Promise<NoestDiscoveryResponseDto> {
    const url = `${this.apiBase}/api/public/get/trackings/info`;

    try {
      const response = await fetchWithRetry(
        url,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credentials.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ trackings: ids }),
          timeout: 30000,
        },
        {
          circuitBreakerName: `noest-status:${credentials.tenantId}`,
          retryOn: (res) => [408, 429, 500, 502, 503, 504].includes(res.status),
          onRetry: (attempt, err) =>
            this.logger.warn(
              `[Noest] Status request retry ${attempt}: ${err instanceof Error ? err.message : 'HTTP ' + err.status}`,
            ),
        },
      );

      this.logger.debug(
        `[Noest] Status request: trackings=${ids.length}, HTTP ${response.status}.`,
      );

      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        throw new AppException(AppErrorCode.RATE_LIMIT_EXCEEDED, {
          company: 'Noest',
          retryAfter: retryAfter ? parseInt(retryAfter, 10) : 60,
        });
      }

      if (response.status === 401 || response.status === 403) {
        throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, {
          company: 'Noest',
          message: 'Invalid API token or user_guid',
        });
      }

      if (!response.ok) {
        const text = await response.text();
        this.logger.error(
          `[Noest] Status request failed: HTTP ${response.status} — ${text.slice(0, 300)}`,
        );
        throw new AppException(AppErrorCode.DELIVERY_API_ERROR, {
          company: 'Noest',
          status: response.status,
          text: text.slice(0, 300),
        });
      }

      return (await response.json()) as NoestDiscoveryResponseDto;
    } catch (error) {
      if (error instanceof AppException) throw error;

      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[Noest] Status request threw: ${message}`);
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, {
        company: 'Noest',
        message,
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * Label capability
   *
   * Noest's printable reference is the tracking number returned at creation, so the platform's
   * parcelId fallback is already correct and `prepareLabels` is intentionally not implemented.
   * One label is downloaded per order; failures stay isolated to their order.
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

    let credentials: { apiKey: string; userGuid: string; tenantId: string };
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
            'Noest credentials are not configured for this store.',
            false,
          ),
        );
      }
      return { documents, failures };
    }

    const results = await mapWithConcurrency(
      printable,
      this.labelConcurrency(),
      async (order) => {
        try {
          const tracking = String(order.trackingNumber).trim();
          const bytes = await this.downloadNoestLabel(tracking, credentials, context.timeoutMs);
          const geometry = await this.inspectNoestLabel(bytes);
          return {
            document: {
              orderNo: order.orderNo,
              trackingNumber: tracking,
              contentType: 'application/pdf',
              bytes,
              ...geometry,
            } satisfies DeliveryLabelDocument,
            failure: null,
          };
        } catch (err) {
          return {
            document: null,
            failure: this.labelFailure(
              order,
              this.noestLabelErrorCode(err),
              this.noestLabelErrorMessage(err),
              this.isRetryableNoestLabelError(err),
            ),
          };
        }
      },
    );

    for (const result of results) {
      if (result.document) documents.push(result.document);
      if (result.failure) failures.push(result.failure);
    }

    return { documents, failures };
  }

  private async downloadNoestLabel(
    tracking: string,
    credentials: { apiKey: string; tenantId: string },
    timeoutMs: number,
  ): Promise<Buffer> {
    const params = new URLSearchParams({ tracking });
    const url = `${this.labelApiBase()}/api/public/get/order/label?${params.toString()}`;
    const timeout = Math.min(timeoutMs || NOEST_LABEL_TIMEOUT_MS, NOEST_LABEL_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetchWithRetry(
        url,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${credentials.apiKey}`,
            Accept: 'application/pdf',
          },
          timeout,
        },
        {
          maxRetries: 2,
          circuitBreakerName: `${NOEST_LABEL_BREAKER_PREFIX}${credentials.tenantId}`,
          retryOn: (candidate) => candidate.status !== 429,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (/timeout|timed out|aborted/i.test(message)) {
        throw new AppException(AppErrorCode.DELIVERY_API_TIMEOUT, { company: 'Noest' });
      }
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, {
        company: 'Noest',
        message,
      });
    }

    if (!response.ok) {
      if (response.status === 404 || response.status === 400 || response.status === 422) {
        throw new AppException(AppErrorCode.ORDER_LABEL_NOT_FOUND_AT_CARRIER, {
          company: 'Noest',
          status: response.status,
        });
      }
      if (response.status === 429) {
        throw new AppException(AppErrorCode.DELIVERY_API_RATE_LIMITED, {
          company: 'Noest',
          retryAfterSeconds: parseRetryAfter(response),
        });
      }
      if (response.status === 401 || response.status === 403) {
        throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, {
          company: 'Noest',
        });
      }
      throw new AppException(AppErrorCode.DELIVERY_API_ERROR, {
        company: 'Noest',
        status: response.status,
      });
    }

    const declared = Number.parseInt(response.headers.get('content-length') || '', 10);
    if (Number.isFinite(declared) && declared > NOEST_LABEL_MAX_BYTES) {
      throw new AppException(AppErrorCode.ORDER_LABEL_RENDER_FAILED, {
        company: 'Noest',
        message: 'The carrier label file is too large.',
      });
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > NOEST_LABEL_MAX_BYTES || !isPdf(bytes)) {
      throw new AppException(AppErrorCode.ORDER_LABEL_RENDER_FAILED, {
        company: 'Noest',
        message: 'The carrier returned an invalid PDF.',
      });
    }

    this.logger.debug(`[Noest] Label downloaded: ${tracking}, ${bytes.length} bytes.`);
    return bytes;
  }

  /**
   * Reads the PDF once so the composer never receives a corrupt document, and reports the native
   * label size. A single A4 page gets the verified Noest crop; every other geometry is returned
   * untouched (the composer then fits the whole page).
   */
  private async inspectNoestLabel(
    bytes: Buffer,
  ): Promise<Pick<DeliveryLabelDocument, 'cropBox' | 'widthMm' | 'heightMm'>> {
    let pageCount: number;
    let widthPt: number;
    let heightPt: number;
    try {
      const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
      const pages = pdf.getPages();
      if (pages.length === 0) throw new Error('PDF has no pages');
      pageCount = pages.length;
      widthPt = pages[0].getWidth();
      heightPt = pages[0].getHeight();
    } catch {
      throw new AppException(AppErrorCode.ORDER_LABEL_RENDER_FAILED, {
        company: 'Noest',
        message: 'The carrier returned an unreadable PDF.',
      });
    }

    const isA4 =
      Math.abs(widthPt - NOEST_A4_PT.width) <= NOEST_A4_TOLERANCE_PT &&
      Math.abs(heightPt - NOEST_A4_PT.height) <= NOEST_A4_TOLERANCE_PT;

    if (pageCount === 1 && isA4) {
      return {
        cropBox: { ...NOEST_LABEL_CROP_PT },
        widthMm: this.roundMm(NOEST_LABEL_CROP_PT.width),
        heightMm: this.roundMm(NOEST_LABEL_CROP_PT.height),
      };
    }

    return {
      widthMm: this.roundMm(widthPt),
      heightMm: this.roundMm(heightPt),
    };
  }

  private roundMm(pt: number): number {
    return Math.round(pt * PT_TO_MM * 10) / 10;
  }

  private labelApiBase(): string {
    const configured = this.configService.get<string>('orderLabels.noestLabelApiBase');
    return (configured || this.apiBase).replace(/\/+$/, '');
  }

  private labelConcurrency(): number {
    const configured = Number(this.configService.get<number>('orderLabels.carrierConcurrency'));
    return Number.isFinite(configured) && configured > 0
      ? Math.min(10, Math.floor(configured))
      : NOEST_LABEL_CONCURRENCY;
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

  private noestLabelErrorCode(err: unknown): string {
    if (err instanceof AppException) {
      if (err.errorCode === AppErrorCode.ORDER_LABEL_NOT_FOUND_AT_CARRIER) {
        return 'ORDER_LABEL_NOT_FOUND_AT_CARRIER';
      }
      if (err.errorCode === AppErrorCode.ORDER_LABEL_RENDER_FAILED) {
        return 'ORDER_LABEL_RENDER_FAILED';
      }
    }
    return 'ORDER_LABEL_CARRIER_FAILED';
  }

  private noestLabelErrorMessage(err: unknown): string {
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
        return 'Noest credentials are not configured for this store.';
      }
    }
    return 'The carrier could not generate the label.';
  }

  private isRetryableNoestLabelError(err: unknown): boolean {
    if (!(err instanceof AppException)) return true;
    return ![
      AppErrorCode.ORDER_LABEL_NOT_FOUND_AT_CARRIER,
      AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED,
      AppErrorCode.ORDER_LABEL_RENDER_FAILED,
    ].includes(err.errorCode as never);
  }

  /**
   * Store-first credential resolution (shared with order creation)
   */
  async resolveStatusTenant(context: DeliveryStatusContext): Promise<string | null> {
    const credentials = await this.resolveStatusCredentials(context);
    return credentials.tenantId;
  }

  private async resolveStatusCredentials(
    context: DeliveryStatusContext,
  ): Promise<{ apiKey: string; userGuid: string; tenantId: string }> {
    // Try storeId first. The id must be an explicit ObjectId: the platform stores `storeId` as an
    // ObjectId, and a raw string does not match it (the same reason the DHD handler converts).
    let config: DeliveryConfig | null = null;
    const storeId = String(context.storeId ?? '').trim();
    if (storeId && Types.ObjectId.isValid(storeId)) {
      config = await this.configModel
        .findOne({ storeId: new Types.ObjectId(storeId) })
        .lean<DeliveryConfig>();
    }

    // Fallback to vendorEmail (pre-migration stores)
    if (!config && context.vendorEmail) {
      config = await this.configModel
        .findOne({ vendorEmail: context.vendorEmail })
        .lean<DeliveryConfig>();
    }

    if (!config?.companies?.['noest']) {
      throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, {
        company: 'Noest',
        storeId: context.storeId,
      });
    }

    const rawCreds = config.companies['noest'].credentials || {};
    const creds = decryptRecord(rawCreds, this.encryptionKey);

    const apiKey = creds.apiToken || creds.apiKey;
    const userGuid = creds.guid || creds.userGuid;

    if (!apiKey || !userGuid) {
      throw new AppException(AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED, {
        company: 'Noest',
        storeId: context.storeId,
        message: 'Missing apiKey or userGuid',
      });
    }

    // Tenant ID for breaker: sha256(apiKey + userGuid).slice(0, 16)
    const hash = createHash('sha256')
      .update(`${apiKey}:${userGuid}`, 'utf8')
      .digest('hex')
      .slice(0, 16);

    return {
      apiKey,
      userGuid,
      tenantId: hash,
    };
  }

  private warnOnceForUnknownState(snapshot: {
    providerState: string;
    normalizedStatus: string;
  }): void {
    const state = String(snapshot.providerState ?? '').trim();
    if (!state || snapshot.normalizedStatus !== 'unknown' || this.loggedUnknownStates.has(state)) {
      return;
    }
    this.loggedUnknownStates.add(state);
    this.logger.warn(
      `[Noest] Unmapped provider state "${state}" → unknown. Add it to noest-status.mapper.ts.`,
    );
  }

  private toStatusParcel(
    snapshot: { normalizedStatus: string; providerState?: string; timeline: any[] },
    tracking: string,
  ): DeliveryStatusParcel {
    const latest = snapshot.timeline[snapshot.timeline.length - 1];

    // The record only ever carries a platform-catalogue status: an out-of-catalogue value would
    // render as a raw slug in every carrier-status surface (and break the verifier).
    let deliveryStatus = snapshot.normalizedStatus;
    if (!isNormalizedStatus(deliveryStatus)) {
      this.logger.warn(
        `[Noest] Parcel ${tracking} produced out-of-catalogue status "${deliveryStatus}" — storing "unknown".`,
      );
      deliveryStatus = 'unknown';
    }

    return {
      parcelId: tracking,
      externalId: null,
      trackingNumber: tracking,
      deliveryStatus,
      carrierStateId: null,
      carrierStateName: latest?.event ?? snapshot.providerState ?? null,
      carrierStateDescription: latest?.description ?? null,
      carrierStateRank: null,
      carrierStateLocked: null,
      terminal: ['delivered', 'cancelled', 'returned'].includes(deliveryStatus),
      situationFlags: [],
      lastStateUpdateAt: latest?.date ?? null,
      deliveryType: null,
      situation: null,
      rawSituation: null,
      raw: snapshot,
    };
  }

  private toStatusEntries(
    timeline: Array<{
      providerEntryId: string;
      event: string;
      date: Date | null;
      location?: string;
      description?: string;
    }>,
    tracking: string,
  ): DeliveryStatusEntry[] {
    return timeline.map((entry) => ({
      providerEntryId: entry.providerEntryId,
      parcelId: tracking,
      fromState: null,
      toState: entry.event,
      fromStatus: 'unknown',
      toStatus: normalizeNoestEvent(entry.event),
      at: entry.date,
      comment: entry.description ?? null,
      hubName: entry.location ?? null,
      hubCity: null,
      hubDistrict: null,
      modifiedBy: null,
      situationFlags: [],
      situations: [],
      raw: entry,
    }));
  }
}

/**
 * Normalises `GET /api/public/get/communes/{wilaya_id}`.
 *
 * The documented shape is a **bare array** of
 * `{ nom, wilaya_id, code_postal, is_active }`, but the envelope is normalised defensively (an
 * array, an object of entries, or a `{ data: … }` wrapper) so a carrier-side change degrades to an
 * empty list instead of a crash. Inactive communes are dropped, entries for another wilaya are
 * ignored, duplicates are removed case-insensitively and the result is sorted with `fr` collation.
 *
 * There is deliberately **no** `hasStopDesk` field: Noest publishes no per-commune stop-desk
 * capability, and inventing one would gate dispatch on a value the carrier never sent.
 */
export function normalizeNoestCommunes(body: unknown, wilayaId: string): NoestCommuneOption[] {
  const root =
    body && typeof body === 'object' && !Array.isArray(body) && 'data' in (body as Record<string, unknown>)
      ? (body as Record<string, unknown>).data
      : body;

  const entries = Array.isArray(root)
    ? root
    : root && typeof root === 'object'
      ? Object.values(root as Record<string, unknown>)
      : [];

  const expectedWilaya = String(Number(wilayaId));
  const seen = new Set<string>();
  const out: NoestCommuneOption[] = [];

  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;

    const name = typeof e.nom === 'string' ? e.nom.trim() : '';
    const id = String(Number(e.wilaya_id ?? wilayaId));
    if (!name || id !== expectedWilaya) continue;
    if (e.is_active === 0 || e.is_active === '0' || e.is_active === false) continue;

    const key = name.toLocaleLowerCase('fr');
    if (seen.has(key)) continue;
    seen.add(key);

    const postalCode =
      typeof e.code_postal === 'string' && e.code_postal.trim() ? e.code_postal.trim() : null;

    out.push({ name, wilayaId: id, postalCode });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}
