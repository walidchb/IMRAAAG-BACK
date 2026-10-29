/**
 * The single definition of "low stock".
 *
 * Three buckets, deliberately disjoint:
 *   - `available <= 0`            → out of stock
 *   - `0 < available <= threshold` → low stock
 *   - `available > threshold`      → healthy
 *
 * `threshold` is the seller's own value when one is set, otherwise the platform default
 * below. Before this existed, every level of the chain defaulted to `null`, so a variant
 * that had never been configured could never be low - a one-unit variant read as "in stock".
 *
 * Kept in one module so every reader (store-wide list, store statistics, the vendor matrix,
 * the single-variant read, the write responses) resolves an unconfigured variant identically
 * instead of each re-deriving its own answer.
 */

/** Used when neither the balance, the variant, nor the product carries an override. */
export const DEFAULT_LOW_STOCK_THRESHOLD = 3;

/**
 * Full precedence: balance override > variant override > product default > platform default.
 * Always returns a number, so a variant nobody ever configured still has a threshold.
 */
export function resolveLowStockThreshold(
  balanceThreshold?: number | null,
  variantThreshold?: number | null,
  productThreshold?: number | null,
): number {
  return balanceThreshold ?? variantThreshold ?? productThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
}

/**
 * Whether a quantity is low - strictly above zero (an empty variant is *out*, not low) and at
 * or below the threshold. Mirrors the `$expr` in `inventory-read.service.ts`; keep the two in
 * step.
 */
export function isLowStock(available: number, threshold: number): boolean {
  return available > 0 && available <= threshold;
}
