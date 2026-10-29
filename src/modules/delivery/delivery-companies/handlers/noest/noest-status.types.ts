export interface NoestActivityDto {
  event?: string | null;
  event_key?: string | null;
  causer?: string | null;
  'badge-class'?: string | null;
  by?: string | null;
  name?: string | null;
  driver?: string | null;
  fdr?: string | null;
  date?: string | null;
  [key: string]: unknown;
}

export interface NoestOrderInfoDto {
  id?: string | number | null;
  tracking?: string | null;
  reference?: string | null;
  client?: string | null;
  phone?: string | null;
  phone_2?: string | null;
  adresse?: string | null;
  wilaya_id?: string | number | null;
  commune?: string | null;
  montant?: string | number | null;
  remarque?: string | null;
  produit?: string | null;
  driver_name?: string | null;
  driver_tel?: string | null;
  type_id?: string | number | null;
  stop_desk?: string | number | null;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface NoestDiscoveryEntry {
  OrderInfo?: NoestOrderInfoDto | null;
  status?: string | null;
  activity?: NoestActivityDto[] | null;
  recipientName?: string | null;
  shippedBy?: string | null;
  originCity?: string | number | null;
  destLocationCity?: string | number | null;
  deliveryAttempts?: unknown[] | null;
  [key: string]: unknown;
}

export interface NoestDiscoveryResponseDto {
  [tracking: string]: NoestDiscoveryEntry;
}

export interface NoestHistoryResponseDto {
  tracking?: string | null;
  reference?: string | null;
  status?: string | null;
  history?: NoestActivityDto[] | null;
  success?: boolean | null;
  message?: string | null;
  [key: string]: unknown;
}

export interface NoestTimelineEntry {
  providerEntryId: string;
  event: string;
  date: Date;
  location?: string;
  description?: string;
  status?: string;
  causer?: string;
  createdAt: Date;
}

export interface NoestStatusSnapshot {
  providerState: string;
  providerStateName?: string;
  normalizedStatus: string;
  situations: string[];
  timeline: NoestTimelineEntry[];
}
