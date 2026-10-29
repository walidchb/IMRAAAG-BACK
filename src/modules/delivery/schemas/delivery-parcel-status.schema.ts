import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  DELIVERY_SYNC_STATE_VALUES,
  DeliverySyncState,
} from '../../../common/constants/delivery-status.const';

export type DeliveryParcelStatusDocument = DeliveryParcelStatus & Document;

/**
 * One situation attached to a carrier transition.
 *
 * Stored verbatim next to the flags it produced, so a vendor can see the carrier's own words
 * even when the platform did not recognise the situation.
 */
@Schema({ _id: false })
export class DeliveryTimelineSituation {
  @Prop({ type: String })
  slug?: string | null;

  @Prop({ type: String })
  name?: string | null;

  @Prop({ type: String })
  description?: string | null;

  @Prop({ type: Date })
  at?: Date | null;
}

/**
 * One carrier transition.
 *
 * `providerEntryId` is the carrier's own history-entry id and is the **timeline idempotency
 * key** (roadmap §13.1): the upsert filter refuses to append an entry whose id is already
 * stored, so re-polling — or replaying a cycle after a crash — can never duplicate an entry.
 */
@Schema({ _id: false })
export class DeliveryTimelineEntry {
  /** The carrier's history-entry id. The idempotency key. */
  @Prop({ required: true })
  providerEntryId: string;

  /** The carrier state slug the parcel left. */
  @Prop({ type: String })
  fromState?: string | null;

  /** The carrier state slug the parcel entered. */
  @Prop({ required: true })
  toState: string;

  /** The carrier's `actionName` for this move, when the tenant's workflow declares one. */
  @Prop({ type: String })
  transitionName?: string | null;

  /** When the transition happened on the carrier side. */
  @Prop({ type: Date, required: true })
  at: Date;

  @Prop({ type: String })
  comment?: string | null;

  @Prop({ type: String })
  hubName?: string | null;

  @Prop({ type: String })
  modifiedBy?: string | null;

  @Prop({ type: [DeliveryTimelineSituation], default: [] })
  situations: DeliveryTimelineSituation[];
}

/**
 * The carrier's view of one parcel, as the platform last saw it.
 *
 * One document per `(store, carrier parcel)`. A separate collection rather than a field on
 * `Order` because the timeline grows without bound and the vendor dashboard needs bulk reads
 * across many orders without loading the order documents (roadmap §11.1).
 *
 * Every index is prefixed with `storeId` — the platform's canonical seller identity
 * (`AGENTS.md`: "Seller identity is `storeId`") — so a store can never read another store's
 * records through a compound index.
 */
@Schema({ timestamps: true })
export class DeliveryParcelStatus {
  /** Canonical owner reference. The tenancy key for every read and write. */
  @Prop({ type: Types.ObjectId, ref: 'Store', required: true, index: true })
  storeId: Types.ObjectId;

  /** The provider slug that owns the parcel — `zr-express`, `noest`, … */
  @Prop({ required: true })
  companyId: string;

  /** The order this parcel belongs to. */
  @Prop({ type: Types.ObjectId, ref: 'Order', required: true })
  orderId: Types.ObjectId;

  /** Our order number, denormalised so the record can be found without joining the order. */
  @Prop({ type: String })
  orderNo?: string | null;

  /** The carrier's parcel id. Unique per store. */
  @Prop({ required: true })
  parcelId: string;

  @Prop({ type: String })
  trackingNumber?: string | null;

  /**
   * The normalized delivery status (roadmap §8.2).
   *
   * A free string rather than an enum on purpose: the record is provider-neutral (`companyId` is
   * a field), so a second carrier may bring its own vocabulary. The write path only ever stores
   * a value the provider's mapper produced.
   */
  @Prop({ type: String })
  deliveryStatus?: string | null;

  /** The raw carrier state uuid. Diagnostic only — state ids are workflow-scoped (§7.3). */
  @Prop({ type: String })
  carrierStateId?: string | null;

  /** The raw carrier state slug. */
  @Prop({ type: String })
  carrierStateName?: string | null;

  /** The raw carrier state description, in the carrier's language. */
  @Prop({ type: String })
  carrierStateDesc?: string | null;

  /** The carrier's `ranking` for this state, when the tenant's workflow exposes it. */
  @Prop({ type: Number })
  carrierStateRank?: number | null;

  /** The carrier's `isLocked`: the parcel is locked in this state. */
  @Prop({ type: Boolean })
  carrierStateLocked?: boolean | null;

  /** The carrier's `actionName` for the last move — e.g. `deliver`. */
  @Prop({ type: String })
  carrierTransition?: string | null;

  /** The normalized situation flags currently attached to the parcel (roadmap §8.3). */
  @Prop({ type: [String], default: [] })
  situationFlags: string[];

  /** The carrier's current situation, verbatim, even when the platform did not recognise it. */
  @Prop({ type: Object })
  rawSituation?: Record<string, unknown> | null;

  @Prop({ type: String })
  deliveryType?: string | null;

  @Prop({ type: String })
  hubName?: string | null;

  @Prop({ type: String })
  hubCity?: string | null;

  @Prop({ type: String })
  hubDistrict?: string | null;

  /** The carrier's `lastStateUpdateAt`. */
  @Prop({ type: Date })
  lastCarrierStateAt?: Date | null;

  /** The bounded window of carrier transitions (roadmap §11.4). */
  @Prop({ type: [DeliveryTimelineEntry], default: [] })
  timeline: DeliveryTimelineEntry[];

  /**
   * True when the carrier's history is longer than the stored window, so the UI can offer
   * "view the full history at the carrier".
   */
  @Prop({ default: false })
  timelineTruncated: boolean;

  /** The poller's view of this record's health. */
  @Prop({ type: String, enum: DELIVERY_SYNC_STATE_VALUES, default: DeliverySyncState.IDLE })
  syncState: string;

  @Prop({ type: Date })
  lastPolledAt?: Date | null;

  /** When the carrier's state last changed — the vendor's "what changed" watermark. */
  @Prop({ type: Date })
  lastChangedAt?: Date | null;

  @Prop({ type: String })
  lastError?: string | null;

  @Prop({ default: 0 })
  consecutiveFailures: number;

  /**
   * How many cycles in a row the carrier answered "not found" for this parcel.
   *
   * Distinct from `consecutiveFailures`: a missing parcel is a valid (if worrying) answer, not a
   * transport error, so it never drives the backoff ladder. After
   * `DELIVERY_STATUS_MISSING_CONFIRMATIONS` consecutive misses the record is parked as
   * `not_found` so it stops spending calls until the carrier recognises it again.
   */
  @Prop({ default: 0 })
  consecutiveMisses: number;

  /** The earliest time the next poll may run — the cadence and backoff gate. */
  @Prop({ type: Date })
  nextEligiblePollAt?: Date | null;

  /**
   * The conflict the carrier's signal created (roadmap §10.4).
   *
   * A free string rather than an enum, for the same reason `deliveryStatus` is: the record is
   * provider-neutral. The values the platform writes are the ones in
   * `DELIVERY_STATUS_CONFLICT_CODES` — `order_cancelled_before_delivery` when the vendor
   * cancelled an order the carrier had already delivered, and so on.
   *
   * It is written **only** by the conflict path: the carrier's event is always recorded, but
   * the flag says that the order could not follow it, so the vendor can see the disagreement.
   */
  @Prop({ type: String })
  conflict?: string | null;

  /** When the conflict was recorded. */
  @Prop({ type: Date })
  conflictAt?: Date | null;

  /**
   * The order signal the carrier's newest event carried (`none` included).
   *
   * Persisted so the poller can plan from the record even when a vendor-requested refresh wrote
   * the carrier state between polls (roadmap §7.3).
   */
  @Prop({ type: String })
  orderSignal?: string | null;

  /** What produced that signal: `state`, `situation`, `override` or `none`. */
  @Prop({ type: String })
  signalSource?: string | null;

  /**
   * When the post-delivery return watch ends.
   *
   * `delivered` stays pollable until this moment: ZR can still record a return after the parcel
   * was handed over. Set on the first delivered poll and never extended.
   */
  @Prop({ type: Date })
  returnWatchUntil?: Date | null;

  /** When the platform last advanced an order from this record. Null until then. */
  @Prop({ type: Date })
  lastOrderActionAt?: Date | null;

  /** The carrier reached a terminal state (roadmap §7.1): the parcel has stopped moving. */
  @Prop({ default: false })
  terminal: boolean;

  /**
   * How many consecutive polls reported the same terminal state (roadmap §12.3).
   *
   * A parcel stops being polled once the terminal state has been confirmed
   * `ZR_STATUS_SYNC_TERMINAL_CONFIRMATIONS` times (3 by default) — one confirmation is not
   * enough to be sure the parcel really stopped moving.
   */
  @Prop({ default: 0 })
  terminalConfirmations: number;

  @Prop({ type: Date })
  createdAt?: Date;

  @Prop({ type: Date })
  updatedAt?: Date;
}

export const DeliveryParcelStatusSchema = SchemaFactory.createForClass(DeliveryParcelStatus);

/**
 * Indexes (roadmap §11.2).
 *
 * Every one is prefixed with `storeId` — the tenancy key — so a compound index can never serve
 * another store's records.
 */
DeliveryParcelStatusSchema.index({ storeId: 1, companyId: 1, parcelId: 1 }, { unique: true });
DeliveryParcelStatusSchema.index({ storeId: 1, companyId: 1, orderId: 1 });
DeliveryParcelStatusSchema.index({ storeId: 1, companyId: 1, syncState: 1, nextEligiblePollAt: 1 });
DeliveryParcelStatusSchema.index({ storeId: 1, companyId: 1, deliveryStatus: 1 });
DeliveryParcelStatusSchema.index({ storeId: 1, companyId: 1, lastPolledAt: 1 });
DeliveryParcelStatusSchema.index({ 'timeline.providerEntryId': 1 });
