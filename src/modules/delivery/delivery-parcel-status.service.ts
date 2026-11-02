import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import {
  DELIVERY_TIMELINE_MAX_ENTRIES,
  DeliverySyncState,
} from '../../common/constants/delivery-status.const';
import {
  DeliveryParcelStatus,
  DeliveryParcelStatusDocument,
  DeliveryTimelineEntry,
} from './schemas/delivery-parcel-status.schema';

/** The write half of the parcel-status record. Everything the poller needs is here. */
export interface UpsertParcelStatusInput {
  storeId: Types.ObjectId | string;
  companyId: string;
  orderId: Types.ObjectId | string;
  orderNo?: string | null;
  parcelId: string;
  trackingNumber?: string | null;
  deliveryStatus?: string | null;
  carrierStateId?: string | null;
  carrierStateName?: string | null;
  carrierStateDesc?: string | null;
  carrierStateRank?: number | null;
  carrierStateLocked?: boolean | null;
  carrierTransition?: string | null;
  situationFlags?: string[];
  rawSituation?: Record<string, unknown> | null;
  deliveryType?: string | null;
  hubName?: string | null;
  hubCity?: string | null;
  hubDistrict?: string | null;
  lastCarrierStateAt?: Date | null;
  syncState?: string;
  lastPolledAt?: Date | null;
  lastChangedAt?: Date | null;
  lastError?: string | null;
  consecutiveFailures?: number;
  consecutiveMisses?: number;
  nextEligiblePollAt?: Date | null;
  orderSignal?: string | null;
  signalSource?: string | null;
  returnWatchUntil?: Date | null;
  lastOrderActionAt?: Date | null;
  terminal?: boolean;
  terminalConfirmations?: number;
}

const DUPLICATE_KEY = 11000;

/**
 * The scalar view of one parcel record — what the health payload counts.
 *
 * A projection, not a document: the timelines are never loaded for a summary read.
 */
export type DeliveryParcelStatusSummary = Pick<
  DeliveryParcelStatus,
  | 'storeId'
  | 'companyId'
  | 'parcelId'
  | 'deliveryStatus'
  | 'syncState'
  | 'lastPolledAt'
  | 'lastChangedAt'
  | 'nextEligiblePollAt'
  | 'carrierStateLocked'
  | 'carrierStateName'
  | 'terminal'
  | 'consecutiveFailures'
>;

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === DUPLICATE_KEY
  );
}

/**
 * Owns the `deliveryparcelstatuses` write path.
 *
 * The two guarantees it provides are the ones the roadmap pins in §13:
 *
 * - **§13.4** — one record per `(storeId, parcelId)`. The upsert is keyed on that pair and the
 *   unique index is the final guard; a duplicate-key error (the standard Mongo upsert race,
 *   where two instances insert the same key at the same moment) is caught and retried as a
 *   plain update, so a concurrent poll can never produce two records for one parcel.
 * - **§13.1** — the timeline is idempotent by the carrier's own history-entry id. A timeline
 *   entry is appended only when its `providerEntryId` is not already stored, so re-fetching the
 *   same history is a no-op.
 */
@Injectable()
export class DeliveryParcelStatusService {
  constructor(
    @InjectModel(DeliveryParcelStatus.name)
    private readonly model: Model<DeliveryParcelStatusDocument>,
  ) {}

  /**
   * Upserts the record for one parcel (roadmap §13.4).
   *
   * Always scoped by `storeId` — a caller can never write another store's record, because the
   * store is part of the filter as well as of the insert.
   *
   * `session` joins the write to the caller's transaction, so the record and the order-status
   * claim it accompanies commit together (roadmap §10.3, item 4).
   */
  async upsertStatus(
    input: UpsertParcelStatusInput,
    session?: ClientSession,
  ): Promise<DeliveryParcelStatusDocument | null> {
    const { storeId, companyId, parcelId } = input;

    const set = {
      companyId: input.companyId,
      orderId: input.orderId,
      orderNo: input.orderNo ?? null,
      trackingNumber: input.trackingNumber ?? null,
      deliveryStatus: input.deliveryStatus ?? null,
      carrierStateId: input.carrierStateId ?? null,
      carrierStateName: input.carrierStateName ?? null,
      carrierStateDesc: input.carrierStateDesc ?? null,
      carrierStateRank: input.carrierStateRank ?? null,
      carrierStateLocked: input.carrierStateLocked ?? null,
      carrierTransition: input.carrierTransition ?? null,
      situationFlags: input.situationFlags ?? [],
      rawSituation: input.rawSituation ?? null,
      deliveryType: input.deliveryType ?? null,
      hubName: input.hubName ?? null,
      hubCity: input.hubCity ?? null,
      hubDistrict: input.hubDistrict ?? null,
      lastCarrierStateAt: input.lastCarrierStateAt ?? null,
      syncState: input.syncState ?? DeliverySyncState.SYNCED,
      lastPolledAt: input.lastPolledAt ?? null,
      lastChangedAt: input.lastChangedAt ?? null,
      lastError: input.lastError ?? null,
      consecutiveFailures: input.consecutiveFailures ?? 0,
      consecutiveMisses: input.consecutiveMisses ?? 0,
      nextEligiblePollAt: input.nextEligiblePollAt ?? null,
      orderSignal: input.orderSignal ?? null,
      signalSource: input.signalSource ?? null,
      returnWatchUntil: input.returnWatchUntil ?? null,
      lastOrderActionAt: input.lastOrderActionAt ?? null,
      terminal: input.terminal ?? false,
      terminalConfirmations: input.terminalConfirmations ?? 0,
    };

    const setOnInsert = {
      storeId,
      parcelId,
      timeline: [] as DeliveryTimelineEntry[],
      timelineTruncated: false,
    };

    try {
      return await this.model.findOneAndUpdate(
        { storeId, companyId, parcelId },
        { $set: set, $setOnInsert: setOnInsert },
        { upsert: true, new: true, setDefaultsOnInsert: true, session },
      );
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;

      // Another instance inserted the same `(storeId, parcelId)` between our miss and our
      // insert. The record exists now, so retry as a plain update — the same end state, and
      // no second record.
      return await this.model.findOneAndUpdate(
        { storeId, companyId, parcelId },
        { $set: set },
        { new: true, session },
      );
    }
  }

  /**
   * Appends one timeline entry (roadmap §13.1).
   *
   * The guard is the carrier's history-entry id: the update only matches when that id is not
   * already stored, so re-polling — or two instances polling the same parcel at once — cannot
   * duplicate an entry. Returns `true` when the entry was appended, `false` when the guard
   * rejected it.
   */
  async appendTimelineEntry(
    storeId: Types.ObjectId | string,
    parcelId: string,
    entry: DeliveryTimelineEntry,
    session?: ClientSession,
    companyId?: string,
  ): Promise<boolean> {
    if (!entry?.providerEntryId) return false;

    const filter: Record<string, unknown> = {
      storeId,
      parcelId,
      'timeline.providerEntryId': { $ne: entry.providerEntryId },
    };
    if (companyId) filter.companyId = companyId;

    const updated = await this.model.findOneAndUpdate(
      filter,
      { $push: { timeline: entry } },
      { new: true, session },
    );

    return Boolean(updated);
  }

  /**
   * Every record a store owns.
   *
   * Always scoped by `storeId` — there is no way to read another store's records through this
   * method, whatever the caller asks for.
   */
  async listForStore(
    storeId: Types.ObjectId | string,
    filter: {
      companyId?: string;
      parcelIds?: string[];
      syncState?: string[];
      terminal?: boolean;
    } = {},
  ): Promise<DeliveryParcelStatusDocument[]> {
    const query: Record<string, unknown> = { storeId };
    if (filter.companyId) query.companyId = filter.companyId;
    if (filter.parcelIds && filter.parcelIds.length > 0) {
      query.parcelId = { $in: filter.parcelIds };
    }
    if (filter.syncState && filter.syncState.length > 0) {
      query.syncState = { $in: filter.syncState };
    }
    if (typeof filter.terminal === 'boolean') {
      query.terminal = filter.terminal;
    }

    return this.model.find(query).exec();
  }

  /**
   * The scalar summary of every record a store owns.
   *
   * The health payload (§19.3) needs the counters, not the timelines — loading every stored
   * transition for a read-only summary would drag the whole history into memory. The projection
   * keeps the query on the `{ storeId, …}` indexes and leaves the heavy field behind.
   */
  async listSummariesForStore(
    storeId: Types.ObjectId | string,
  ): Promise<DeliveryParcelStatusSummary[]> {
    // `lean` typed with the summary shape: the projection guarantees exactly these fields,
    // and the untyped lean result no longer matches the declared return type.
    return this.model
      .find({ storeId }, this.summaryProjection())
      .lean<DeliveryParcelStatusSummary[]>()
      .exec();
  }

  /** The scalar summary of every record of several stores. */
  async listSummariesForStores(
    storeIds: (Types.ObjectId | string)[],
  ): Promise<DeliveryParcelStatusSummary[]> {
    if (!storeIds || storeIds.length === 0) return [];
    return this.model
      .find({ storeId: { $in: storeIds } }, this.summaryProjection())
      .lean<DeliveryParcelStatusSummary[]>()
      .exec();
  }

  /**
   * Every store that owns at least one record.
   *
   * Used by the operator's health view, which covers "every store the platform knows about" —
   * a store whose configuration was removed still owns records, and those records are the truth.
   */
  async listStoreIds(): Promise<string[]> {
    const ids = await this.model.distinct('storeId', {}).exec();
    return ids.map((id) => String(id));
  }

  /** The fields the health summary needs — and nothing else. */
  private summaryProjection(): Record<string, 1> {
    return {
      storeId: 1,
      companyId: 1,
      parcelId: 1,
      deliveryStatus: 1,
      syncState: 1,
      lastPolledAt: 1,
      lastChangedAt: 1,
      nextEligiblePollAt: 1,
      carrierStateLocked: 1,
      carrierStateName: 1,
      terminal: 1,
      consecutiveFailures: 1,
    };
  }

  /** One record, by `(storeId, parcelId)`. */
  async findOne(
    storeId: Types.ObjectId | string,
    parcelId: string,
    companyId?: string,
  ): Promise<DeliveryParcelStatusDocument | null> {
    const filter: Record<string, unknown> = { storeId, parcelId };
    if (companyId) filter.companyId = companyId;
    return this.model.findOne(filter).exec();
  }

  /**
   * Updates some fields of one record, leaving the others untouched.
   *
   * `upsertStatus` is a **full write** — it replaces the record's state with what the caller
   * passes. A partial change (the poller re-queueing a stale record, the sweep marking an
   * orphan) must not blank the fields it does not know about, so it goes through this method
   * instead. The filter is still scoped by `storeId`.
   */
  async patchStatus(
    storeId: Types.ObjectId | string,
    parcelId: string,
    patch: Partial<
      Pick<
        DeliveryParcelStatus,
        | 'companyId'
        | 'orderId'
        | 'orderNo'
        | 'trackingNumber'
        | 'deliveryStatus'
        | 'carrierStateId'
        | 'carrierStateName'
        | 'carrierStateDesc'
        | 'carrierStateRank'
        | 'carrierStateLocked'
        | 'carrierTransition'
        | 'situationFlags'
        | 'rawSituation'
        | 'deliveryType'
        | 'hubName'
        | 'hubCity'
        | 'hubDistrict'
        | 'lastCarrierStateAt'
        | 'syncState'
        | 'lastPolledAt'
        | 'lastChangedAt'
        | 'lastError'
        | 'consecutiveFailures'
        | 'consecutiveMisses'
        | 'nextEligiblePollAt'
        | 'orderSignal'
        | 'signalSource'
        | 'returnWatchUntil'
        | 'lastOrderActionAt'
        | 'terminal'
        | 'terminalConfirmations'
        | 'conflict'
        | 'conflictAt'
      >
    >,
    session?: ClientSession,
  ): Promise<DeliveryParcelStatusDocument | null> {
    return this.model
      .findOneAndUpdate({ storeId, parcelId }, { $set: patch }, { new: true, session })
      .exec();
  }

  /**
   * Trims the timeline to the bounded window (roadmap §11.4): the **first** entry (the creation
   * event, which anchors the display) plus the most recent entries, capped at
   * `DELIVERY_TIMELINE_MAX_ENTRIES` in total, and flags the record as truncated.
   *
   * Idempotent — trimming an already-trimmed timeline changes nothing.
   */
  async compactTimeline(
    storeId: Types.ObjectId | string,
    parcelId: string,
    session?: ClientSession,
  ): Promise<boolean> {
    const query = this.model.findOne({ storeId, parcelId }).select({ timeline: 1 }).lean();
    if (session) query.session(session);
    const record = await query.exec();

    const timeline = (record?.timeline ?? []) as DeliveryTimelineEntry[];
    if (timeline.length <= DELIVERY_TIMELINE_MAX_ENTRIES) return false;

    const { entries, truncated } = boundTimeline(timeline);
    await this.model.updateOne(
      { storeId, parcelId },
      { $set: { timeline: entries, timelineTruncated: truncated } },
      { session },
    );

    return true;
  }
}

/**
 * The bounded timeline window (roadmap §11.4).
 *
 * Keeps the first entry — the creation event, which anchors the display — plus the most recent
 * entries, and reports whether anything was dropped. The full history stays available from the
 * carrier on demand (the manual refresh, roadmap §16.3).
 */
export function boundTimeline<T extends { providerEntryId: string }>(
  entries: T[],
): { entries: T[]; truncated: boolean } {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length <= DELIVERY_TIMELINE_MAX_ENTRIES) {
    return { entries: list, truncated: false };
  }

  const first = list[0];
  const recent = list.slice(-(DELIVERY_TIMELINE_MAX_ENTRIES - 1));

  return { entries: [first, ...recent], truncated: true };
}
