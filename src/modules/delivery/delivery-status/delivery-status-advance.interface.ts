/**
 * The order-status advance seam (roadmap §12.2, step d).
 *
 * The poller computes **which** order status a carrier status implies; this provider performs
 * the write. The split exists so the two concerns can be tested — and released — separately:
 *
 * - **Phase 3** (the poller) decides that an advance is warranted and asks for it. No provider
 *   is bound yet, so nothing is written to an order.
 * - **Phase 4** binds a provider that performs the guarded, conditional advance (§10.3) and
 *   reports whether it won the claim, lost it, or refused it.
 *
 * The provider is injected **optionally**: a platform that has not enabled the advance simply
 * has no provider bound, and the poller logs the intent and moves on.
 */
import { ClientSession } from 'mongoose';

export const DELIVERY_STATUS_ADVANCE = 'DELIVERY_STATUS_ADVANCE';

/** The order statuses a carrier action may target. */
export type DeliveryStatusAdvanceTarget = 'in-transit' | 'delivered' | 'cancelled' | 'returned';

/** One advance the poller wants performed. */
export interface DeliveryStatusAdvanceRequest {
  /** The store that owns the order — the tenancy key of the whole operation. */
  storeId: string;
  /** The carrier whose event produced the advance. */
  companyId?: string;
  /** The order to advance. */
  orderId: string;
  /** Our order number, for logs. */
  orderNo: string;
  /** The carrier parcel the status came from. */
  parcelId: string;
  /** The order's current status slug — the `from` of the guarded claim. */
  fromStatus: string;
  /** The status slug the order should move to. */
  toStatus: string;
  /** The normalized carrier status that triggered the advance. */
  deliveryStatus: string;
  /** The order signal the carrier's newest event carried. */
  signal: string;
  /** The planner's target. */
  target: DeliveryStatusAdvanceTarget;
  /** The ordered transitions to apply. */
  steps: string[];
  /** Only `cancelled` touches reservations. */
  inventoryAware: boolean;
}

/** What the advance provider did. */
export type DeliveryStatusAdvanceOutcome =
  /** The order was advanced. */
  | 'advanced'
  /** The advance was not applicable (the claim no longer matched, or the order is not ours). */
  | 'skipped'
  /** The advance lost its race (§10.4) — recorded, never fatal. */
  | 'conflict'
  /** The advance failed for another reason. */
  | 'failed';

/**
 * The provider's answer.
 *
 * `reason` carries the machine-readable cause — a conflict code from
 * `DELIVERY_STATUS_CONFLICT_CODES` when the outcome is `conflict` — so the poller can record
 * *why* the order did not move on the parcel-status record (§10.4), instead of only counting
 * a lost race.
 */
export interface DeliveryStatusAdvanceResult {
  outcome: DeliveryStatusAdvanceOutcome;
  /** The machine-readable reason: a conflict code, or why the advance did not apply. */
  reason?: string;
  /** The order's status before the attempt. */
  fromStatus?: string;
  /** The status the carrier asked for. */
  toStatus?: string;
}

export interface DeliveryStatusAdvance {
  /**
   * Performs the advance.
   *
   * `session` is the caller's transaction, when the datastore supports one: the parcel-status
   * record and the order's status claim then commit together (§10.3, item 4). A provider that
   * receives no session must still work — the write is then simply not transactional.
   */
  advance(
    request: DeliveryStatusAdvanceRequest,
    session?: ClientSession,
  ): Promise<DeliveryStatusAdvanceResult>;
}
