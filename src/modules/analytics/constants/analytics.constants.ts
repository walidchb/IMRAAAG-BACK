import { OrderSource } from '../../../common/constants/order-sources.const';
import { OrderStatus } from '../../../common/constants/order-statuses.const';

/**
 * Metric dictionary and semantic decisions for the seller dashboard analytics
 * (see `IMRAAAH-seller-dashboard-implementation-roadmap.md`, decisions D1–D12).
 *
 * This file is the single source of truth for "what counts". Every aggregation must read its
 * rules from here rather than re-deciding inline, so a decision is changed in one place and
 * every surface follows. Nothing here touches the database — it is pure vocabulary.
 */

/** Day/week/month and every bucket boundary are anchored to the platform timezone (D4). */
export const ANALYTICS_TIMEZONE = 'Africa/Algiers';

/** Range presets offered in the UI. `custom` reads `from`/`to` from the query. */
export const ANALYTICS_RANGE_PRESETS = [
  'today',
  'yesterday',
  '7d',
  '30d',
  'month',
  'custom',
] as const;
export type AnalyticsRangePreset = (typeof ANALYTICS_RANGE_PRESETS)[number];

/** Default preset when the query omits one. A finite preset, never `custom`. */
export const ANALYTICS_DEFAULT_PRESET: Exclude<AnalyticsRangePreset, 'custom'> = '30d';

/** Trend bucket granularities. */
export const ANALYTICS_BUCKETS = ['hour', 'day', 'week', 'month'] as const;
export type AnalyticsBucket = (typeof ANALYTICS_BUCKETS)[number];

/**
 * Trend series the `/trend` endpoint can surface as its primary figure (Phase 2).
 *
 * `sales` is the default and the only one the backend costs with per-point gross/discount
 * breakdowns; `orders`/`units` reuse the same buckets with a different headline number.
 * `aov` is derived client-side (net ÷ orders per point), so it is not a wire value.
 */
export const ANALYTICS_TREND_METRICS = ['sales', 'orders', 'units'] as const;
export type AnalyticsTrendMetric = (typeof ANALYTICS_TREND_METRICS)[number];
export const ANALYTICS_DEFAULT_TREND_METRIC: AnalyticsTrendMetric = 'sales';

/** The bucket a finite preset defaults to when the caller does not ask for one. */
export const ANALYTICS_DEFAULT_BUCKET_BY_PRESET: Record<
  Exclude<AnalyticsRangePreset, 'custom'>,
  AnalyticsBucket
> = {
  today: 'hour',
  yesterday: 'hour',
  '7d': 'day',
  '30d': 'day',
  month: 'day',
};

/**
 * Reporting channel (D6). `MANUAL` is kept as its own bucket: a dashboard-entered order may
 * also have been rung online or in store, so folding it into either would double-count. The
 * headline shows Online + In-store; Manual is surfaced separately.
 */
export const ANALYTICS_CHANNELS = ['all', 'online', 'in-store', 'manual'] as const;
export type AnalyticsChannel = (typeof ANALYTICS_CHANNELS)[number];
export const ANALYTICS_DEFAULT_CHANNEL: AnalyticsChannel = 'all';

/** Which raw `OrderSource` values each reporting channel covers. */
export const CHANNEL_SOURCES: Record<Exclude<AnalyticsChannel, 'all'>, OrderSource[]> = {
  online: [OrderSource.ONLINE],
  'in-store': [OrderSource.POS],
  manual: [OrderSource.MANUAL],
};

/** Channels that make up the headline sales figure (D6). */
export const HEADLINE_CHANNELS: Exclude<AnalyticsChannel, 'all'>[] = ['online', 'in-store'];

/**
 * Order-eligibility sets (D1–D3).
 *
 * Sales = orders that were neither cancelled nor deleted. A cancelled order is never a sale;
 * a returned order did sell but was later reversed, so it is excluded from the *settled*
 * figure and reported on its own. POS sales are created terminal `delivered`.
 */
export const SALES_EXCLUDED_STATUSES: string[] = [OrderStatus.CANCELLED];
export const SETTLED_STATUS: string = OrderStatus.DELIVERED;
export const RETURNED_STATUS: string = OrderStatus.RETURNED;

/** Statuses that mean "the vendor still needs to act" (spec §3.5). */
export const ACTIONABLE_STATUSES: string[] = [
  OrderStatus.PLACED, // awaiting confirmation
  OrderStatus.CONFIRMED, // awaiting dispatch
  OrderStatus.IN_TRANSIT, // awaiting delivery follow-up
  OrderStatus.RETURNED, // awaiting return processing
];

/** Sources excluded from processing-time metrics (D8) — POS is instantaneous. */
export const PROCESSING_EXCLUDED_SOURCES: string[] = [OrderSource.POS];
