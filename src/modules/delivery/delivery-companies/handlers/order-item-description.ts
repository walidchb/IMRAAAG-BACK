import type { Order } from '../../../orders/schemas/order.schema';

type OrderItem = Order['items'][number];

/**
 * The variant's chosen value names, e.g. `['Rouge', 'M']`.
 *
 * New orders carry a structured `variantSnapshot`; legacy lines only have the joined
 * `variantDetails` label (`'Rouge / M'`), which is split back into its parts so both shapes
 * render the same way on a carrier label.
 */
function variantValueNames(item: OrderItem): string[] {
  const fromSnapshot = (item.variantSnapshot?.options ?? [])
    .map((option) => (option.valueName || option.value || '').trim())
    .filter((value) => value.length > 0);
  if (fromSnapshot.length > 0) return fromSnapshot;

  const legacy = (item.variantDetails || '').trim();
  if (!legacy) return [];
  return legacy
    .split(' / ')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * One order line as the carrier prints it, e.g. `"2 x Robe (Rouge) (M)"`.
 */
export function describeOrderItem(item: OrderItem): string {
  const quantity = item.quantity || 1;
  const productName =
    (item.productName || '').trim() || `Product ${item.productId || ''}`.trim();
  const variantSuffix = variantValueNames(item)
    .map((value) => `(${value})`)
    .join(' ');

  return [`${quantity} x ${productName}`, variantSuffix].filter(Boolean).join(' ');
}

/**
 * Every line of an order joined for carriers that take a single free-text description,
 * e.g. `"2 x Robe (Rouge) (M), 1 x Chaussures (Noir)"`. Falls back to `"Order <no>"`.
 */
export function describeOrderItems(order: Pick<Order, 'items' | 'orderNo'>): string {
  const description = (order.items ?? [])
    .map((item) => describeOrderItem(item))
    .filter((line) => line.length > 0)
    .join(', ');

  return description || `Order ${order.orderNo}`;
}
