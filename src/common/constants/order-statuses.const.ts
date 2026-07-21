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

export const ORDER_STATUSES: StatusConfig[] = [
  { _id: 'sts_placed',    slug: 'placed',       displayName: 'Placed (COD)',   nameEn: 'Placed (COD)',   nameFr: 'Commandée (COD)',              nameAr: 'تم الطلب (الدفع عند التوصيل)', color: 'amber',   sortOrder: 1 },
  { _id: 'sts_confirmed',  slug: 'confirmed',    displayName: 'Confirmed',      nameEn: 'Confirmed',      nameFr: 'Confirmée',                   nameAr: 'تم التأكيد',                   color: 'blue',    sortOrder: 2 },
  { _id: 'sts_dispatched', slug: 'dispatched',   displayName: 'Dispatched',     nameEn: 'Dispatched',     nameFr: 'Expédiée',                    nameAr: 'تم التوزيع',                   color: 'gold',    sortOrder: 3 },
  { _id: 'sts_in_transit', slug: 'in-transit',   displayName: 'In Transit',     nameEn: 'In Transit',     nameFr: 'En Transit',                  nameAr: 'قيد النقل',                    color: 'purple',  sortOrder: 4 },
  { _id: 'sts_delivered',  slug: 'delivered',    displayName: 'Delivered',      nameEn: 'Delivered',      nameFr: 'Livrée',                      nameAr: 'تم التوصيل',                   color: 'emerald', sortOrder: 5 },
  { _id: 'sts_cancelled',  slug: 'cancelled',    displayName: 'Cancelled',      nameEn: 'Cancelled',      nameFr: 'Annulée',                     nameAr: 'ملغي',                         color: 'red',     sortOrder: 6 },
  { _id: 'sts_returned',   slug: 'returned',     displayName: 'Returned',       nameEn: 'Returned',       nameFr: 'Retournée',                   nameAr: 'مرتجع',                        color: 'rose',    sortOrder: 7 },
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
