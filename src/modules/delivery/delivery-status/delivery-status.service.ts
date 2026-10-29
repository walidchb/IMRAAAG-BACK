import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import {
  DELIVERY_STATUS_CONFLICT_CODE_VALUES,
  DELIVERY_STATUS_CONFLICT_CODES,
  DELIVERY_STATUS_TRACKED_ORDER_STATUSES,
  DELIVERY_STATUS_MISSING_CONFIRMATIONS,
  DeliverySyncState,
  deliveryStatusBackoffMinutes,
} from '../../../common/constants/delivery-status.const';
import { Order, OrderDocument } from '../../orders/schemas/order.schema';
import { DeliveryConfig, DeliveryConfigDocument } from '../schemas/delivery-config.schema';
import { DeliveryParcelStatusService } from '../delivery-parcel-status.service';
import { DeliveryCompanyRegistry } from '../delivery-companies/delivery-company-registry.service';
import {
  DeliveryCompanyHandler,
  DeliveryStatusContext,
  DeliveryStatusEntry,
  DeliveryStatusParcel,
} from '../delivery-companies/interfaces/delivery-company-handler.interface';
import {
  CarrierOrderPlan,
  planCarrierOrderAction,
} from './carrier/carrier-plan';
import { DELIVERED_NORMALIZED_STATUSES } from './carrier/carrier-signal';
import type {
  CarrierOrderSignal,
  DetectedCarrierOrderSignal,
  SignalOverrides,
} from './carrier/carrier-signal';
import type { CarrierStatusProfile } from './carrier/carrier-profile';
import {
  DEFAULT_CARRIER_COMPANY_ID,
  getCarrierProfile,
  listCarrierProfiles,
} from './carrier/carrier-profiles';
import { StoresService } from '../../stores/stores.service';
import { TokenBucket } from './token-bucket';
import { openTransactionSession } from '../../inventory/services/session.util';
import {
  DELIVERY_STATUS_ADVANCE,
  DeliveryStatusAdvanceOutcome,
  DeliveryStatusAdvanceResult,
} from './delivery-status-advance.interface';
import type { DeliveryStatusAdvance } from './delivery-status-advance.interface';

/** The provider slug this poller drives. The other providers are untouched (§4.3). */
const ZR_EXPRESS = DEFAULT_CARRIER_COMPANY_ID;

/**
 * The configuration block each provider reads.
 *
 * A provider missing from this map falls back to the shared `deliveryStatusSync` block — which
 * is disabled by default, so a provider that forgets an entry here is silently never polled.
 * Every provider with a `*_STATUS_SYNC_ENABLED` flag belongs in this map.
 */
const PROVIDER_SETTINGS_PREFIX: Record<string, string> = {
  [ZR_EXPRESS]: 'zrStatusSync',
  'ecom-delivery': 'ecomStatusSync',
  dhd: 'dhdStatusSync',
  noest: 'noestStatusSync',
};

/** How many parcels one discovery call asks the carrier for. */
const DISCOVERY_PAGE_SIZE = 50;

/** How many discovery pages one cycle may read for one store. */
const MAX_DISCOVERY_PAGES = 5;

/**
 * The signal a record written before `orderSignal` existed still carries.
 *
 * The delivered-only era persisted just the normalized carrier status; this mapping lets the
 * reconciliation sweep reason about those records without treating them as signal-less.
 */
const LEGACY_SIGNAL_BY_STATUS: Record<string, CarrierOrderSignal> = {
  delivered: 'delivered',
  in_transit: 'in_transit',
  cancelled: 'cancelled',
  returned: 'returned',
};

/** The result of one cycle. */
export interface DeliveryStatusCycleSummary {
  /** The cycle's id — the same id appears in every log line of the cycle. */
  cycleId: string;
  /** Why the cycle did not run, when it did not run. */
  skipped: 'in_flight' | 'lease' | null;
  /** How many stores were polled. */
  stores: number;
  /** How many parcels the carrier reported. */
  discovered: number;
  /** How many detail (state-history) calls were made. */
  detailCalls: number;
  /** How many parcels changed. */
  changed: number;
  /** How many advances were attempted. */
  advanced: number;
  /** How many advances were refused because the carrier and the order disagreed (§10.4). */
  conflicts: number;
  /** How many parcels failed. */
  failed: number;
  /** How long the cycle took. */
  durationMs: number;
}

/** The result of the reconciliation sweep. */
export interface DeliveryStatusSweepSummary {
  /** How many records were re-queued because the poller had skipped them. */
  requeued: number;
  /** How many parcel records were created for parcels that had none (the backfill). */
  backfilled: number;
  /** How many records were orphaned by an order that no longer exists. */
  orphaned: number;
  /** How many orders are waiting for an advance the carrier has already earned. */
  advanceCandidates: number;
}

/** One store the poller may poll. */
interface StoreTarget {
  storeId: string;
  /** The carrier this target is polled for. */
  companyId: string;
  vendorEmail: string | null;
  /** The store's per-tenant signal remapping for this carrier, if it configured one. */
  signalOverrides: SignalOverrides | null;
}

/** The settings of the poller (roadmap §18.1). */
interface DeliveryStatusSettings {
  enabled: boolean;
  intervalMinutes: number;
  maxCallsPerMinute: number;
  jitterRatio: number;
  terminalConfirmations: number;
  leaseSeconds: number;
  deliveredWatchDays: number;
  deliveredPollMinutes: number;
}

/**
 * The status poller (roadmap §12.2).
 *
 * One cycle, per store:
 *
 * 1. resolve the store's ZR credentials (skipped silently when there are none — §18.4);
 * 2. find the store's **open** parcels (the orders that still have one);
 * 3. one **discovery** call tells the carrier which of those parcels changed;
 * 4. for each changed parcel, one **detail** call fetches its timeline;
 * 5. the parcel-status record is written and the new timeline entries appended (idempotently);
 * 6. the order advance is *requested* through the advance seam (Phase 4 performs the write).
 *
 * Everything the poller touches is scoped by `storeId` (roadmap §18.3): the store's orders, the
 * store's parcel records, the store's configuration. A store identifier is never accepted from
 * a client — the poller is not reachable from one.
 */
@Injectable()
export class DeliveryStatusService {
  private readonly logger = new Logger(DeliveryStatusService.name);
  private readonly buckets = new Map<string, TokenBucket>();
  /** Providers with a cycle in flight. Two providers never block each other. */
  private readonly running = new Set<string>();

  /** When the last cycle finished — for the health payload (roadmap §19.3). */
  lastCycleAt: Date | null = null;
  /** When the next cycle is expected — for the health payload. */
  nextCycleAt: Date | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly registry: DeliveryCompanyRegistry,
    private readonly parcelStatus: DeliveryParcelStatusService,
    private readonly storesService: StoresService,
    @InjectModel(DeliveryConfig.name)
    private readonly configModel: Model<DeliveryConfigDocument>,
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
    @Optional()
    @Inject(DELIVERY_STATUS_ADVANCE)
    private readonly advance?: DeliveryStatusAdvance,
  ) {}

  /** The poller's settings, read from the environment (roadmap §18.1). */
  get settings(): DeliveryStatusSettings {
    return this.settingsFor(ZR_EXPRESS);
  }

  /**
   * One carrier's settings.
   *
   * A provider may keep its own block (`zrStatusSync`, `ecomStatusSync`); every value falls back
   * to the shared `deliveryStatusSync` block and then to the historical default. That keeps the
   * existing ZR environment contract and lets a new provider be enabled independently.
   */
  settingsFor(companyId: string): DeliveryStatusSettings {
    const prefix = PROVIDER_SETTINGS_PREFIX[companyId] ?? 'deliveryStatusSync';

    const read = <T>(name: string, fallback: T): T => {
      const own = this.configService.get<T>(`${prefix}.${name}`);
      if (own !== undefined && own !== null) return own;
      const shared = this.configService.get<T>(`deliveryStatusSync.${name}`);
      return shared !== undefined && shared !== null ? shared : fallback;
    };

    return {
      enabled: read<boolean>('enabled', false),
      intervalMinutes: read<number>('intervalMinutes', 15),
      maxCallsPerMinute: read<number>('maxCallsPerMinute', 20),
      jitterRatio: read<number>('jitterRatio', 0.2),
      terminalConfirmations: read<number>('terminalConfirmations', 3),
      leaseSeconds: read<number>('leaseSeconds', 120),
      deliveredWatchDays: read<number>('deliveredWatchDays', 14),
      deliveredPollMinutes: read<number>('deliveredPollMinutes', 60),
    };
  }

  /** Every registered provider whose own flag is on. */
  enabledProviders(): CarrierStatusProfile[] {
    return listCarrierProfiles().filter((profile) => this.settingsFor(profile.companyId).enabled);
  }

  /** Whether any cycle is running right now. */
  get isRunning(): boolean {
    return this.running.size > 0;
  }

  /** Whether a specific provider's cycle is running. */
  isProviderRunning(companyId: string): boolean {
    return this.running.has(companyId);
  }

  /**
   * Runs one cycle.
   *
   * The cycle is guarded twice: an in-flight flag (a slow cycle can never overlap itself) and
   * the lease (only one instance of the platform polls at a time — §12.5).
   */
  async runCycle(
    options: { storeIds?: string[]; companyId?: string } = {},
  ): Promise<DeliveryStatusCycleSummary> {
    const companyId = options.companyId ?? ZR_EXPRESS;
    const profile = getCarrierProfile(companyId);
    const cycleId = randomUUID();
    const startedAt = Date.now();

    if (!profile) {
      throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, {
        field: 'provider',
        value: companyId,
      });
    }

    if (this.running.has(companyId)) {
      this.logger.debug(
        `[${cycleId}] A ${profile.displayName} cycle is already running �?" this one stands down.`,
      );
      return {
        cycleId,
        skipped: 'in_flight',
        stores: 0,
        discovered: 0,
        detailCalls: 0,
        changed: 0,
        advanced: 0,
        conflicts: 0,
        failed: 0,
        durationMs: 0,
      };
    }

    this.running.add(companyId);
    const settings = this.settingsFor(companyId);
    try {
      const summary: DeliveryStatusCycleSummary = {
        cycleId,
        skipped: null,
        stores: 0,
        discovered: 0,
        detailCalls: 0,
        changed: 0,
        advanced: 0,
        conflicts: 0,
        failed: 0,
        durationMs: 0,
      };

      const targets = await this.resolveStores(options.storeIds, companyId);
      summary.stores = targets.length;

      for (const target of targets) {
        const result = await this.runStoreCycle(target, cycleId, settings, profile);
        summary.discovered += result.discovered;
        summary.detailCalls += result.detailCalls;
        summary.changed += result.changed;
        summary.advanced += result.advanced;
        summary.conflicts += result.conflicts;
        summary.failed += result.failed;
      }

      summary.durationMs = Date.now() - startedAt;
      this.lastCycleAt = new Date();
      this.logger.log(
        `[${cycleId}] Cycle finished: ${JSON.stringify({
          stores: summary.stores,
          discovered: summary.discovered,
          detailCalls: summary.detailCalls,
          changed: summary.changed,
          advanced: summary.advanced,
          conflicts: summary.conflicts,
          failed: summary.failed,
          durationMs: summary.durationMs,
        })}`,
      );

      return summary;
    } finally {
      this.running.delete(companyId);
    }
  }

  /**
   * The reconciliation sweep (roadmap §15.3).
   *
   * It repairs what the cycle cannot see:
   *
   * 1. records the poller silently skipped (their `lastPolledAt` is older than a few cycles);
   * 2. parcels that have a platform order but no status record — the backfill path (§15.4);
   * 3. records whose order no longer resolves — they are marked superseded;
   * 4. orders that earned an advance the cycle could not apply.
   *
   * Every query is scoped by `storeId`, store by store, exactly like the cycle.
   */
  async runSweep(
    options: { storeIds?: string[]; companyId?: string } = {},
  ): Promise<DeliveryStatusSweepSummary> {
    const companyId = options.companyId ?? ZR_EXPRESS;
    const summary: DeliveryStatusSweepSummary = {
      requeued: 0,
      backfilled: 0,
      orphaned: 0,
      advanceCandidates: 0,
    };

    const targets = await this.resolveStores(options.storeIds, companyId);
    const staleBefore = new Date(
      Date.now() - Math.max(1, this.settingsFor(companyId).intervalMinutes) * 3 * 60_000,
    );

    for (const target of targets) {
      summary.requeued += await this.requeueStale(target, staleBefore);
      summary.backfilled += await this.backfillStore(target);
      summary.orphaned += await this.orphanRecords(target);
      summary.advanceCandidates += await this.collectAdvanceCandidates(target);
    }

    this.logger.log(
      `Reconciliation sweep finished: ${JSON.stringify({
        requeued: summary.requeued,
        backfilled: summary.backfilled,
        orphaned: summary.orphaned,
        advanceCandidates: summary.advanceCandidates,
      })}`,
    );

    return summary;
  }

  /* ------------------------------------------------------------------ *
   * The cycle
   * ------------------------------------------------------------------ */

  /**
   * The stores the poller may poll.
   *
   * A store is eligible when it has a `zr-express` configuration that is not disabled. A store
   * without one is skipped **silently** (roadmap §18.4): most stores do not use ZR Express, and
   * a missing configuration is not a warning.
   */
  private async resolveStores(
    storeIds: string[] | undefined,
    companyId: string,
  ): Promise<StoreTarget[]> {
    const companyPath = `companies.${companyId}`;
    const filter: Record<string, unknown> = {
      [companyPath]: { $exists: true },
      [`${companyPath}.status`]: { $ne: 'disabled' },
    };

    const configs = await this.configModel.find(filter).lean().exec();
    const targets: StoreTarget[] = [];

    for (const config of configs) {
      const company = (config.companies ?? {})[companyId];
      if (!company || company.status === 'disabled') continue;

      // A paused store (or a paused provider) keeps its credentials but is not polled — §E5.
      if (config.statusSyncEnabled === false || company.statusSyncEnabled === false) {
        this.logger.debug(
          `Skipping store ${config.storeId ?? config.vendorEmail}: ${companyId} status sync is paused.`,
        );
        continue;
      }

      // `storeId` is canonical; a configuration written before the store-id migration is
      // resolved through the vendor's email, exactly like the rest of the platform does.
      const storeId = config.storeId
        ? String(config.storeId)
        : ((await this.storesService
            .resolveStoreIdByEmail(config.vendorEmail)
            .catch(() => null))?.toString() ?? null);

      if (!storeId) {
        this.logger.debug(
          `Skipping store with a ${companyId} configuration but no canonical store id (${config.vendorEmail}).`,
        );
        continue;
      }

      if (storeIds && storeIds.length > 0 && !storeIds.includes(storeId)) continue;

      targets.push({
        storeId,
        companyId,
        vendorEmail: config.vendorEmail ?? null,
        signalOverrides: config.statusSignalOverrides?.[companyId] ?? null,
      });
    }

    return targets;
  }

  /** One store's slice of the cycle. */
  private async runStoreCycle(
    target: StoreTarget,
    cycleId: string,
    settings: DeliveryStatusSettings,
    profile: CarrierStatusProfile,
  ): Promise<Omit<DeliveryStatusCycleSummary, 'cycleId' | 'skipped' | 'stores' | 'durationMs'>> {
    const result = {
      discovered: 0,
      detailCalls: 0,
      changed: 0,
      advanced: 0,
      conflicts: 0,
      failed: 0,
    };

    const handler = this.registry.getHandler(profile.companyId);
    if (!handler?.searchStatusParcels || !handler.fetchStatusHistory) {
      this.logger.debug(`The ${profile.displayName} handler does not expose the status capability.`);
      return result;
    }

    const tenantId = await this.resolveTenant(handler, target);
    if (!tenantId) {
      // §18.4 — a store without usable credentials is skipped silently.
      this.logger.debug(`Skipping store ${target.storeId}: no usable ${profile.displayName} credentials.`);
      return result;
    }

    const orders = await this.loadTrackedOrders(target.storeId, profile.companyId, settings);
    if (orders.length === 0) {
      this.logger.debug(`Store ${target.storeId} has no open ${profile.displayName} parcel to poll.`);
      return result;
    }

    const tracked = new Map<string, OrderDocument>();
    for (const order of orders) {
      if (order.deliveryParcelId) tracked.set(order.deliveryParcelId, order);
    }

    const records = (await this.parcelStatus.listForStore(target.storeId)).filter(
      (record) => (!record.companyId || record.companyId === target.companyId),
    );
    const recordByParcel = new Map(records.map((record) => [record.parcelId, record]));

    const context: DeliveryStatusContext = { storeId: target.storeId };
    const budget = this.bucketFor(target.companyId, tenantId);
    const watermark = this.discoveryWatermark(recordByParcel, tracked);

    this.logger.log(
      `[${cycleId}] Polling tenant ${tenantId} for store ${target.storeId}: ` +
        `${tracked.size} parcel(s) tracked, watermark ${watermark ? watermark.toISOString() : 'none'}.`,
    );

    for (let page = 1; page <= MAX_DISCOVERY_PAGES; page += 1) {
      if (!budget.tryConsume()) {
        this.logger.warn(
          `[${cycleId}] The call budget for tenant ${tenantId} is exhausted — the rest of this store waits for the next cycle.`,
        );
        break;
      }

      let search;
      try {
        search = await handler.searchStatusParcels({
          ...context,
          parcelIds: [...tracked.keys()],
          limit: DISCOVERY_PAGE_SIZE,
          page,
          updatedAfter: watermark,
        });
      } catch (error) {
        // §14.5 — a failed discovery aborts this store's cycle for this tick, and nothing else.
        this.logger.error(
          `[${cycleId}] ${profile.displayName} discovery failed for tenant ${tenantId}: ${this.describe(error)}`,
        );
        await this.backoffStore(target, records, error);
        return result;
      }

      result.discovered += search.parcels.length;

      // §E3 — the carrier explicitly told us these tracked parcels are unknown. A miss is not a
      // transport error: it does not touch the backoff ladder, but after
      // `DELIVERY_STATUS_MISSING_CONFIRMATIONS` in a row the record is parked as `not_found` and
      // stops spending calls until the carrier recognises the parcel again.
      await this.handleMissingParcels(target, tracked, recordByParcel, search.missingParcelIds);

      for (const parcel of search.parcels) {
        const order = tracked.get(parcel.parcelId);
        if (!order) {
          this.logger.debug(
            `[${cycleId}] ${profile.displayName} returned parcel ${parcel.parcelId}, which is not one of this store's tracked orders.`,
          );
          continue; // not one of ours
        }

        const record = recordByParcel.get(parcel.parcelId);
        if (this.isPollingExcluded(record)) {
          this.logger.debug(
            `[${cycleId}] ${profile.displayName} parcel ${parcel.parcelId} is excluded from polling ` +
              `(terminal=${record?.terminal}, nextEligiblePollAt=${record?.nextEligiblePollAt?.toISOString?.() ?? 'none'}).`,
          );
          continue;
        }

        // §12.4 — the platform-side cache: an unchanged parcel is never detail-polled.
        if (!this.hasChanged(record, parcel)) {
          this.logger.debug(
            `[${cycleId}] ${profile.displayName} parcel ${parcel.parcelId} is unchanged ` +
              `(carrier ${parcel.lastStateUpdateAt?.toISOString?.() ?? 'none'} <= stored ${record?.lastCarrierStateAt?.toISOString?.() ?? 'none'}).`,
          );
          continue;
        }

        if (!budget.tryConsume()) {
          this.logger.warn(
            `[${cycleId}] The call budget for tenant ${tenantId} is exhausted — the rest of this store waits for the next cycle.`,
          );
          return result;
        }

        let entries: DeliveryStatusEntry[];
        try {
          entries = await handler.fetchStatusHistory(context, parcel.parcelId);
          result.detailCalls += 1;
        } catch (error) {
          // §14.5 — a failure on one parcel never aborts the cycle.
          result.failed += 1;
          this.logger.warn(
            `[${cycleId}] ${profile.displayName} history failed for parcel ${parcel.parcelId} ` +
              `(order ${order.orderNo}): ${this.describe(error)}`,
          );
          await this.recordFailure(target, order, parcel, record, error);
          continue;
        }

        const outcome = await this.persistAndAdvance(
          target,
          order,
          parcel,
          entries,
          record,
          settings,
          profile,
        );
        result.changed += 1;

        if (outcome === 'advanced') result.advanced += 1;
        if (outcome === 'conflict') result.conflicts += 1;
        if (outcome === 'failed') result.failed += 1;
      }

      if (!search.hasNext) break;
    }

    return result;
  }

  /**
   * The discovery watermark (roadmap §12.4).
   *
   * The **oldest** watermark among the store's tracked parcels — the point in time from which
   * the carrier may have changed something we have not seen. When any tracked parcel has never
   * been polled, the watermark is `null` and the carrier's whole recent history is considered.
   */
  private discoveryWatermark(
    records: Map<string, { lastCarrierStateAt?: Date | null }>,
    tracked: Map<string, unknown>,
  ): Date | null {
    let oldest: Date | null = null;

    for (const [parcelId] of tracked) {
      const record = records.get(parcelId);
      if (!record?.lastCarrierStateAt) return null;
      if (!oldest || record.lastCarrierStateAt < oldest) oldest = record.lastCarrierStateAt;
    }

    return oldest;
  }

  /**
   * Records the parcels the carrier answered "not found" for (§E3).
   *
   * Only parcels we actually track are considered — a miss for an unknown id is ignored. The
   * miss counter rises once per cycle; the third consecutive miss parks the record as
   * `not_found` so it is no longer polled. A subsequent successful poll (the parcel reappears in
   * `search.parcels`) resets the counter through {@link persistParcel}.
   */
  private async handleMissingParcels(
    target: StoreTarget,
    tracked: Map<string, OrderDocument>,
    recordByParcel: { get(key: string): { consecutiveMisses?: number; syncState?: string } | undefined },
    missingParcelIds: string[] | undefined,
  ): Promise<void> {
    if (!missingParcelIds || missingParcelIds.length === 0) return;

    const now = new Date();

    for (const parcelId of new Set(missingParcelIds)) {
      const order = tracked.get(parcelId);
      if (!order) continue; // not one of ours

      const record = recordByParcel.get(parcelId);
      const misses = (record?.consecutiveMisses ?? 0) + 1;
      const parked = misses >= DELIVERY_STATUS_MISSING_CONFIRMATIONS;

      if (!record) {
        // The record may not exist yet (backfill aside) — create it as idle so the next cycle
        // can count the miss and eventually park it.
        await this.parcelStatus.upsertStatus({
          storeId: target.storeId,
          companyId: target.companyId,
          orderId: order._id as Types.ObjectId,
          orderNo: order.orderNo,
          parcelId,
          trackingNumber: order.deliveryParcelId ?? null,
          syncState: DeliverySyncState.IDLE,
          lastPolledAt: now,
          consecutiveMisses: misses,
        });
      } else {
        await this.parcelStatus.patchStatus(target.storeId, parcelId, {
          companyId: target.companyId,
          lastPolledAt: now,
          consecutiveMisses: misses,
          syncState: parked ? DeliverySyncState.NOT_FOUND : (record.syncState ?? DeliverySyncState.IDLE),
          nextEligiblePollAt: parked ? null : undefined,
        });
      }

      if (parked) {
        this.logger.warn(
          `Parcel ${parcelId} (order ${order.orderNo}) is unknown to the carrier after ` +
            `${misses} consecutive polls — parking the record as not_found.`,
        );
      }
    }
  }

  /** True when the parcel is beyond its polling window (terminal, or waiting for a backoff). */
  private isPollingExcluded(record: { terminal?: boolean; nextEligiblePollAt?: Date | null } | undefined): boolean {
    if (!record) return false;
    if (record.terminal) return true;
    if (record.nextEligiblePollAt && record.nextEligiblePollAt.getTime() > Date.now()) return true;
    return false;
  }

  /** True when the carrier's state moved since the platform last saw it (§12.4). */
  private hasChanged(
    record: { lastCarrierStateAt?: Date | null } | undefined,
    parcel: DeliveryStatusParcel,
  ): boolean {
    if (!record?.lastCarrierStateAt) return true;
    if (!parcel.lastStateUpdateAt) return true;
    return parcel.lastStateUpdateAt.getTime() > record.lastCarrierStateAt.getTime();
  }

  /** The store's open parcels — the orders that still have one (roadmap §15.2). */
  private async loadTrackedOrders(
    storeId: string,
    companyId: string,
    settings: DeliveryStatusSettings,
  ): Promise<OrderDocument[]> {
    // A delivered order stays pollable for the return-watch window only: a carrier can still
    // record a return after the hand-over, but a delivery from a year ago is history.
    const watchCutoff = new Date(
      Date.now() - Math.max(1, settings.deliveredWatchDays) * 86_400_000,
    );

    return this.orderModel
      .find({
        storeId: new Types.ObjectId(storeId),
        deliveryCompanyId: companyId,
        isDeleted: { $ne: true },
        'status.slug': { $in: DELIVERY_STATUS_TRACKED_ORDER_STATUSES },
        deliveryParcelId: { $exists: true, $nin: [null, ''] },
        $or: [
          { 'status.slug': { $ne: 'delivered' } },
          { updatedAt: { $gte: watchCutoff } },
        ],
      })
      .exec();
  }

  /**
   * Writes the parcel-status record and asks for the order advance, in one transaction.
   *
   * §10.3, item 4: the record of what the carrier said and the order's own status must
   * commit together. A carrier event that is recorded but never reaches the order would leave
   * the two disagreeing, and an order that moved without its carrier event would leave the
   * vendor unable to see why.
   *
   * The transaction covers exactly one parcel: a transaction that spans a whole cycle would
   * hold the datastore's write lock for the length of the carrier's slowest call.
   */
  private async persistAndAdvance(
    target: StoreTarget,
    order: OrderDocument,
    parcel: DeliveryStatusParcel,
    entries: DeliveryStatusEntry[],
    record:
      | {
          deliveryStatus?: string | null;
          lastChangedAt?: Date | null;
          terminal?: boolean;
          terminalConfirmations?: number;
        }
      | undefined,
    settings: DeliveryStatusSettings,
    profile: CarrierStatusProfile,
  ): Promise<DeliveryStatusAdvanceOutcome> {
    const signal = profile.detectSignal(parcel, entries, target.signalOverrides);
    const plan = planCarrierOrderAction(order.status?.slug ?? null, signal);

    return this.withParcelTransaction(async (session) => {
      await this.persistParcel(
        target,
        order,
        parcel,
        entries,
        record,
        signal,
        settings,
        session,
      );
      return this.requestAdvance(target, order, parcel, plan, session);
    });
  }

  /**
   * Runs one parcel's writes inside a transaction, when the datastore supports one.
   *
   * §10.3, item 4 says "where the datastore supports it": a standalone `mongod` has no
   * transactions, and refusing to sync at all there would be worse than syncing without one.
   * The fallback keeps the order the write path depends on — the carrier's record is written
   * *before* the order is advanced, so a crash can only leave the record ahead of the order,
   * and the next cycle re-applies the advance.
   */
  private async withParcelTransaction<T>(
    work: (session: ClientSession | undefined) => Promise<T>,
  ): Promise<T> {
    let session: ClientSession;
    try {
      session = await openTransactionSession(this.orderModel, this.logger);
    } catch (error) {
      const unavailable =
        error instanceof AppException &&
        (error.errorParams as Record<string, unknown> | undefined)?.reason ===
          'transactions_unavailable';
      if (!unavailable) throw error;

      this.logger.warn(
        `This datastore has no transaction support — the parcel record and the order advance ` +
          `are written one after the other instead.`,
      );
      return work(undefined);
    }

    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await work(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Writes the parcel-status record and appends the timeline.
   *
   * The timeline append is idempotent by the carrier's history-entry id (roadmap §13.1), so a
   * re-run of the cycle — or a replay after a crash — can never duplicate an entry.
   */
  private async persistParcel(
    target: StoreTarget,
    order: OrderDocument,
    parcel: DeliveryStatusParcel,
    entries: DeliveryStatusEntry[],
    record:
      | {
          deliveryStatus?: string | null;
          lastChangedAt?: Date | null;
          terminal?: boolean;
          terminalConfirmations?: number;
          returnWatchUntil?: Date | null;
          lastOrderActionAt?: Date | null;
        }
      | undefined,
    signal: DetectedCarrierOrderSignal,
    settings: DeliveryStatusSettings,
    session?: ClientSession,
  ): Promise<void> {
    const now = new Date();
    const newest = entries.length > 0 ? entries[entries.length - 1] : null;
    const changed = (record?.deliveryStatus ?? null) !== parcel.deliveryStatus;
    const delivered = DELIVERED_NORMALIZED_STATUSES.includes(
      parcel.deliveryStatus as never,
    );

    // A carrier can still record a return after the parcel was handed over, so `delivered`
    // stays pollable for the return-watch window. The window starts once and never extends.
    const watchDays = Math.max(1, settings.deliveredWatchDays);
    const returnWatchUntil = delivered
      ? (record?.returnWatchUntil ?? new Date(now.getTime() + watchDays * 86_400_000))
      : (record?.returnWatchUntil ?? null);
    const watchActive = delivered && returnWatchUntil !== null && returnWatchUntil.getTime() > now.getTime();

    const confirmations = parcel.terminal ? (record?.terminalConfirmations ?? 0) + 1 : 0;
    const terminal = delivered
      ? !watchActive &&
        (record?.terminal === true ||
          (parcel.terminal && confirmations >= settings.terminalConfirmations))
      : parcel.deliveryStatus === 'cancelled' || parcel.deliveryStatus === 'returned'
        ? true
        : record?.terminal === true ||
          (parcel.terminal && confirmations >= settings.terminalConfirmations);

    // A delivered parcel is polled slowly while the watch runs; every other successful poll
    // returns to the cycle's normal cadence.
    const nextEligiblePollAt =
      delivered && !terminal
        ? new Date(now.getTime() + Math.max(1, settings.deliveredPollMinutes) * 60_000)
        : null;

    await this.parcelStatus.upsertStatus({
      storeId: target.storeId,
      companyId: target.companyId,
      orderId: order._id as Types.ObjectId,
      orderNo: order.orderNo,
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
      lastChangedAt: changed ? now : (record?.lastChangedAt ?? null),
      lastError: null,
      consecutiveFailures: 0,
      consecutiveMisses: 0,
      nextEligiblePollAt,
      orderSignal: signal.signal,
      signalSource: signal.source,
      returnWatchUntil,
      lastOrderActionAt: record?.lastOrderActionAt ?? null,
      terminal,
      terminalConfirmations: confirmations,
    }, session);

    for (const entry of entries) {
      if (!entry.providerEntryId) continue;
      await this.parcelStatus.appendTimelineEntry(
        target.storeId,
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
        session,
        target.companyId,
      );
    }

    await this.parcelStatus.compactTimeline(target.storeId, parcel.parcelId, session);

    // §11.5 — the denormalised copy on the order, so the orders list can render a chip without
    // a join. The write is scoped by `storeId`, and the order schema carries no automatic
    // timestamps, so the vendor's optimistic-concurrency contract is untouched.
    await this.orderModel
      .updateOne(
        { storeId: order.storeId, _id: order._id },
        { $set: { deliveryStatus: parcel.deliveryStatus } },
        { session },
      )
      .exec();
  }

  /**
   * Records a failed poll (roadmap §14.3).
   *
   * The failure counter drives the backoff ladder: 5 → 15 → 30 → 60 → 120 minutes. A `429` that
   * carries a `Retry-After` header is honoured in preference, capped at 60 minutes.
   */
  private async recordFailure(
    target: StoreTarget,
    order: OrderDocument,
    parcel: DeliveryStatusParcel,
    record:
      | {
          deliveryStatus?: string | null;
          consecutiveFailures?: number;
          carrierStateId?: string | null;
          carrierStateName?: string | null;
          carrierStateDesc?: string | null;
          carrierStateRank?: number | null;
          carrierStateLocked?: boolean | null;
          situationFlags?: string[];
          deliveryType?: string | null;
          hubName?: string | null;
          hubCity?: string | null;
          hubDistrict?: string | null;
          lastCarrierStateAt?: Date | null;
          terminal?: boolean;
          terminalConfirmations?: number;
        }
      | undefined,
    error: unknown,
  ): Promise<void> {
    const now = new Date();
    const failures = (record?.consecutiveFailures ?? 0) + 1;
    const retryAfterSeconds = this.retryAfterSeconds(error);
    const waitMinutes =
      retryAfterSeconds > 0
        ? Math.min(retryAfterSeconds / 60, 60)
        : deliveryStatusBackoffMinutes(failures);

    const patch = {
      syncState: DeliverySyncState.ERROR,
      lastPolledAt: now,
      lastError: this.describe(error),
      consecutiveFailures: failures,
      nextEligiblePollAt: new Date(now.getTime() + waitMinutes * 60_000),
    };

    if (record) {
      // The record exists — only the health fields change; the parcel's state is untouched.
      await this.parcelStatus.patchStatus(target.storeId, parcel.parcelId, patch);
      return;
    }

    // The very first poll of this parcel failed: create the record so the failure is visible
    // and the backoff is honoured from now on.
    await this.parcelStatus.upsertStatus({
      storeId: target.storeId,
      companyId: target.companyId,
      orderId: order._id as Types.ObjectId,
      orderNo: order.orderNo,
      parcelId: parcel.parcelId,
      trackingNumber: parcel.trackingNumber ?? null,
      deliveryStatus: null,
      carrierStateId: null,
      carrierStateName: null,
      carrierStateDesc: null,
      carrierStateRank: null,
      carrierStateLocked: null,
      carrierTransition: null,
      situationFlags: [],
      rawSituation: null,
      deliveryType: parcel.deliveryType ?? null,
      hubName: null,
      hubCity: null,
      hubDistrict: null,
      lastCarrierStateAt: null,
      terminal: false,
      terminalConfirmations: 0,
      ...patch,
    });
  }

  /**
   * Backs off every record of a store after a failed discovery (roadmap §14.3).
   *
   * The discovery call is the tenant's heartbeat: when it fails, every parcel of that tenant is
   * delayed, so the next cycle does not hammer a carrier that is already refusing us.
   */
  private async backoffStore(
    target: StoreTarget,
    records: {
      parcelId: string;
      orderId: Types.ObjectId;
      orderNo?: string | null;
      consecutiveFailures?: number;
    }[],
    error: unknown,
  ): Promise<void> {
    const now = new Date();
    const retryAfterSeconds = this.retryAfterSeconds(error);
    const message = this.describe(error);

    for (const record of records) {
      const failures = (record.consecutiveFailures ?? 0) + 1;
      const waitMinutes =
        retryAfterSeconds > 0
          ? Math.min(retryAfterSeconds / 60, 60)
          : deliveryStatusBackoffMinutes(failures);

      await this.parcelStatus.patchStatus(target.storeId, record.parcelId, {
        syncState: DeliverySyncState.ERROR,
        lastPolledAt: now,
        lastError: message,
        consecutiveFailures: failures,
        nextEligiblePollAt: new Date(now.getTime() + waitMinutes * 60_000),
      });
    }
  }

  /**
   * Requests the order advance (roadmap §12.2, step d).
   *
   * The **decision** — which order status the carrier status implies — is the platform's; the
   * **write** is the advance provider's. When no provider is bound the intent is logged and
   * the cycle moves on: the timeline is still written, so the vendor never sees the carrier
   * and the order disagree.
   *
   * A conflict is recorded on the parcel-status record (§10.4): the carrier's event is real
   * and stays, and the order keeps the status the vendor gave it.
   */
  private async requestAdvance(
    target: StoreTarget,
    order: OrderDocument,
    parcel: DeliveryStatusParcel,
    plan: CarrierOrderPlan,
    session?: ClientSession,
  ): Promise<DeliveryStatusAdvanceOutcome> {
    const current = order.status?.slug ?? null;
    if (!plan.target || plan.steps.length === 0) return 'skipped';
    const next = plan.target;

    if (!this.advance) {
      this.logger.debug(
        `Carrier signal "${plan.signal}" implies ${current} → ${next} for order ${order.orderNo}; no advance provider is bound yet.`,
      );
      return 'skipped';
    }

    try {
      const result: DeliveryStatusAdvanceResult = await this.advance.advance(
        {
          storeId: target.storeId,
          companyId: target.companyId,
          orderId: String(order._id),
          orderNo: order.orderNo,
          parcelId: parcel.parcelId,
          fromStatus: current ?? '',
          toStatus: next,
          deliveryStatus: parcel.deliveryStatus,
          signal: plan.signal,
          target: plan.target,
          steps: plan.steps,
          inventoryAware: plan.inventoryAware,
        },
        session,
      );

      if (result.outcome === 'advanced') {
        this.logger.log(
          `Advanced order ${order.orderNo} (${target.storeId}) from ${current} to ${next} on the carrier's "${parcel.deliveryStatus}".`,
        );
        // The order followed the carrier, so any earlier disagreement is settled.
        await this.parcelStatus.patchStatus(
          target.storeId,
          parcel.parcelId,
          { conflict: null, conflictAt: null, lastOrderActionAt: new Date() },
          session,
        );
        return 'advanced';
      }

      if (result.outcome === 'conflict') {
        this.logger.warn(
          `The advance of order ${order.orderNo} (${target.storeId}) conflicted — ` +
            `the order was changed elsewhere (${result.reason ?? 'unknown reason'}).`,
        );
        await this.recordConflict(target, parcel, result.reason, session);
        return 'conflict';
      }

      return result.outcome;
    } catch (error) {
      // §14.5 — a failed advance is recorded, never fatal: the timeline write already committed.
      this.logger.warn(
        `The advance of order ${order.orderNo} (${target.storeId}) failed: ${this.describe(error)}`,
      );
      return 'failed';
    }
  }

  /**
   * Records the disagreement between the carrier and the order (roadmap §10.4).
   *
   * The carrier's event stays on the record — it happened — and the flag says the order could
   * not follow it. `order_cancelled_before_delivery` is the case the roadmap names: the vendor
   * cancelled, the carrier delivered anyway, and nobody's data was overwritten.
   */
  private async recordConflict(
    target: StoreTarget,
    parcel: DeliveryStatusParcel,
    reason: string | undefined,
    session?: ClientSession,
  ): Promise<void> {
    const code =
      reason && DELIVERY_STATUS_CONFLICT_CODE_VALUES.includes(reason)
        ? reason
        : DELIVERY_STATUS_CONFLICT_CODES.ORDER_STATUS_MOVED;

    await this.parcelStatus.patchStatus(
      target.storeId,
      parcel.parcelId,
      { conflict: code, conflictAt: new Date() },
      session,
    );
  }

  /* ------------------------------------------------------------------ *
   * The reconciliation sweep (roadmap §15.3)
   * ------------------------------------------------------------------ */

  /** Re-queues the records the poller silently skipped. */
  private async requeueStale(target: StoreTarget, staleBefore: Date): Promise<number> {
    const stale = await this.parcelStatus
      .listForStore(target.storeId)
      .then((records) =>
        records.filter(
          (record) =>
            (!record.companyId || record.companyId === target.companyId) &&
            record.lastPolledAt &&
            record.lastPolledAt.getTime() < staleBefore.getTime() &&
            record.nextEligiblePollAt &&
            record.nextEligiblePollAt.getTime() <= Date.now(),
        ),
      );

    for (const record of stale) {
      await this.parcelStatus.patchStatus(target.storeId, record.parcelId, {
        syncState: DeliverySyncState.IDLE,
        nextEligiblePollAt: null,
      });
    }

    return stale.length;
  }

  /**
   * Creates the missing records (roadmap §15.4).
   *
   * Only for orders that are still open and already have a carrier parcel: a delivery that
   * completed before the feature existed is not backfilled.
   */
  private async backfillStore(target: StoreTarget): Promise<number> {
    const orders = await this.loadTrackedOrders(
      target.storeId,
      target.companyId,
      this.settingsFor(target.companyId),
    );
    if (orders.length === 0) return 0;

    const records = (await this.parcelStatus.listForStore(target.storeId)).filter(
      (record) => (!record.companyId || record.companyId === target.companyId),
    );
    const known = new Set(records.map((record) => record.parcelId));

    let created = 0;
    for (const order of orders) {
      if (!order.deliveryParcelId || known.has(order.deliveryParcelId)) continue;

      await this.parcelStatus.upsertStatus({
        storeId: target.storeId,
        companyId: target.companyId,
        orderId: order._id as Types.ObjectId,
        orderNo: order.orderNo,
        parcelId: order.deliveryParcelId,
        syncState: DeliverySyncState.IDLE,
        nextEligiblePollAt: null,
      });
      created += 1;
    }

    return created;
  }

  /**
   * Marks the records that no longer speak for their order as superseded.
   *
   * Two cases, both from §10.4:
   *
   * - the order no longer resolves (it was deleted, or it left the store);
   * - the order was **re-dispatched**: it now carries a different parcel id, so the old
   *   parcel's record describes a shipment the platform no longer follows. The new parcel id
   *   wins, and the old record is retired rather than left to look current.
   */
  private async orphanRecords(target: StoreTarget): Promise<number> {
    const records = (await this.parcelStatus.listForStore(target.storeId)).filter(
      (record) => (!record.companyId || record.companyId === target.companyId),
    );
    let orphaned = 0;

    for (const record of records) {
      if (record.syncState === DeliverySyncState.SUPERSEDED) continue;

      const order = await this.orderModel
        .findOne({ storeId: new Types.ObjectId(target.storeId), _id: record.orderId })
        .select('_id status deliveryParcelId')
        .lean()
        .exec();

      if (!order) {
        await this.parcelStatus.patchStatus(target.storeId, record.parcelId, {
          syncState: DeliverySyncState.SUPERSEDED,
          nextEligiblePollAt: null,
          lastError: 'The order no longer exists.',
        });
        orphaned += 1;
        continue;
      }

      const currentParcelId = (order as { deliveryParcelId?: unknown } | null)?.deliveryParcelId;
      if (currentParcelId && String(currentParcelId) !== String(record.parcelId)) {
        await this.parcelStatus.patchStatus(target.storeId, record.parcelId, {
          syncState: DeliverySyncState.SUPERSEDED,
          nextEligiblePollAt: null,
          lastError: 'The order was re-dispatched under a new parcel.',
        });
        orphaned += 1;
      }
    }


    return orphaned;
  }

  /**
   * The orders the carrier has already delivered but that never advanced.
   *
   * The advance itself belongs to the advance provider (Phase 4); the sweep only counts the
   * candidates so the health payload can show them.
   */
  private async collectAdvanceCandidates(target: StoreTarget): Promise<number> {
    const orders = await this.orderModel
      .find({
        storeId: new Types.ObjectId(target.storeId),
        deliveryCompanyId: target.companyId,
        isDeleted: { $ne: true },
        'status.slug': { $in: ['dispatched', 'in-transit', 'delivered'] },
      })
      .select('_id orderNo status deliveryParcelId')
      .lean()
      .exec();

    if (orders.length === 0) return 0;

    const records = (await this.parcelStatus.listForStore(target.storeId)).filter(
      (record) => (!record.companyId || record.companyId === target.companyId),
    );
    const recordByParcel = new Map(records.map((record) => [record.parcelId, record]));

    let candidates = 0;
    for (const order of orders) {
      if (!order.deliveryParcelId) continue;
      const record = recordByParcel.get(order.deliveryParcelId);
      if (!record?.deliveryStatus) continue;

      const signal =
        (record.orderSignal as CarrierOrderSignal | null | undefined) ??
        LEGACY_SIGNAL_BY_STATUS[record.deliveryStatus] ??
        'none';
      const plan = planCarrierOrderAction(order.status?.slug ?? null, signal);
      if (!plan.target || plan.steps.length === 0) continue;
      candidates += 1;
    }

    return candidates;
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  /** The tenant of a store, or `null` when it has no usable credentials. */
  private async resolveTenant(
    handler: DeliveryCompanyHandler,
    target: StoreTarget,
  ): Promise<string | null> {
    if (!handler.resolveStatusTenant) return null;
    try {
      return await handler.resolveStatusTenant({ storeId: target.storeId });
    } catch {
      return null;
    }
  }

  /** The call budget of a tenant (roadmap §12.5). */
  private bucketFor(companyId: string, tenantId: string): TokenBucket {
    const key = `${companyId}:${tenantId}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(Math.max(1, this.settingsFor(companyId).maxCallsPerMinute));
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  /** The `Retry-After` a rate-limited response asked for, in seconds. */
  private retryAfterSeconds(error: unknown): number {
    if (!(error instanceof AppException)) return 0;
    const value = Number(error.errorParams?.retryAfterSeconds ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  /** A short, loggable description of an error. Never includes a credential. */
  private describe(error: unknown): string {
    if (error instanceof AppException) return `${error.errorCode}`;
    if (error instanceof Error) return error.message;
    return 'unknown error';
  }
}
