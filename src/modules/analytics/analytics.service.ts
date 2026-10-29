import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  ANALYTICS_DEFAULT_CHANNEL,
  ANALYTICS_DEFAULT_TREND_METRIC,
  CHANNEL_SOURCES,
  AnalyticsBucket,
  AnalyticsChannel,
  AnalyticsRangePreset,
  AnalyticsTrendMetric,
} from './constants/analytics.constants';
import {
  DateWindow,
  ResolvedAnalyticsRange,
  previousPeriod,
  resolveAnalyticsRange,
} from './lib/date-range';
import { bucketAdvance, bucketKey, bucketStartAt } from './lib/trend-bucket';
import { AnalyticsRangeQueryDto } from './dto/analytics-query.dto';
import {
  isReturned,
  isSalesEligible,
  isSettled,
  channelOf,
} from './lib/order-eligibility';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { ProductVariant, ProductVariantDocument } from '../inventory/schemas/product-variant.schema';
import { ORDER_STATUS_VALUES } from '../../common/constants/order-statuses.const';

/**
 * Seller-dashboard analytics service (roadmap Phase 1).
 *
 * Every figure is computed from the `orders` collection at read time over the half-open,
 * Algiers-anchored window resolved by `resolveAnalyticsRange`. The aggregation pipeline
 * projects each matched order down to the handful of fields the metrics need (status slug,
 * item totals, quantity, source) and every metric is then derived by the **pure** helpers
 * below — `summarize`, `trendSeries`, `summarizeChannels`, `countByStatus` — which are the
 * same functions the specs assert against. No counter collections, no partial sums.
 */

/** One order line's contribution to the sales metrics (Phase 2 projection). */
export interface AnalyticsProjectedLine {
  price: number;
  quantity: number;
  /**
   * Forward-only discount snapshot (D12). Absent on legacy lines; `null` means the seller
   * recorded no discount. Presence is what marks a line as *covered* for gross/discount.
   */
  originalPrice?: number | null;
}

export interface AnalyticsProjectedOrder {
  _id: string;
  createdAt: Date;
  statusSlug: string;
  itemsTotal: number;
  itemQty: number;
  source: string | null;
  /** Line snapshot for the Phase 2 sales breakdown; absent rows fail closed (unavailable). */
  items?: AnalyticsProjectedLine[];
}

export interface SummaryMetrics {
  /** Σ item.price × quantity over sales-eligible orders (D1). Cancelled/deleted excluded. */
  netSales: number;
  /** The subset that reached `delivered` (D2). */
  settled: number;
  /** The subset reversed after sale (D2) — reported separately, never added to sales. */
  returned: number;
  /** Σ over every non-deleted order in the window, incl. cancelled (the "before" figure). */
  grossVolume: number;
  /**
   * Pre-discount sales over eligible orders (D12): Σ `originalPrice` × quantity. `null` when
   * the window is not fully covered by snapshot-bearing lines (a legacy line makes the exact
   * figure unknowable). Distinct from `grossVolume`, which counts cancelled orders too.
   */
  grossSales: number | null;
  /** grossSales − netSales; `null` whenever `grossSales` is unavailable. */
  discount: number | null;
  /** Count of sales-eligible orders. */
  orderCount: number;
  /** Σ item quantities over sales-eligible orders. */
  units: number;
  /** netSales / orderCount; `null` when there are no eligible orders. */
  aov: number | null;
}

export interface StoreScope {
  storeId: Types.ObjectId;
  vendorEmail: string;
}

function emptyMetrics(): SummaryMetrics {
  return {
    netSales: 0,
    settled: 0,
    returned: 0,
    grossVolume: 0,
    grossSales: null,
    discount: null,
    orderCount: 0,
    units: 0,
    aov: null,
  };
}

/** D5: percent change vs the previous period; `null` when the baseline is zero. */
export function percentDelta(current: number, previous: number): number | null {
  if (previous === 0 || !Number.isFinite(previous)) return null;
  if (!Number.isFinite(current)) return null;
  return ((current - previous) / previous) * 100;
}

export interface SalesBreakdown {
  /** Pre-discount Σ over covered eligible lines; `null` when the window is not fully covered. */
  grossSales: number | null;
  /** grossSales − netSales; `null` whenever `grossSales` is unavailable. */
  discount: number | null;
  /**
   * True only when every sales-eligible line in the row set carries the forward-only `originalPrice`
   * field (D12). A missing `items` array, an empty eligible set, or any legacy line flips it off,
   * so an exact gross/discount is never invented from partial data.
   */
  available: boolean;
}

/**
 * The Phase 2 gross/discount split. Coverage is a window-wide property: one legacy line makes
 * every bucket of the window coarse, because we cannot tell which bucket its discount was in.
 * A present-but-`null` `originalPrice` is a recorded zero discount and counts as covered.
 */
export function salesBreakdown(rows: AnalyticsProjectedOrder[]): SalesBreakdown {
  let anyLines = false;
  let allCovered = true;
  let gross = 0;
  let net = 0;
  for (const row of rows) {
    if (!isSalesEligible({ status: row.statusSlug })) continue;
    if (!Array.isArray(row.items)) {
      // A sales-eligible order whose line list was never projected cannot prove coverage.
      return { grossSales: null, discount: null, available: false };
    }
    for (const it of row.items) {
      anyLines = true;
      const qty = Number(it.quantity) || 0;
      const price = Number(it.price) || 0;
      net += price * qty;
      if ('originalPrice' in it) {
        gross += (it.originalPrice == null ? price : Number(it.originalPrice) || 0) * qty;
      } else {
        allCovered = false;
      }
    }
  }
  if (!anyLines || !allCovered) {
    return { grossSales: null, discount: null, available: false };
  }
  return { grossSales: gross, discount: gross - net, available: true };
}

/** The shared seven summary fields, computed from projected rows (D1–D3). */
export function summarize(rows: AnalyticsProjectedOrder[]): SummaryMetrics {
  const metrics = emptyMetrics();
  for (const row of rows) {
    metrics.grossVolume += row.itemsTotal;
    if (!isSalesEligible({ status: row.statusSlug })) continue;
    metrics.netSales += row.itemsTotal;
    metrics.orderCount += 1;
    metrics.units += row.itemQty;
    if (isSettled({ status: row.statusSlug })) metrics.settled += row.itemsTotal;
    if (isReturned({ status: row.statusSlug })) metrics.returned += row.itemsTotal;
  }
  metrics.aov = metrics.orderCount > 0 ? metrics.netSales / metrics.orderCount : null;
  const breakdown = salesBreakdown(rows);
  metrics.grossSales = breakdown.grossSales;
  metrics.discount = breakdown.discount;
  return metrics;
}

export interface ChannelMetrics {
  channel: Exclude<AnalyticsChannel, 'all'>;
  orders: number;
  netSales: number;
  units: number;
}

/** Per-channel split (D6): MANUAL stays its own bucket, never folded into Online. */
export function summarizeChannels(rows: AnalyticsProjectedOrder[]): ChannelMetrics[] {
  const by: Record<Exclude<AnalyticsChannel, 'all'>, ChannelMetrics> = {
    online: { channel: 'online', orders: 0, netSales: 0, units: 0 },
    'in-store': { channel: 'in-store', orders: 0, netSales: 0, units: 0 },
    manual: { channel: 'manual', orders: 0, netSales: 0, units: 0 },
  };
  for (const row of rows) {
    const channel = channelOf(row.source);
    if (channel === 'unknown') continue;
    by[channel].orders += 1;
    by[channel].units += row.itemQty;
    if (isSalesEligible({ status: row.statusSlug })) by[channel].netSales += row.itemsTotal;
  }
  return [by.online, by['in-store'], by.manual];
}

export interface TrendPoint {
  key: string;
  netSales: number;
  settled: number;
  returned: number;
  orderCount: number;
  units: number;
  /**
   * Per-bucket Phase 2 breakdown. `null` on empty buckets and whenever the window is not fully
   * covered — zeros here would read as "no discount happened" rather than "unknown".
   */
  gross: number | null;
  discount: number | null;
}

function emptyTrendPoint(key: string): TrendPoint {
  return { key, netSales: 0, settled: 0, returned: 0, orderCount: 0, units: 0, gross: null, discount: null };
}

/**
 * Buckets projected rows into contiguous bucket starts covering `[from, to)` (D4). Empty
 * buckets are emitted as zero-filled points so the chart's x-axis is exact regardless of
 * order density.
 */
export function trendSeries(
  rows: AnalyticsProjectedOrder[],
  range: DateWindow,
  bucket: AnalyticsBucket,
  includeDiscount = false,
): TrendPoint[] {
  const byKey = new Map<string, TrendPoint>();
  for (const row of rows) {
    if (!isSalesEligible({ status: row.statusSlug })) continue;
    const start = bucketStartAt(row.createdAt, bucket);
    const key = bucketKey(start, bucket);
    let point = byKey.get(key);
    if (!point) {
      point = emptyTrendPoint(key);
      byKey.set(key, point);
    }
    point.netSales += row.itemsTotal;
    point.orderCount += 1;
    point.units += row.itemQty;
    if (isSettled({ status: row.statusSlug })) point.settled += row.itemsTotal;
    if (isReturned({ status: row.statusSlug })) point.returned += row.itemsTotal;
    if (includeDiscount && Array.isArray(row.items)) {
      // Gross is accumulated per line so the net figure (itemsTotal) stays the source of truth.
      for (const it of row.items) {
        const qty = Number(it.quantity) || 0;
        point.gross = (point.gross ?? 0) + (it.originalPrice == null ? Number(it.price) || 0 : Number(it.originalPrice) || 0) * qty;
      }
    }
  }

  for (const point of byKey.values()) {
    if (point.gross !== null) point.discount = Math.round(point.gross - point.netSales);
  }

  const points: TrendPoint[] = [];
  let cursor = bucketStartAt(range.from, bucket);
  let guard = 0;
  while (cursor.getTime() < range.to.getTime() && guard < 100000) {
    const key = bucketKey(cursor, bucket);
    points.push(byKey.get(key) ?? emptyTrendPoint(key));
    cursor = bucketAdvance(cursor, bucket);
    guard += 1;
  }
  return points;
}

/** Status-slug → count, zero-filled for every known status so response shapes are stable. */
export function countByStatus(rows: AnalyticsProjectedOrder[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.statusSlug] = (counts[row.statusSlug] ?? 0) + 1;
  for (const slug of ORDER_STATUS_VALUES) {
    if (!(slug in counts)) counts[slug] = 0;
  }
  return counts;
}

export interface AnalyticsSummaryResponse {
  preset: AnalyticsRangePreset;
  from: string;
  to: string;
  bucket: AnalyticsBucket;
  channel: AnalyticsChannel;
  currency: 'DZD';
  summary: SummaryMetrics;
  /**
   * Earliest store order that carries the forward-only `originalPrice` line snapshot (D12) —
   * i.e. when exact gross/discount figures become possible. Store-wide (channels don't change
   * when data starts) and independent of the window.
   */
  discountSince: string | null;
  comparison: null | {
    from: string;
    to: string;
    summary: SummaryMetrics;
    deltas: Record<keyof SummaryMetrics, number | null>;
  };
}

export interface AnalyticsChannelsResponse {
  preset: AnalyticsRangePreset;
  from: string;
  to: string;
  bucket: AnalyticsBucket;
  channel: AnalyticsChannel;
  currency: 'DZD';
  channels: Array<{
    channel: Exclude<AnalyticsChannel, 'all'>;
    orders: number;
    netSales: number;
    units: number;
    /** Per-channel Phase 2 split (same coverage semantics as `SummaryMetrics.grossSales`). */
    grossSales: number | null;
    discount: number | null;
    shareOfNetSales: number | null;
    prevNetSales: number | null;
    deltaPct: number | null;
  }>;
}

export interface AnalyticsTrendResponse {
  preset: AnalyticsRangePreset;
  from: string;
  to: string;
  bucket: AnalyticsBucket;
  channel: AnalyticsChannel;
  currency: 'DZD';
  /** The primary figure the series was built for (Phase 2). */
  metric: AnalyticsTrendMetric;
  /** Whether the points' `gross`/`discount` fields are exact (D12 coverage). */
  discountAvailable: boolean;
  points: TrendPoint[];
}

export interface AnalyticsStatusResponse {
  preset: AnalyticsRangePreset;
  from: string;
  to: string;
  bucket: AnalyticsBucket;
  channel: AnalyticsChannel;
  currency: 'DZD';
  statuses: Record<string, number>;
}

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(ProductVariant.name)
    private readonly variantModel: Model<ProductVariantDocument>,
  ) {}

  /** Resolve a validated query into the concrete half-open window every read aggregates over. */
  resolveRange(query: AnalyticsRangeQueryDto): ResolvedAnalyticsRange {
    return resolveAnalyticsRange({
      preset: query.preset,
      from: query.from,
      to: query.to,
      bucket: query.bucket,
    });
  }

  /** The equal-length window immediately preceding `range` (decision D5). */
  previousPeriod(range: DateWindow): DateWindow {
    return previousPeriod(range);
  }

  /** The reporting channel to filter on (defaults to `all`). */
  channel(query: AnalyticsRangeQueryDto): AnalyticsChannel {
    return (query.channel as AnalyticsChannel) ?? ANALYTICS_DEFAULT_CHANNEL;
  }

  /** Whether the caller asked for a previous-period comparison. */
  wantsComparison(query: AnalyticsRangeQueryDto): boolean {
    return query.compare === 'true';
  }

  /**
   * Projects the store's orders in `[from, to)` down to what the metrics need. The store is
   * always passed in by the controller (session-derived), never read from the query — the
   * channel filter is the only client-controlled condition in the `$match`.
   */
  private async fetchProjected(
    scope: StoreScope,
    range: DateWindow,
    channel: AnalyticsChannel,
  ): Promise<AnalyticsProjectedOrder[]> {
    const match: Record<string, unknown> = {
      $or: [{ storeId: scope.storeId }, { vendorEmail: scope.vendorEmail }],
      isDeleted: { $ne: true },
      createdAt: { $gte: range.from, $lt: range.to },
    };
    if (channel !== 'all') {
      match.source = { $in: CHANNEL_SOURCES[channel as Exclude<AnalyticsChannel, 'all'>] };
    }

    const rows = await this.orderModel
      .aggregate([
        { $match: match },
        {
          $addFields: {
            // A status can be an embedded status document or, for legacy rows, a bare slug.
            statusSlug: { $ifNull: ['$status.slug', '$status'] },
            itemsTotal: {
              $sum: {
                $map: {
                  input: { $ifNull: ['$items', []] },
                  as: 'it',
                  in: { $multiply: ['$$it.price', { $ifNull: ['$$it.quantity', 0] }] },
                },
              },
            },
            itemQty: {
              $sum: {
                $map: {
                  input: { $ifNull: ['$items', []] },
                  as: 'it',
                  in: { $ifNull: ['$$it.quantity', 0] },
                },
              },
            },
          },
        },
        {
          $project: {
            _id: 1,
            createdAt: 1,
            statusSlug: 1,
            itemsTotal: 1,
            itemQty: 1,
            source: 1,
            // Phase 2: only the fields the gross/discount split needs per line.
            items: {
              value: 1,
              price: 1,
              quantity: 1,
              originalPrice: 1,
            },
          },
        },
      ])
      .exec();

    return rows.map((r: any) => ({
      _id: String(r._id),
      createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
      statusSlug: r.statusSlug ? String(r.statusSlug) : '',
      itemsTotal: Number(r.itemsTotal) || 0,
      itemQty: Number(r.itemQty) || 0,
      source: r.source ? String(r.source) : null,
      items: Array.isArray(r.items)
        ? r.items.map((it: any) => ({
            price: Number(it.price) || 0,
            quantity: Number(it.quantity) || 0,
            // Only emitted when present so an absent field [legacy] vs `null` [recorded
            // zero discount] remain distinguishable — the coverage signal (D12).
            ...('originalPrice' in it ? { originalPrice: it.originalPrice == null ? null : Number(it.originalPrice) || 0 } : {}),
          }))
        : undefined,
    }));
  }

  private toIso(d: Date): string {
    return d.toISOString();
  }

  /**
   * Earliest store order that already carries a forward-only `originalPrice` line snapshot.
   * Uses field *presence* ($exists), matching the coverage semantic: a line written with `null`
   * (recorded zero discount) is exactly as informative as one with a number. Never backfilled,
   * so after the Phase 2 deploy it is the first order of that store. Stores with no snapshot
   * yet return `null` and the UI shows "discount data unavailable".
   */
  private async discountSince(scope: StoreScope): Promise<string | null> {
    const doc = await this.orderModel
      .findOne({
        $or: [{ storeId: scope.storeId }, { vendorEmail: scope.vendorEmail }],
        isDeleted: { $ne: true },
        'items.originalPrice': { $exists: true },
      })
      .select('createdAt')
      .sort({ createdAt: 1 })
      .lean()
      .exec();
    const created = (doc as any)?.createdAt;
    if (!created) return null;
    return (created instanceof Date ? created : new Date(created)).toISOString();
  }

  /** GET /analytics/summary — the KPI tiles plus optional previous-period deltas (D5). */
  async summary(scope: StoreScope, query: AnalyticsRangeQueryDto): Promise<AnalyticsSummaryResponse> {
    const range = this.resolveRange(query);
    const channel = this.channel(query);
    const current = summarize(await this.fetchProjected(scope, range, channel));
    const discountSince = await this.discountSince(scope);

    const response: AnalyticsSummaryResponse = {
      preset: range.preset,
      from: this.toIso(range.from),
      to: this.toIso(range.to),
      bucket: range.bucket,
      channel,
      currency: 'DZD',
      summary: current,
      discountSince,
      comparison: null,
    };

    if (this.wantsComparison(query)) {
      const prev = this.previousPeriod(range);
      const previous = summarize(await this.fetchProjected(scope, prev, channel));
      const keys: Array<keyof SummaryMetrics> = [
        'netSales',
        'settled',
        'returned',
        'grossVolume',
        'grossSales',
        'discount',
        'orderCount',
        'units',
        'aov',
      ];
      const deltas = {} as Record<keyof SummaryMetrics, number | null>;
      for (const key of keys) {
        // A `null` current or previous metric has no computable change (e.g. gross sales
        // before coverage existed, or AOV with no orders).
        const cur = current[key];
        const prevValue = previous[key];
        deltas[key] = cur === null || prevValue === null
          ? null
          : percentDelta(cur as number, (prevValue ?? 0) as number);
      }
      response.comparison = {
        from: this.toIso(prev.from),
        to: this.toIso(prev.to),
        summary: previous,
        deltas,
      };
    }

    return response;
  }

  /** GET /analytics/trend — the net-sales series bucketed over the window (D4). Phase 2: the
   *  primary figure is chosen by `metric`; `sales` additionally costs the points with the
   *  gross/discount breakdown when the window is fully covered. */
  async trend(scope: StoreScope, query: AnalyticsRangeQueryDto): Promise<AnalyticsTrendResponse> {
    const range = this.resolveRange(query);
    const channel = this.channel(query);
    const metric = (query.metric as AnalyticsTrendMetric) ?? ANALYTICS_DEFAULT_TREND_METRIC;
    const rows = await this.fetchProjected(scope, range, channel);
    const breakdown = salesBreakdown(rows);
    return {
      preset: range.preset,
      from: this.toIso(range.from),
      to: this.toIso(range.to),
      bucket: range.bucket,
      channel,
      currency: 'DZD',
      metric,
      discountAvailable: breakdown.available,
      points: trendSeries(rows, range, range.bucket, breakdown.available),
    };
  }

  /**
   * GET /analytics/channels — the online / in-store / manual split (D6). Always returns the
   * full three-way split of the session store. `channel` narrows the row set *and* which rows
   * are counted, so filtering in-store shows exactly the in-store numbers with share 100%.
   */
  async channels(scope: StoreScope, query: AnalyticsRangeQueryDto): Promise<AnalyticsChannelsResponse> {
    const range = this.resolveRange(query);
    const channel = this.channel(query);
    const rows = await this.fetchProjected(scope, range, channel);
    const byChannel = new Map(summarizeChannels(rows).map((c) => [c.channel, c]));
    const totalNet = [...byChannel.values()].reduce((sum, c) => sum + c.netSales, 0);

    let compareRows: AnalyticsProjectedOrder[] = [];
    let compareByChannel = new Map<Exclude<AnalyticsChannel, 'all'>, ChannelMetrics>();
    if (this.wantsComparison(query)) {
      const prev = this.previousPeriod(range);
      compareRows = await this.fetchProjected(scope, prev, channel);
      compareByChannel = new Map(summarizeChannels(compareRows).map((c) => [c.channel, c]));
    }

    let requested: Exclude<AnalyticsChannel, 'all'>[];
    if (channel === 'all') {
      requested = ['online', 'in-store', 'manual'];
    } else {
      requested = [channel as Exclude<AnalyticsChannel, 'all'>];
    }

    return {
      preset: range.preset,
      from: this.toIso(range.from),
      to: this.toIso(range.to),
      bucket: range.bucket,
      channel,
      currency: 'DZD',
      channels: requested.map((name) => {
        const cur = byChannel.get(name) ?? { channel: name, orders: 0, netSales: 0, units: 0 };
        const prev = compareByChannel.get(name)?.netSales ?? 0;
        // Per-channel Phase 2 split: coverage is judged across just this channel's rows, so one
        // channel can show an exact gross/discount while another (with a legacy line) does not.
        const breakdown = salesBreakdown(rows.filter((r) => channelOf(r.source) === name));
        return {
          channel: name,
          orders: cur.orders,
          netSales: cur.netSales,
          units: cur.units,
          grossSales: breakdown.grossSales,
          discount: breakdown.discount,
          shareOfNetSales: totalNet === 0 ? null : (cur.netSales / totalNet) * 100,
          prevNetSales: this.wantsComparison(query) ? prev : null,
          deltaPct: this.wantsComparison(query) ? percentDelta(cur.netSales, prev) : null,
        };
      }),
    };
  }
  async ordersStatus(scope: StoreScope, query: AnalyticsRangeQueryDto): Promise<AnalyticsStatusResponse> {
    const range = this.resolveRange(query);
    const channel = this.channel(query);
    const rows = await this.fetchProjected(scope, range, channel);
    return {
      preset: range.preset,
      from: this.toIso(range.from),
      to: this.toIso(range.to),
      bucket: range.bucket,
      channel,
      currency: 'DZD',
      statuses: countByStatus(rows),
    };
  }
  async products(_scope: StoreScope, _query: AnalyticsRangeQueryDto): Promise<any> { return { items: [], total: 0 }; }
  async productsNoSales(_scope: StoreScope, _query: AnalyticsRangeQueryDto): Promise<any> { return { items: [], total: 0 }; }
  async productVariants(_scope: StoreScope, _query: AnalyticsRangeQueryDto, _productId: string): Promise<any> { return { productId: _productId, items: [] }; }
}
