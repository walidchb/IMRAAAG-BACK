import type { AnalyticsProductMetric } from '../constants/analytics.constants';

/**
 * Top-products ranking (decisions D-P3–D-P8).
 *
 * Pure grouping so the aggregation stays a thin read: each sales-eligible standalone line
 * contributes its quantity and charged value once, variants roll up to their parent product, and
 * "orders" counts distinct orders rather than lines.
 */

export interface ProductSalesLine {
  orderId: string;
  productId?: string | null;
  productName?: string | null;
  image?: string | null;
  quantity: number;
  price: number;
}

export interface RankedProduct {
  productId: string;
  units: number;
  sales: number;
  orders: number;
  snapshotName: string | null;
  snapshotImage: string | null;
}

export interface RankProductsOptions {
  metric: AnalyticsProductMetric;
  limit: number;
}

interface ProductAccumulator {
  units: number;
  sales: number;
  orderIds: Set<string>;
  snapshotName: string | null;
  snapshotImage: string | null;
}

function compareProductId(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareByMetric(a: RankedProduct, b: RankedProduct, metric: AnalyticsProductMetric): number {
  if (metric === 'sales') {
    return b.sales - a.sales || b.units - a.units || b.orders - a.orders || compareProductId(a.productId, b.productId);
  }
  if (metric === 'orders') {
    return b.orders - a.orders || b.units - a.units || b.sales - a.sales || compareProductId(a.productId, b.productId);
  }
  return b.units - a.units || b.sales - a.sales || b.orders - a.orders || compareProductId(a.productId, b.productId);
}

export function rankProducts(
  lines: readonly ProductSalesLine[],
  options: RankProductsOptions,
): { items: RankedProduct[]; total: number } {
  const byProduct = new Map<string, ProductAccumulator>();

  for (const line of lines) {
    const productId = line.productId == null ? '' : String(line.productId).trim();
    if (!productId) continue;

    let accumulator = byProduct.get(productId);
    if (!accumulator) {
      accumulator = {
        units: 0,
        sales: 0,
        orderIds: new Set<string>(),
        snapshotName: null,
        snapshotImage: null,
      };
      byProduct.set(productId, accumulator);
    }

    const quantity = Number.isFinite(line.quantity) ? line.quantity : 0;
    const price = Number.isFinite(line.price) ? line.price : 0;

    accumulator.units += quantity;
    accumulator.sales += price * quantity;
    if (line.orderId) accumulator.orderIds.add(line.orderId);
    if (!accumulator.snapshotName && line.productName) accumulator.snapshotName = line.productName;
    if (!accumulator.snapshotImage && line.image) accumulator.snapshotImage = line.image;
  }

  const items: RankedProduct[] = [];
  for (const [productId, accumulator] of byProduct) {
    items.push({
      productId,
      units: accumulator.units,
      sales: accumulator.sales,
      orders: accumulator.orderIds.size,
      snapshotName: accumulator.snapshotName,
      snapshotImage: accumulator.snapshotImage,
    });
  }

  items.sort((a, b) => compareByMetric(a, b, options.metric));

  const total = items.length;
  const limit = Math.max(0, options.limit);
  return { items: items.slice(0, limit), total };
}
