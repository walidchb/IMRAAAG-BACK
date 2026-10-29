import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { DeliverySyncState } from '../../../common/constants/delivery-status.const';
import { Order, OrderDocument } from '../../orders/schemas/order.schema';
import { DeliveryConfig, DeliveryConfigDocument } from '../schemas/delivery-config.schema';
import { DeliveryParcelStatusService } from '../delivery-parcel-status.service';
import { DeliveryCompanyRegistry } from '../delivery-companies/delivery-company-registry.service';
import {
  DeliveryStatusContext,
  DeliveryStatusEntry,
  DeliveryStatusParcel,
} from '../delivery-companies/interfaces/delivery-company-handler.interface';
import {
  CARRIER_ORDER_SIGNALS,
  DELIVERED_NORMALIZED_STATUSES,
  type CarrierOrderSignal,
  type StateOverrides,
} from './carrier/carrier-signal';
import { planCarrierOrderAction } from './carrier/carrier-plan';
import { DEFAULT_CARRIER_COMPANY_ID, getCarrierProfile } from './carrier/carrier-profiles';
import { StoresService } from '../../stores/stores.service';
import {
  DeliveryOrderEvent,
  DeliveryTimelineItem,
  buildMergedTimeline,
  normalizeCurrentSituation,
} from './delivery-status-view';

/** The provider slug the manual refresh drives. */
const ZR_EXPRESS = DEFAULT_CARRIER_COMPANY_ID;

/** How many parcels one discovery call asks the carrier for during a manual refresh. */
const REFRESH_PAGE_SIZE = 50;

/** How many carrier calls one manual refresh may make. */
const REFRESH_MAX_PAGES = 2;

/** The order's own status, as the vendor sees it. */
export interface DeliveryStatusOrderView {
  id: string;
  orderNo: string;
  status: {
    slug: string | null;
    displayName: string | null;
    nameEn: string | null;
    nameFr: string | null;
    nameAr: string | null;
    color: string | null;
  } | null;
  deliveryCompanyId: string | null;
  deliveryParcelId: string | null;
}

/** The carrier's view of the parcel. */
export interface DeliveryStatusParcelView {
  parcelId: string;
  companyId: string;
  trackingNumber: string | null;
  /** The normalized, provider-neutral delivery status (§8.2). */
  deliveryStatus: string | null;
  terminal: boolean;
  deliveryType: string | null;
  carrierState: {
    id: string | null;
    name: string | null;
    description: string | null;
    rank: number | null;
    locked: boolean | null;
  } | null;
  hub: { name: string | null; city: string | null; district: string | null } | null;
  situation: { slug: string | null; name: string | null; description: string | null } | null;
  situationFlags: string[];
}

/** The poller's view of the record's health. */
export interface DeliveryStatusSyncView {
  state: string;
  lastPolledAt: Date | null;
  lastChangedAt: Date | null;
  nextEligiblePollAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  conflict: string | null;
  conflictAt: Date | null;
  timelineTruncated: boolean;
}

  /**
   * The whole vendor-facing view of one order's delivery.
   */
export interface DeliveryStatusView {
  order: DeliveryStatusOrderView | null;
  parcel: DeliveryStatusParcelView | null;
  sync: DeliveryStatusSyncView | null;
  /** The merged timeline (§8.4), oldest first. */
  timeline: DeliveryTimelineItem[];
  /**
   * The order status the carrier's current signal **implies** — advisory only.
   *
   * This is the planner's target, so it can now be `in-transit`, `delivered`, `cancelled` or
   * `returned`. `null` when the carrier's signal moves nothing (or the order is already there).
   */
  impliedOrderStatus: string | null;
  /**
   * The first legal step the platform will write **next** — advisory only.
   *
   * A delivered parcel on a `dispatched` order writes `in-transit` first; a cancellation or a
   * carrier return writes its target directly.
   */
  nextOrderStatus: string | null;
  /** The detected carrier signal, as persisted by the poller. */
  orderSignal: CarrierOrderSignal | null;
  /** What produced that signal: `state`, `situation` or `override`. */
  signalSource: string | null;
  /** When the platform last moved the order from this parcel. */
  lastOrderActionAt: Date | null;
  /** The end of the post-delivery return watch, while it is still running. */
  returnWatchUntil: Date | null;
}

/** One store's sync health (§19.3). */
export interface DeliverySyncStoreHealth {
  storeId: string;
  /** The carrier this store's health describes. */
  provider: string;
  tenantId: string | null;
  enabled: boolean;
  trackedParcels: number;
  byDeliveryStatus: Record<string, number>;
  errors24h: number;
  unknownStates24h: number;
  notFoundParcels: number;
  lockedParcels: number;
  stalledParcels: number;
  lastSuccessAt: Date | null;
  nextEligiblePollAt: Date | null;
}

/** The whole sync-health payload (§19.3). */
export interface DeliverySyncHealth {
  enabled: boolean;
  /** The carrier this payload describes (or the requested one). */
  provider: string;
  intervalMinutes: number;
  lastCycleAt: Date | null;
  nextCycleAt: Date | null;
  stores: DeliverySyncStoreHealth[];
  totals: {
    provider: string;
    trackedParcels: number;
    inError: number;
    unknownState: number;
    notFound: number;
    locked: number;
    stalled: number;
    terminal: number;
  };
}

/**
 * The **read** half of the status sync (roadmap Phase 5).
 *
 * Everything a vendor (or an operator) can see about the carrier's view of a parcel:
 * the normalized status, the merged timeline, the sync health.
 *
 * Two rules hold everywhere in this service:
 *
 * 1. **The store comes from the session.** No method takes a client-supplied store identity,
 *    and every read is scoped by `storeId`. A parcel that belongs to another store simply does
 *    not exist here — it answers 404, never someone else's data.
 * 2. **The read never moves an order.** The manual refresh re-reads the carrier and updates
 *    the parcel record; the *advance* stays the poller's job, so a vendor pressing a button
 *    can never change an order's status behind the platform's back.
 */
@Injectable()
export class DeliveryStatusQueryService {
  private readonly logger = new Logger(DeliveryStatusQueryService.name);

  constructor(
    private readonly parcelStatus: DeliveryParcelStatusService,
    private readonly registry: DeliveryCompanyRegistry,
    private readonly storesService: StoresService,
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
    @InjectModel(DeliveryConfig.name)
    private readonly configModel: Model<DeliveryConfigDocument>,
  ) {}

  /* ------------------------------------------------------------------ *
   * The order's view
   * ------------------------------------------------------------------ */

  /**
   * The delivery status of one order.
   *
   * `null` when the order does not exist **or** belongs to another store — the two are
   * deliberately indistinguishable, so a caller cannot probe another store's order ids.
   */
  async getOrderView(
    storeId: string,
    orderId: string,
    vendorEmail?: string | null,
  ): Promise<DeliveryStatusView | null> {
    const order = await this.orderModel
      .findOne({ _id: orderId, isDeleted: { $ne: true } })
      .lean()
      .exec();

    if (!order) return null;
    if (!this.belongsToStore(order, storeId, vendorEmail)) return null;

    return this.buildView(order, storeId);
  }

  /** The delivery status of one parcel. `null` when the store does not own it. */
  async getParcelView(
    storeId: string,
    parcelId: string,
    vendorEmail?: string | null,
  ): Promise<DeliveryStatusView | null> {
    const record = await this.parcelStatus.findOne(storeId, parcelId);
    if (!record) return null;

    const order = await this.orderModel
      .findOne({ _id: record.orderId })
      .lean()
      .exec();

    if (!order) {
      // The record outlived its order (deleted, or the order left the store). The carrier's
      // own view is still worth showing — but the order block stays empty.
      return this.buildView(null, storeId, record);
    }

    if (!this.belongsToStore(order, storeId, vendorEmail)) return null;

    return this.buildView(order, storeId, record);
  }

  /* ------------------------------------------------------------------ *
   * The manual refresh (§16.3)
   * ------------------------------------------------------------------ */

  /**
   * Re-reads the carrier's timeline for one parcel and returns the merged view.
   *
   * The refresh **never** advances an order: it updates the carrier's own record, and the
   * poller applies the order's next step on its own schedule (roadmap §12.2). The refresh
   * shows the vendor the truth immediately; it does not act on it.
   */
  async refreshParcel(
    storeId: string,
    parcelId: string,
    vendorEmail?: string | null,
  ): Promise<DeliveryStatusView | null> {
    const record = await this.parcelStatus.findOne(storeId, parcelId);
    if (!record) return null;

    const handler = this.registry.getHandler(record.companyId);
    if (!handler?.searchStatusParcels || !handler.fetchStatusHistory) {
      throw new AppException(AppErrorCode.DELIVERY_STATUS_SYNC_FAILED, {
        company: record.companyId,
        reason: 'status_capability_unavailable',
      });
    }

    const context: DeliveryStatusContext = { storeId };

    const parcel = await this.findParcel(
      (ctx) => handler.searchStatusParcels!(ctx),
      context,
      record,
    );
    if (!parcel) {
      throw new AppException(AppErrorCode.DELIVERY_STATUS_NOT_FOUND, {
        parcelId,
        storeId,
        reason: 'parcel_not_reported_by_carrier',
      });
    }

    const entries = await handler.fetchStatusHistory(context, parcel.parcelId);
    await this.persistRefresh(storeId, record, parcel, entries);

    const order = await this.orderModel
      .findOne({ _id: record.orderId })
      .lean()
      .exec();

    if (order && !this.belongsToStore(order, storeId, vendorEmail)) return null;

    return this.buildView(order ?? null, storeId, record);
  }

  /* ------------------------------------------------------------------ *
   * The sync health (§19.3)
   * ------------------------------------------------------------------ */

  /**
   * The sync health.
   *
   * `storeIds` scopes the answer: an admin sees every store, a vendor sees only their own.
   * The payload never contains a credential — only the tenant id, which the roadmap treats as
   * an identifier rather than a secret (§18.2).
   */
  async getHealth(
    storeIds: string[] | null,
    options: {
      enabled: boolean;
      intervalMinutes: number;
      lastCycleAt: Date | null;
      nextCycleAt: Date | null;
      companyId?: string;
    },
  ): Promise<DeliverySyncHealth> {
    const companyId = options.companyId ?? ZR_EXPRESS;
    const storeIdsInScope = await this.resolveScopedStoreIds(storeIds, companyId);
    const stores: DeliverySyncStoreHealth[] = [];

    const totals = {
      provider: companyId,
      trackedParcels: 0,
      inError: 0,
      unknownState: 0,
      notFound: 0,
      locked: 0,
      stalled: 0,
      terminal: 0,
    };

    for (const storeId of storeIdsInScope) {
      const health = await this.storeHealth(storeId, options.intervalMinutes, companyId);
      stores.push(health);

      totals.trackedParcels += health.trackedParcels;
      totals.inError += health.errors24h;
      totals.unknownState += health.unknownStates24h;
      totals.notFound += health.notFoundParcels;
      totals.locked += health.lockedParcels;
      totals.stalled += health.stalledParcels;
    }

    const allSummaries = await this.parcelStatus.listSummariesForStores(storeIdsInScope);
    totals.terminal = allSummaries.filter(
      (summary) => (!summary.companyId || summary.companyId === companyId) && summary.terminal,
    ).length;

    return {
      enabled: options.enabled,
      provider: companyId,
      intervalMinutes: options.intervalMinutes,
      lastCycleAt: options.lastCycleAt,
      nextCycleAt: options.nextCycleAt,
      stores,
      totals,
    };
  }

  /* ------------------------------------------------------------------ *
   * Internals
   * ------------------------------------------------------------------ */

  /**
   * True when the order belongs to the store.
   *
   * `storeId` is authoritative. The `vendorEmail` comparison is the legacy fallback, used
   * only for an order written before the store-id migration (it has no `storeId` at all).
   */
  private belongsToStore(
    order: { storeId?: unknown; vendorEmail?: unknown },
    storeId: string,
    vendorEmail?: string | null,
  ): boolean {
    if (order.storeId) return String(order.storeId) === String(storeId);
    if (!vendorEmail) return false;
    const owner = typeof order.vendorEmail === 'string' ? order.vendorEmail : null;
    return Boolean(owner && owner.toLowerCase() === vendorEmail.toLowerCase());
  }

  /** Builds the whole view for one order (and, when it exists, its parcel record). */
  private async buildView(
    order: any,
    storeId: string,
    existingRecord?: { parcelId: string; companyId?: string } | null,
  ): Promise<DeliveryStatusView> {
    const parcelId =
      (typeof order?.deliveryParcelId === 'string' && order.deliveryParcelId) ||
      existingRecord?.parcelId ||
      null;

    const record = parcelId ? await this.parcelStatus.findOne(storeId, parcelId) : null;
    const companyId =
      record?.companyId ??
      existingRecord?.companyId ??
      order?.deliveryCompanyId ??
      ZR_EXPRESS;
    const profile = getCarrierProfile(companyId);
    const overrides = await this.overridesFor(storeId, companyId);

    const orderEvents: DeliveryOrderEvent[] = this.orderEvents(order);
    const timeline = buildMergedTimeline(
      orderEvents,
      record?.timeline ?? [],
      overrides,
      profile,
    );

    const orderStatusSlug = this.orderStatusSlug(order);
    const signal = this.signalFor(record);
    const plan = signal ? planCarrierOrderAction(orderStatusSlug, signal) : null;

    return {
      order: order ? this.orderView(order) : null,
      parcel: record ? this.parcelView(record) : null,
      sync: record ? this.syncView(record) : null,
      timeline,
      impliedOrderStatus: plan?.target ?? null,
      nextOrderStatus: plan?.steps[0] ?? null,
      orderSignal: signal,
      signalSource: record?.signalSource ?? null,
      lastOrderActionAt: record?.lastOrderActionAt ?? null,
      returnWatchUntil: record?.returnWatchUntil ?? null,
    };
  }

  /**
   * The signal the poller detected for this record.
   *
   * New records always carry it. A record written before the signal field existed falls back to
   * the normalized status for the three terminal outcomes only — an in-flight record with no
   * signal stays `none`, so the view never invents an advance.
   */
  private signalFor(record: any): CarrierOrderSignal | null {
    if (!record) return null;
    const stored = record.orderSignal;
    if (CARRIER_ORDER_SIGNALS.includes(stored)) return stored as CarrierOrderSignal;
    const normalized = record.deliveryStatus;
    if (normalized === 'cancelled' || normalized === 'returned' || normalized === 'delivered') {
      return normalized;
    }
    return null;
  }

  /** The order-status events of one order, in the shape the merge rule needs. */
  private orderEvents(order: unknown): DeliveryOrderEvent[] {
    const history = (order as { history?: unknown })?.history;
    if (!Array.isArray(history)) return [];

    const events: DeliveryOrderEvent[] = [];
    for (const entry of history) {
      const status = (entry as { status?: unknown })?.status;
      const slug =
        typeof status === 'string'
          ? status
          : ((status as { slug?: unknown })?.slug as string | undefined) ?? null;
      const displayName =
        typeof status === 'string'
          ? null
          : ((status as { displayName?: unknown })?.displayName as string | undefined) ?? null;

      events.push({
        slug,
        displayName,
        date: (entry as { date?: unknown })?.date ? new Date((entry as { date: Date }).date) : null,
        user: ((entry as { user?: unknown })?.user as string | undefined) ?? null,
      });
    }

    return events;
  }

  /** The order block of the view. */
  private orderView(order: any): DeliveryStatusOrderView {
    const status = order.status ?? null;
    const statusObject =
      status && typeof status === 'object'
        ? {
            slug: (status.slug as string | undefined) ?? null,
            displayName: (status.displayName as string | undefined) ?? null,
            nameEn: (status.nameEn as string | undefined) ?? null,
            nameFr: (status.nameFr as string | undefined) ?? null,
            nameAr: (status.nameAr as string | undefined) ?? null,
            color: (status.color as string | undefined) ?? null,
          }
        : null;

    return {
      id: String(order._id),
      orderNo: order.orderNo ?? '',
      status: statusObject,
      deliveryCompanyId: order.deliveryCompanyId ?? null,
      deliveryParcelId: order.deliveryParcelId ?? null,
    };
  }

  /** The parcel block of the view. */
  private parcelView(record: any): DeliveryStatusParcelView {
    return {
      parcelId: record.parcelId,
      companyId: record.companyId,
      trackingNumber: record.trackingNumber ?? null,
      deliveryStatus: record.deliveryStatus ?? null,
      terminal: record.terminal === true,
      deliveryType: record.deliveryType ?? null,
      carrierState: record.carrierStateName
        ? {
            id: record.carrierStateId ?? null,
            name: record.carrierStateName,
            description: record.carrierStateDesc ?? null,
            rank: record.carrierStateRank ?? null,
            locked: record.carrierStateLocked ?? null,
          }
        : null,
      hub:
        record.hubName || record.hubCity || record.hubDistrict
          ? {
              name: record.hubName ?? null,
              city: record.hubCity ?? null,
              district: record.hubDistrict ?? null,
            }
          : null,
      situation: normalizeCurrentSituation(record.rawSituation),
      situationFlags: Array.isArray(record.situationFlags) ? record.situationFlags : [],
    };
  }

  /** The sync block of the view. */
  private syncView(record: any): DeliveryStatusSyncView {
    return {
      state: record.syncState ?? DeliverySyncState.IDLE,
      lastPolledAt: record.lastPolledAt ?? null,
      lastChangedAt: record.lastChangedAt ?? null,
      nextEligiblePollAt: record.nextEligiblePollAt ?? null,
      lastError: record.lastError ?? null,
      consecutiveFailures: record.consecutiveFailures ?? 0,
      conflict: record.conflict ?? null,
      conflictAt: record.conflictAt ?? null,
      timelineTruncated: record.timelineTruncated === true,
    };
  }

  /** The order's own status slug — the platform's order machine, never the carrier's. */
  private orderStatusSlug(order: unknown): string | null {
    const status = (order as { status?: unknown })?.status;
    if (typeof status === 'string') return status;
    const slug = (status as { slug?: unknown })?.slug;
    return typeof slug === 'string' ? slug : null;
  }

  /** The store's per-tenant state remapping (§11.3). */
  private async overridesFor(
    storeId: string,
    companyId: string = ZR_EXPRESS,
  ): Promise<StateOverrides | null> {
    const config = await this.configModel
      .findOne({ storeId: new Types.ObjectId(storeId) })
      .lean()
      .exec();

    const overrides = config?.statusStateOverrides?.[companyId];
    return overrides ?? null;
  }

  /**
   * Finds the parcel the carrier knows about.
   *
   * The discovery call is filtered by our own order number (the reference the platform sent
   * at creation) and the result is matched on the parcel id. When the record carries no order
   * number the call is unfiltered and the parcel id is matched directly.
   */
  private async findParcel(
    searchStatusParcels: (
      context: DeliveryStatusContext,
    ) => Promise<{ parcels: DeliveryStatusParcel[]; hasNext: boolean }>,
    context: DeliveryStatusContext,
    record: { parcelId: string; orderNo?: string | null },
  ): Promise<DeliveryStatusParcel | null> {
    for (let page = 1; page <= REFRESH_MAX_PAGES; page += 1) {
      const search = await searchStatusParcels({
        ...context,
        limit: REFRESH_PAGE_SIZE,
        page,
        parcelIds: record.parcelId ? [record.parcelId] : undefined,
        externalIds: record.orderNo ? [record.orderNo] : undefined,
      });

      const match = search.parcels.find((parcel) => parcel.parcelId === record.parcelId);
      if (match) return match;
      if (!search.hasNext) break;
    }

    return null;
  }

  /**
   * Writes what the refresh learned.
   *
   * The record is updated with the carrier's current state and the new timeline entries are
   * appended idempotently (by the carrier's own entry id), so a refresh can be pressed twice
   * without duplicating a single line.
   */
  private async persistRefresh(
    storeId: string,
    record: { parcelId: string; orderId: Types.ObjectId; orderNo?: string | null; companyId: string },
    parcel: DeliveryStatusParcel,
    entries: DeliveryStatusEntry[],
  ): Promise<void> {
    const now = new Date();
    const newest = entries.length > 0 ? entries[entries.length - 1] : null;

    const existing = await this.parcelStatus.findOne(storeId, record.parcelId);
    const changed = (existing?.deliveryStatus ?? null) !== parcel.deliveryStatus;
    const delivered = DELIVERED_NORMALIZED_STATUSES.includes(
      parcel.deliveryStatus as never,
    );

    await this.parcelStatus.upsertStatus({
      storeId,
      companyId: record.companyId,
      orderId: record.orderId,
      orderNo: record.orderNo ?? null,
      parcelId: parcel.parcelId,
      trackingNumber: parcel.trackingNumber ?? null,
      deliveryStatus: parcel.deliveryStatus,
      carrierStateId: parcel.carrierStateId ?? null,
      carrierStateName: parcel.carrierStateName ?? null,
      carrierStateDesc: parcel.carrierStateDescription ?? null,
      carrierStateRank: parcel.carrierStateRank ?? null,
      carrierStateLocked: parcel.carrierStateLocked ?? null,
      carrierTransition: null,
      situationFlags: parcel.situationFlags ?? [],
      rawSituation: (parcel.rawSituation as Record<string, unknown> | null) ?? null,
      deliveryType: parcel.deliveryType ?? null,
      hubName: newest?.hubName ?? null,
      hubCity: newest?.hubCity ?? null,
      hubDistrict: newest?.hubDistrict ?? null,
      lastCarrierStateAt: parcel.lastStateUpdateAt ?? null,
      syncState: DeliverySyncState.SYNCED,
      lastPolledAt: now,
      lastChangedAt: changed ? now : (existing?.lastChangedAt ?? null),
      lastError: null,
      consecutiveFailures: 0,
      // A manual refresh never owns the poll cadence or the return watch: those belong to the
      // poller. Preserving them keeps a vendor's refresh from closing a delivered parcel's
      // return window or blanking the signal/advance bookkeeping.
      nextEligiblePollAt: delivered ? (existing?.nextEligiblePollAt ?? null) : null,
      orderSignal: existing?.orderSignal ?? null,
      signalSource: existing?.signalSource ?? null,
      returnWatchUntil: existing?.returnWatchUntil ?? null,
      lastOrderActionAt: existing?.lastOrderActionAt ?? null,
      terminal: delivered
        ? existing?.terminal === true
        : parcel.deliveryStatus === 'cancelled' || parcel.deliveryStatus === 'returned'
          ? true
          : existing?.terminal === true || parcel.terminal,
      terminalConfirmations: existing?.terminalConfirmations ?? 0,
    });

    for (const entry of entries) {
      if (!entry.providerEntryId) continue;
      await this.parcelStatus.appendTimelineEntry(
        storeId,
        parcel.parcelId,
        {
          providerEntryId: entry.providerEntryId,
          fromState: entry.fromState ?? null,
          toState: entry.toState || parcel.carrierStateName || 'unknown',
          transitionName: null,
          at: entry.at ?? now,
          comment: entry.comment ?? null,
          hubName: entry.hubName ?? null,
          modifiedBy: entry.modifiedBy ?? null,
          situations: (entry.situations ?? []).map((situation) => ({
            slug: situation.slug ?? null,
            name: situation.name ?? null,
            description: situation.description ?? null,
            at: entry.at ?? null,
          })),
        },
        undefined,
        record.companyId,
      );
    }

    await this.parcelStatus.compactTimeline(storeId, parcel.parcelId);

    // The denormalised chip on the order (§11.5) — the carrier's status, never the order's.
    await this.orderModel
      .updateOne(
        { storeId: new Types.ObjectId(storeId), _id: record.orderId },
        { $set: { deliveryStatus: parcel.deliveryStatus } },
      )
      .exec();
  }

  /**
   * The stores the health payload covers.
   *
   * **A scope is a scope.** When the caller names the stores (`storeIds`), exactly those are
   * covered — a vendor's health never widens to another store, whatever the database holds.
   *
   * Without a scope the answer covers every store that has a `zr-express` configuration that is
   * not disabled, plus every store that owns a parcel record (its records are the truth, even
   * if the configuration was removed later).
   */
  private async resolveScopedStoreIds(
    storeIds: string[] | null,
    companyId: string = ZR_EXPRESS,
  ): Promise<string[]> {
    if (storeIds) {
      return Array.from(new Set(storeIds.map((storeId) => String(storeId))));
    }

    const ids = new Set<string>();
    const companyPath = `companies.${companyId}`;

    const configs = await this.configModel
      .find({
        [companyPath]: { $exists: true },
        [`${companyPath}.status`]: { $ne: 'disabled' },
      })
      .lean()
      .exec();

    for (const config of configs) {
      const company = (config.companies ?? {})[companyId];
      if (!company || company.status === 'disabled') continue;

      const storeId = config.storeId
        ? String(config.storeId)
        : ((await this.storesService
            .resolveStoreIdByEmail(config.vendorEmail)
            .catch(() => null))?.toString() ?? null);

      if (storeId) ids.add(storeId);
    }

    for (const storeId of await this.parcelStatus.listStoreIds()) {
      ids.add(String(storeId));
    }

    return Array.from(ids);
  }

  /** One store's health. */
  private async storeHealth(
    storeId: string,
    intervalMinutes: number,
    companyId: string = ZR_EXPRESS,
  ): Promise<DeliverySyncStoreHealth> {
    const summaries = await this.parcelStatus.listSummariesForStore(storeId);
    const active = summaries.filter(
      (summary) =>
        (!summary.companyId || summary.companyId === companyId) &&
        summary.syncState !== DeliverySyncState.SUPERSEDED,
    );

    const byDeliveryStatus: Record<string, number> = {};
    let errors24h = 0;
    let unknownStates24h = 0;
    let notFoundParcels = 0;
    let lockedParcels = 0;
    let stalledParcels = 0;
    let lastSuccessAt: Date | null = null;
    let nextEligiblePollAt: Date | null = null;

    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const stalledBefore = Date.now() - Math.max(1, intervalMinutes) * 3 * 60_000;

    for (const summary of active) {
      const status = summary.deliveryStatus ?? 'unknown';
      byDeliveryStatus[status] = (byDeliveryStatus[status] ?? 0) + 1;

      const polledRecently =
        summary.lastPolledAt instanceof Date && summary.lastPolledAt.getTime() >= dayAgo;

      if (summary.syncState === DeliverySyncState.ERROR && polledRecently) errors24h += 1;
      if (summary.syncState === DeliverySyncState.NOT_FOUND) notFoundParcels += 1;
      if (status === 'unknown' && polledRecently) unknownStates24h += 1;
      if (summary.carrierStateLocked === true) lockedParcels += 1;

      if (
        !summary.terminal &&
        summary.lastPolledAt instanceof Date &&
        summary.lastPolledAt.getTime() < stalledBefore
      ) {
        stalledParcels += 1;
      }

      if (summary.syncState === DeliverySyncState.SYNCED && summary.lastPolledAt instanceof Date) {
        if (!lastSuccessAt || summary.lastPolledAt.getTime() > lastSuccessAt.getTime()) {
          lastSuccessAt = summary.lastPolledAt;
        }
      }

      if (summary.nextEligiblePollAt instanceof Date) {
        if (!nextEligiblePollAt || summary.nextEligiblePollAt.getTime() < nextEligiblePollAt.getTime()) {
          nextEligiblePollAt = summary.nextEligiblePollAt;
        }
      }
    }

    const handler = this.registry.getHandler(companyId);
    const tenantId = handler?.resolveStatusTenant
      ? await handler.resolveStatusTenant({ storeId }).catch(() => null)
      : null;

    const config = await this.configModel
      .findOne({ storeId: new Types.ObjectId(storeId) })
      .lean()
      .exec();
    const company = config?.companies?.[companyId];
    const enabled =
      Boolean(company) &&
      company?.status !== 'disabled' &&
      config?.statusSyncEnabled !== false &&
      company?.statusSyncEnabled !== false;

    return {
      storeId,
      provider: companyId,
      tenantId: tenantId ?? null,
      enabled,
      trackedParcels: active.length,
      byDeliveryStatus,
      errors24h,
      unknownStates24h,
      notFoundParcels,
      lockedParcels,
      stalledParcels,
      lastSuccessAt,
      nextEligiblePollAt,
    };
  }
}
