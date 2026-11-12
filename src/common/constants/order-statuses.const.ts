export enum OrderStatus {
  PLACED = 'placed',
  CONFIRMED = 'confirmed',
  DISPATCHED = 'dispatched',
  IN_TRANSIT = 'in-transit',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
  RETURNED = 'returned',
}

export const ORDER_STATUS_VALUES: string[] = Object.values(OrderStatus);

export interface StatusConfig {
  _id: string;
  slug: string;
  displayName: string;
  nameEn: string;
  nameFr: string;
  nameAr: string;
  color: string;
  sortOrder: number;
}

/**
 * Statuses whose orders may be archived. Kept next to the transition map so a new
 * status is deliberately reviewed before it becomes archivable. The backend is the
 * authority; the frontend mirrors this list only to show/hide the action.
 */
export const ARCHIVABLE_ORDER_STATUSES: string[] = [
  OrderStatus.PLACED,
  OrderStatus.DELIVERED,
  OrderStatus.CANCELLED,
  OrderStatus.RETURNED,
];

export function isArchivableStatus(slug: string | null | undefined): boolean {
  return !!slug && ARCHIVABLE_ORDER_STATUSES.includes(slug);
}

export const ORDER_STATUS_TRANSITIONS: Record<string, string[]> = {
  [OrderStatus.PLACED]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.DISPATCHED, OrderStatus.CANCELLED],
  [OrderStatus.DISPATCHED]: [OrderStatus.IN_TRANSIT, OrderStatus.CANCELLED],
  [OrderStatus.IN_TRANSIT]: [OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.DELIVERED]: [OrderStatus.RETURNED],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.RETURNED]: [],
};
