/**
 * Pure Box pricing/availability math.
 *
 * All of it is deterministic so the builder, the cart quote and order creation can share the
 * same rules and never disagree (plan §3.3.2 / §6). No I/O, no mongoose, no state.
 */

export interface BoxUnitAvailability {
  unitPrice: number;
  available: number;
}

export interface BoxSelectionInput {
  variantId: string;
  quantity: number;
}

export interface BoxPricingBox {
  price: number;
  requiredQuantity: number;
  allowDuplicates: boolean;
}

export interface BoxPricingEligibilityEntry {
  productId: string;
  storeId: string;
  isActive: boolean;
  isDeleted: boolean;
  productPublished: boolean;
  productArchived: boolean;
}

export type BoxSelectionIssueCode =
  | 'BOX_NOT_FOUND'
  | 'BOX_NOT_ACTIVE'
  | 'BOX_ARCHIVED'
  | 'BOX_STORE_MISMATCH'
  | 'BOX_SELECTION_INVALID'
  | 'BOX_SELECTION_UNAVAILABLE';

function aggregateQuantities(
  selections: BoxSelectionInput[],
): Map<string, number> {
  const byVariant = new Map<string, number>();
  for (const selection of selections) {
    byVariant.set(
      selection.variantId,
      (byVariant.get(selection.variantId) ?? 0) + selection.quantity,
    );
  }
  return byVariant;
}

/**
 * How many complete Boxes a set of variant balances can supply (D5).
 *
 * - duplicates allowed: `floor(Σ available / requiredQuantity)`.
 * - duplicates disallowed: the `requiredQuantity`-th largest availability (0 when fewer
 *   than `requiredQuantity` variants have any stock). A variant contributes at most one
 *   unit per Box, so the cheapest way to fill a Box is to pick distinct variants.
 */
export function availableBoxes(
  availabilities: number[],
  requiredQuantity: number,
  allowDuplicates: boolean,
): number {
  if (!Number.isFinite(requiredQuantity) || requiredQuantity <= 0) return 0;
  const positive = availabilities.map((a) =>
    Number.isFinite(a) ? Math.max(0, Math.floor(a)) : 0,
  );

  if (allowDuplicates) {
    const total = positive.reduce((sum, a) => sum + a, 0);
    return Math.floor(total / requiredQuantity);
  }

  const sorted = positive.sort((a, b) => b - a);
  if (sorted.length < requiredQuantity) return 0;
  return Math.max(0, sorted[requiredQuantity - 1]);
}

function expandedPrices(
  units: BoxUnitAvailability[],
  requiredQuantity: number,
  allowDuplicates: boolean,
): number[] {
  const prices: number[] = [];
  for (const unit of units) {
    if (!Number.isFinite(unit.unitPrice) || unit.unitPrice < 0) continue;
    const available = Number.isFinite(unit.available)
      ? Math.max(0, Math.floor(unit.available))
      : 0;
    // Cap at requiredQuantity: taking more than a Box needs can never change best/worst.
    const cap = allowDuplicates
      ? Math.min(available, requiredQuantity)
      : available > 0
        ? 1
        : 0;
    for (let i = 0; i < cap; i += 1) prices.push(unit.unitPrice);
  }
  return prices;
}

/** Cheapest `requiredQuantity` in-stock units; `null` when the Box cannot be filled. */
export function bestReferenceTotal(
  units: BoxUnitAvailability[],
  requiredQuantity: number,
  allowDuplicates: boolean,
): number | null {
  if (!Number.isFinite(requiredQuantity) || requiredQuantity <= 0) return null;
  const prices = expandedPrices(units, requiredQuantity, allowDuplicates);
  if (prices.length < requiredQuantity) return null;
  prices.sort((a, b) => a - b);
  return prices.slice(0, requiredQuantity).reduce((sum, p) => sum + p, 0);
}

/** Most expensive `requiredQuantity` in-stock units; `null` when the Box cannot be filled. */
export function worstReferenceTotal(
  units: BoxUnitAvailability[],
  requiredQuantity: number,
  allowDuplicates: boolean,
): number | null {
  if (!Number.isFinite(requiredQuantity) || requiredQuantity <= 0) return null;
  const prices = expandedPrices(units, requiredQuantity, allowDuplicates);
  if (prices.length < requiredQuantity) return null;
  prices.sort((a, b) => b - a);
  return prices.slice(0, requiredQuantity).reduce((sum, p) => sum + p, 0);
}

/** Regular total of one Box's chosen composition. */
export function selectionReferenceTotal(
  selections: BoxSelectionInput[],
  unitPriceByVariant: Map<string, number>,
): number {
  let total = 0;
  for (const selection of selections) {
    const price = unitPriceByVariant.get(selection.variantId) ?? 0;
    total += price * (Number(selection.quantity) || 0);
  }
  return total;
}

/** Positive saving only; never a negative "discount" (plan §3.6). */
export function selectionSavings(referenceTotal: number, boxPrice: number): number {
  return Math.max(0, referenceTotal - boxPrice);
}

/**
 * How many Boxes exactly this composition can supply.
 *
 * `min(floor(available / requestedUnits))` per selected variant; 0 if any variant is
 * missing from the availability map or short. This is the number the cart stepper must
 * respect — it is *not* the best-composition figure shown on a listing card.
 */
export function selectionAvailableBoxes(
  selections: BoxSelectionInput[],
  availability: Map<string, number>,
): number {
  const byVariant = aggregateQuantities(selections);
  if (byVariant.size === 0) return 0;

  let boxes = Number.POSITIVE_INFINITY;
  for (const [variantId, quantity] of byVariant) {
    if (!Number.isFinite(quantity) || quantity <= 0) return 0;
    const available = availability.get(variantId) ?? 0;
    boxes = Math.min(boxes, Math.floor(available / quantity));
  }
  return Number.isFinite(boxes) ? Math.max(0, boxes) : 0;
}

/**
 * The single selection validator shared by the public validate endpoint, the cart and order
 * creation (plan §3.3.2). Returns issue codes, never throws.
 *
 * `mode` decides whether a product's publication matters: the public builder and the cart
 * both require published, non-archived products; `public` additionally requires the Box
 * itself to be published (already enforced by the loader).
 */
export function selectionIssues(params: {
  box: BoxPricingBox & {
    storeId: string;
    published: boolean;
    isArchived: boolean;
  };
  selections: BoxSelectionInput[];
  eligibility: Map<string, BoxPricingEligibilityEntry>;
  availability: Map<string, number>;
  storeId: string;
  mode: 'public' | 'cart';
}): BoxSelectionIssueCode[] {
  const { box, selections, eligibility, availability, storeId, mode } = params;
  const issues = new Set<BoxSelectionIssueCode>();

  if (box.isArchived) issues.add('BOX_ARCHIVED');
  if (!box.published) issues.add('BOX_NOT_ACTIVE');
  if (String(box.storeId) !== String(storeId)) issues.add('BOX_STORE_MISMATCH');

  const validShape =
    Array.isArray(selections) &&
    selections.length > 0 &&
    selections.length <= 50 &&
    selections.every(
      (s) =>
        typeof s.variantId === 'string' &&
        s.variantId.trim().length > 0 &&
        Number.isInteger(s.quantity) &&
        s.quantity >= 1 &&
        s.quantity <= 50,
    );
  if (!validShape) issues.add('BOX_SELECTION_INVALID');

  const byVariant = aggregateQuantities(selections ?? []);
  if (byVariant.size !== (selections ?? []).length) {
    // A repeated variant id is a forged/ambiguous selection.
    issues.add('BOX_SELECTION_INVALID');
  }

  const selectedQuantity = [...byVariant.values()].reduce((sum, q) => sum + q, 0);
  if (selectedQuantity !== box.requiredQuantity) {
    issues.add('BOX_SELECTION_INVALID');
  }

  if (!box.allowDuplicates) {
    for (const quantity of byVariant.values()) {
      if (quantity > 1) issues.add('BOX_SELECTION_INVALID');
    }
  }

  for (const [variantId, quantity] of byVariant) {
    const entry = eligibility.get(variantId);
    if (!entry || entry.isDeleted || !entry.isActive) {
      issues.add('BOX_SELECTION_INVALID');
      continue;
    }
    if (String(entry.storeId) !== String(storeId)) {
      issues.add('BOX_STORE_MISMATCH');
    }
    if (entry.productArchived) issues.add('BOX_SELECTION_INVALID');
    if (mode === 'public' && !entry.productPublished) {
      issues.add('BOX_SELECTION_INVALID');
    }
    const available = availability.get(variantId) ?? 0;
    if (available < quantity) issues.add('BOX_SELECTION_UNAVAILABLE');
  }

  return [...issues];
}
