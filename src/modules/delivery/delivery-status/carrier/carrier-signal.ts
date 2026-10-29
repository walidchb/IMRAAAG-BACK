/** Every provider-neutral delivery status the platform knows. */
export type NormalizedDeliveryStatus =
  | 'received'
  | 'processing'
  | 'contacting_customer'
  | 'customer_confirmed'
  | 'preparing'
  | 'ready_for_pickup'
  | 'at_pickup_point'
  | 'dispatch_local'
  | 'dispatch_interwilaya'
  | 'out_for_delivery'
  | 'with_courier'
  | 'delivered'
  | 'cash_collected'
  | 'settled'
  | 'cancelled'
  | 'returned'
  | 'unknown';

export const NORMALIZED_STATUSES: readonly NormalizedDeliveryStatus[] = [
  'received',
  'processing',
  'contacting_customer',
  'customer_confirmed',
  'preparing',
  'ready_for_pickup',
  'at_pickup_point',
  'dispatch_local',
  'dispatch_interwilaya',
  'out_for_delivery',
  'with_courier',
  'delivered',
  'cash_collected',
  'settled',
  'cancelled',
  'returned',
  'unknown',
] as const;

export type CarrierOrderSignal = 'none' | 'in_transit' | 'delivered' | 'cancelled' | 'returned';

export const CARRIER_ORDER_SIGNALS: readonly CarrierOrderSignal[] = [
  'none',
  'in_transit',
  'delivered',
  'cancelled',
  'returned',
] as const;

export const CARRIER_SIGNAL_PRIORITY: readonly CarrierOrderSignal[] = [
  'returned',
  'cancelled',
  'delivered',
  'in_transit',
  'none',
] as const;

export type CarrierSignalSource = 'state' | 'situation' | 'override' | 'none';

export interface DetectedCarrierOrderSignal {
  signal: CarrierOrderSignal;
  source: CarrierSignalSource;
}

export type SignalOverrides = Readonly<Record<string, string>>;

export type StateOverrides = Readonly<Record<string, string>>;

export const IN_TRANSIT_NORMALIZED_STATUSES: readonly NormalizedDeliveryStatus[] = [
  'ready_for_pickup',
  'at_pickup_point',
  'dispatch_local',
  'dispatch_interwilaya',
  'out_for_delivery',
  'with_courier',
] as const;

export const DELIVERED_NORMALIZED_STATUSES: readonly NormalizedDeliveryStatus[] = [
  'delivered',
  'cash_collected',
  'settled',
] as const;

export const CANCELLED_STATE_PATTERNS: readonly string[] = [
  'annul',
  'annule',
  'annulee',
  'cancel',
] as const;

export const RETURN_STATE_PATTERNS: readonly string[] = [
  'retour',
  'retourn',
  'renvoy',
  'reinject',
  'restit',
  'refus',
] as const;

export const CANCELLED_SITUATION_PATTERNS: readonly string[] = [
  'annul',
  'annule',
  'annulee',
  'cancel',
] as const;

export const RETURN_SITUATION_PATTERNS: readonly string[] = [
  'retour',
  'retourn',
  'renvoy',
  'reinject',
  'restit',
  'refus',
] as const;

export type SituationFlag =
  | 'customer_cancelled'
  | 'unreachable'
  | 'no_answer'
  | 'call_attempt'
  | 'address_issue'
  | 'postponed'
  | 'redirected_to_pickup'
  | 'awaiting_pickup'
  | 'sms_sent'
  | 'raw';

export const SITUATION_FLAGS: readonly SituationFlag[] = [
  'customer_cancelled',
  'unreachable',
  'no_answer',
  'call_attempt',
  'address_issue',
  'postponed',
  'redirected_to_pickup',
  'awaiting_pickup',
  'sms_sent',
  'raw',
] as const;

export interface CarrierSignalHistoryEntry {
  toState: string | null;
  at: Date | null;
  situations?: readonly CarrierSignalSituation[] | null;
  raw?: unknown;
}

export interface CarrierSignalSituation {
  slug: string | null;
  name: string | null;
  description: string | null;
  flags: readonly string[];
}

export interface CarrierSignalParcel {
  carrierStateName?: string | null;
  carrierStateDescription?: string | null;
  deliveryStatus?: string | null;
  situationFlags?: readonly string[] | null;
  raw?: unknown;
}

export function normalizeText(value: unknown): string {
  return String(value === null || value === undefined ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function matchesAnyToken(value: unknown, patterns: readonly string[]): boolean {
  const text = normalizeText(value);
  if (!text) return false;
  return patterns.some((pattern) => text.includes(normalizeText(pattern)));
}

export function applySignalOverride(
  stateSlug: unknown,
  overrides?: SignalOverrides | null,
): CarrierOrderSignal | null {
  if (!stateSlug || !overrides) return null;
  const key = String(stateSlug).trim().toLowerCase();
  const value = overrides[key];
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLowerCase() as CarrierOrderSignal;
  return CARRIER_ORDER_SIGNALS.includes(normalized) ? normalized : null;
}

export function newestSignal(
  candidates: DetectedCarrierOrderSignal[],
): DetectedCarrierOrderSignal {
  for (const signal of CARRIER_SIGNAL_PRIORITY) {
    const match = candidates.find((candidate) => candidate.signal === signal && signal !== 'none');
    if (match) return match;
  }
  return { signal: 'none', source: 'none' };
}

export function isNormalizedStatus(value: unknown): value is NormalizedDeliveryStatus {
  return NORMALIZED_STATUSES.includes(value as NormalizedDeliveryStatus);
}
