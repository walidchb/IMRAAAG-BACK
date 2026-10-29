import { OrderSource } from '../../../common/constants/order-sources.const';
import {
  AnalyticsChannel,
  CHANNEL_SOURCES,
  PROCESSING_EXCLUDED_SOURCES,
  RETURNED_STATUS,
  SALES_EXCLUDED_STATUSES,
  SETTLED_STATUS,
} from '../constants/analytics.constants';

/**
 * Pure order-eligibility rules (roadmap Phase 0, decisions D1–D3/D6/D8).
 *
 * These deliberately take a minimal shape rather than a Mongoose document so they can run in a
 * unit test with no database, and so every aggregation filters on the same predicate instead of
 * re-deriving "is this a sale?" from scratch.
 */

export interface OrderEligibilityInput {
  source?: string | null;
  status?: string | { slug?: string } | null;
  isDeleted?: boolean | null;
}

/** The status slug, whether `status` is a bare string or an embedded status document. */
export function orderStatusSlug(order: OrderEligibilityInput): string {
  const status = order.status;
  if (!status) return '';
  return typeof status === 'string' ? status : status.slug ?? '';
}

export function isSoftDeleted(order: OrderEligibilityInput): boolean {
  return order.isDeleted === true;
}

/** D1: counts toward "net item sales" — not deleted, not cancelled. */
export function isSalesEligible(order: OrderEligibilityInput): boolean {
  return !isSoftDeleted(order) && !SALES_EXCLUDED_STATUSES.includes(orderStatusSlug(order));
}

/** D2: the sale stuck — the order reached `delivered`. */
export function isSettled(order: OrderEligibilityInput): boolean {
  return !isSoftDeleted(order) && orderStatusSlug(order) === SETTLED_STATUS;
}

/** D2: the sale was reversed; reported separately, never added to sales. */
export function isReturned(order: OrderEligibilityInput): boolean {
  return !isSoftDeleted(order) && orderStatusSlug(order) === RETURNED_STATUS;
}

/** D8: instantaneous channels (POS) are excluded from processing-time metrics. */
export function countsTowardProcessing(order: OrderEligibilityInput): boolean {
  return !PROCESSING_EXCLUDED_SOURCES.includes(order.source ?? '');
}

/** D6: map an order's raw source to its reporting-channel bucket. */
export function channelOf(
  source?: string | null,
): Exclude<AnalyticsChannel, 'all'> | 'unknown' {
  const raw = (source ?? '') as OrderSource;
  for (const channel of Object.keys(CHANNEL_SOURCES) as Exclude<AnalyticsChannel, 'all'>[]) {
    if (CHANNEL_SOURCES[channel].includes(raw)) return channel;
  }
  return 'unknown';
}

/** True when the order belongs to the requested reporting channel (`all` = every channel). */
export function isInChannel(order: OrderEligibilityInput, channel: AnalyticsChannel): boolean {
  if (channel === 'all') return true;
  return channelOf(order.source) === channel;
}
