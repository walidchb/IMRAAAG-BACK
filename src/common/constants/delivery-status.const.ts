/**
 * The lifecycle of one carrier-parcel status record.
 *
 * A record in `deliveryparcelstatuses` moves through these states as the sync polls the
 * carrier. The value is written by the poller only — never by a client — and is the
 * poller's work-queue filter (§12.2 of `ZR-EXPRESS-STATUS-SYNC-ROADMAP.md`).
 */
export enum DeliverySyncState {
  /** The record exists but has never been polled (or has been reset). */
  IDLE = 'idle',
  /** The last poll succeeded and the carrier's state is recorded. */
  SYNCED = 'synced',
  /** The last poll failed. `lastError` holds the reason; `consecutiveFailures` counts them. */
  ERROR = 'error',
  /** The carrier no longer knows the parcel. The record is kept for history, not polled again. */
  NOT_FOUND = 'not_found',
  /** The parcel was replaced by another one (an exchange or a return re-creation). */
  SUPERSEDED = 'superseded',
}

export const DELIVERY_SYNC_STATE_VALUES: string[] = Object.values(DeliverySyncState);

/**
 * How many timeline entries a parcel record keeps.
 *
 * The carrier's state history is unbounded; a long-running parcel can accumulate hundreds of
 * entries. The platform keeps a bounded window (roadmap §11.4) — the most recent entries plus
 * the first one, which anchors the display — and flags the record as truncated so the UI can
 * offer "view the full history at the carrier".
 */
export const DELIVERY_TIMELINE_MAX_ENTRIES = 200;

/**
 * The backoff ladder (roadmap §14.3), in minutes.
 *
 * A parcel that fails to poll waits `5 → 15 → 30 → 60 → 120` minutes before its next attempt.
 * The last rung repeats: the cap is 120 minutes. A successful poll resets the counter to zero.
 */
export const DELIVERY_STATUS_BACKOFF_MINUTES: readonly number[] = [5, 15, 30, 60, 120] as const;

/**
 * How many consecutive "not found" answers before a parcel record is parked as `not_found`
 * (Ecom/Recon plan, E3).
 *
 * A single miss is often transient — the carrier has not indexed the parcel yet, or the query
 * hit the wrong tenant. Three in a row is a real "the carrier does not know this parcel":
 * the record keeps its history but stops spending calls until the carrier recognises it again.
 */
export const DELIVERY_STATUS_MISSING_CONFIRMATIONS = 3;

/**
 * The key of the single-instance lease (roadmap §12.5).
 *
 * One document in `syncleases` with this key is held by exactly one instance at a time, so a
 * multi-replica deployment does not multiply the provider load by the replica count.
 */
export const DELIVERY_STATUS_LEASE_KEY = 'zr-status-sync';

/** One lease per carrier, so enabling a second provider does not serialise the first. */
export function deliveryStatusLeaseKey(companyId: string): string {
  return `delivery-status-sync:${companyId}`;
}

/**
 * The order statuses whose parcels are still worth polling (roadmap §15.2).
 *
 * A parcel exists from the moment the order is dispatched, so `confirmed` is included for the
 * case where a parcel was created before the order moved on. `delivered` stays here for the
 * post-delivery return-watch window; the parcel record's `terminal` flag decides when polling
 * actually ends.
 */
export const DELIVERY_STATUS_TRACKED_ORDER_STATUSES: readonly string[] = [
  'confirmed',
  'dispatched',
  'in-transit',
  'delivered',
] as const;

/**
 * The order statuses with no parcel left to follow.
 *
 * `delivered` is deliberately absent: ZR can still record a return after handover, so a delivered
 * order keeps polling until its return-watch window expires.
 */
export const DELIVERY_STATUS_STOP_ORDER_STATUSES: readonly string[] = [
  'cancelled',
  'returned',
] as const;

/**
 * The conflicts a carrier signal can create (roadmap §10.4).
 *
 * The carrier and the vendor can disagree: the vendor cancelled an order the carrier had
 * already delivered, the vendor re-dispatched it, or the carrier's signal arrives for an order
 * that never left the warehouse. None of these is an error — the order keeps the status the
 * vendor gave it, and the carrier's event is recorded on the parcel-status record under
 * `conflict` so the vendor can see the disagreement.
 */
export const DELIVERY_STATUS_CONFLICT_CODES = {
  /** The vendor cancelled the order before the carrier delivered it. */
  ORDER_CANCELLED_BEFORE_DELIVERY: 'order_cancelled_before_delivery',
  /** The order was already delivered when the carrier reported the delivery. */
  ORDER_ALREADY_DELIVERED: 'order_already_delivered',
  /** The order was already returned. */
  ORDER_ALREADY_RETURNED: 'order_already_returned',
  /** The order never reached `dispatched`, so the carrier cannot have moved it. */
  ORDER_NOT_DISPATCHED: 'order_not_dispatched',
  /** The order was deleted while the parcel was still in flight. */
  ORDER_DELETED: 'order_deleted',
  /** The order moved between the poll and the write — a race, not a disagreement. */
  ORDER_STATUS_MOVED: 'order_status_moved',
  /**
   * The parcel's order belongs to a different store (or no longer exists in this one).
   *
   * Reported by `OrdersService.applyCarrierOrderAction`, never fabricated by the poller: an
   * advance can never cross a tenant boundary even if a record was somehow mis-scoped.
   */
  ORDER_NOT_IN_STORE: 'order_not_in_store',
} as const;

export type DeliveryStatusConflictCode =
  (typeof DELIVERY_STATUS_CONFLICT_CODES)[keyof typeof DELIVERY_STATUS_CONFLICT_CODES];

export const DELIVERY_STATUS_CONFLICT_CODE_VALUES: string[] =
  Object.values(DELIVERY_STATUS_CONFLICT_CODES);

/**
 * The wait before the next poll of a parcel that has just failed, in minutes.
 *
 * `consecutiveFailures` is 1 for the first failure, 2 for the second, and so on. The ladder is
 * capped at its last rung (§14.3).
 */
export function deliveryStatusBackoffMinutes(consecutiveFailures: number): number {
  const failures = Number.isFinite(consecutiveFailures) ? Math.floor(consecutiveFailures) : 1;
  if (failures <= 0) return 0;
  const index = Math.min(failures - 1, DELIVERY_STATUS_BACKOFF_MINUTES.length - 1);
  return DELIVERY_STATUS_BACKOFF_MINUTES[index];
}
