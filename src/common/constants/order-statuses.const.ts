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
  slug: string;
  displayName: string;
  nameEn: string;
  nameFr: string;
  nameAr: string;
  color: string;
  sortOrder: number;
}

export const ORDER_STATUSES: StatusConfig[] = [
  { slug: 'placed',       displayName: 'Placed',         nameEn: 'Placed',          nameFr: 'Commandée',              nameAr: 'تم الطلب',      color: 'amber',   sortOrder: 1 },
  { slug: 'confirmed',    displayName: 'Confirmed',      nameEn: 'Confirmed',       nameFr: 'Confirmée',              nameAr: 'تم التأكيد',    color: 'blue',    sortOrder: 2 },
  { slug: 'dispatched',   displayName: 'Dispatched',     nameEn: 'Dispatched',      nameFr: 'Expédiée',               nameAr: 'تم التوزيع',    color: 'gold',    sortOrder: 3 },
  { slug: 'in-transit',   displayName: 'In Transit',     nameEn: 'In Transit',      nameFr: 'En Transit',             nameAr: 'قيد النقل',     color: 'purple',  sortOrder: 4 },
  { slug: 'delivered',    displayName: 'Delivered',      nameEn: 'Delivered',       nameFr: 'Livrée',                 nameAr: 'تم التوصيل',    color: 'emerald', sortOrder: 5 },
  { slug: 'cancelled',    displayName: 'Cancelled',      nameEn: 'Cancelled',       nameFr: 'Annulée',                nameAr: 'ملغي',          color: 'red',     sortOrder: 6 },
  { slug: 'returned',     displayName: 'Returned',       nameEn: 'Returned',        nameFr: 'Retournée',              nameAr: 'مرتجع',         color: 'rose',    sortOrder: 7 },
];

export const ORDER_STATUS_TRANSITIONS: Record<string, string[]> = {
  [OrderStatus.PLACED]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.DISPATCHED, OrderStatus.CANCELLED],
  [OrderStatus.DISPATCHED]: [OrderStatus.IN_TRANSIT, OrderStatus.CANCELLED],
  [OrderStatus.IN_TRANSIT]: [OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.DELIVERED]: [OrderStatus.RETURNED],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.RETURNED]: [],
};
