import type {
  CarrierStatusProfile,
  CarrierSituationInput,
} from '../../../delivery-status/carrier/carrier-profile';
import {
  DELIVERED_NORMALIZED_STATUSES,
  IN_TRANSIT_NORMALIZED_STATUSES,
  CANCELLED_STATE_PATTERNS,
  RETURN_STATE_PATTERNS,
  matchesAnyToken,
  applySignalOverride,
} from '../../../delivery-status/carrier/carrier-signal';
import type {
  CarrierOrderSignal,
  DetectedCarrierOrderSignal,
  NormalizedDeliveryStatus,
  SituationFlag,
  SignalOverrides,
  StateOverrides,
} from '../../../delivery-status/carrier/carrier-signal';
import type {
  DeliveryStatusEntry,
  DeliveryStatusParcel,
} from '../../interfaces/delivery-company-handler.interface';
import {
  normalizeNoestEvent,
  deriveSituationFlags,
} from './noest-status.mapper';

/**
 * Checks if a Noest status is terminal (delivered band).
 */
export function isNoestTerminalStatus(status: string): boolean {
  return DELIVERED_NORMALIZED_STATUSES.includes(status as any);
}

/**
 * Detects order signal from Noest parcel status.
 */
export function detectNoestOrderSignal(
  parcel: DeliveryStatusParcel,
  history?: readonly DeliveryStatusEntry[] | null,
  signalOverrides?: SignalOverrides | null,
): DetectedCarrierOrderSignal {
  const latestState = parcel.carrierStateName || parcel.carrierStateDescription || '';

  // Check for store-specific override first
  const override = applySignalOverride(latestState, signalOverrides);
  if (override) {
    return { signal: override, source: 'override' };
  }

  const normalizedStatus = normalizeNoestEvent(latestState);
  const situations = deriveSituationFlags(latestState);

  // Priority: returned > cancelled > delivered > in_transit > none
  if (situations.includes('RETURNED')) {
    return { signal: 'returned', source: 'situation' };
  }

  if (situations.includes('CANCELLED')) {
    return { signal: 'cancelled', source: 'situation' };
  }

  if (situations.includes('DELIVERED')) {
    return { signal: 'delivered', source: 'situation' };
  }

  // Check normalized status for in_transit signal
  if (IN_TRANSIT_NORMALIZED_STATUSES.includes(normalizedStatus as any)) {
    return { signal: 'in_transit', source: 'state' };
  }

  // Also check raw state patterns for cancelled/returned (belt and braces)
  if (matchesAnyToken(latestState, RETURN_STATE_PATTERNS)) {
    return { signal: 'returned', source: 'state' };
  }

  if (matchesAnyToken(latestState, CANCELLED_STATE_PATTERNS)) {
    return { signal: 'cancelled', source: 'state' };
  }

  return { signal: 'none', source: 'state' };
}

/**
 * Derives situation flags for Noest situations.
 */
export function noestSituationFlags(
  situation: string | null,
  description: string | null,
): SituationFlag[] {
  const flags: SituationFlag[] = [];
  const text = situation || description || '';
  const normalized = text.toLowerCase().trim();

  // Map Noest situation patterns to platform flags
  if (normalized.includes('suspendu') || normalized.includes('on hold')) {
    flags.push('postponed');
  }

  if (normalized.includes('unreachable') || normalized.includes('injoignable')) {
    flags.push('unreachable');
  }

  if (normalized.includes('no answer') || normalized.includes('pas de reponse')) {
    flags.push('no_answer');
  }

  if (normalized.includes('address') || normalized.includes('adresse')) {
    flags.push('address_issue');
  }

  if (normalized.includes('pickup') || normalized.includes('retrait') || normalized.includes('stopdesk')) {
    flags.push('redirected_to_pickup');
    flags.push('awaiting_pickup');
  }

  if (normalized.includes('sms')) {
    flags.push('sms_sent');
  }

  if (
    normalized.includes('cancel') ||
    normalized.includes('annul') ||
    normalized.includes('delete')
  ) {
    flags.push('customer_cancelled');
  }

  // If no specific flags matched, mark as raw
  if (flags.length === 0 && text.trim()) {
    flags.push('raw');
  }

  return flags;
}

export const NOEST_STATUS_PROFILE: CarrierStatusProfile = {
  companyId: 'noest',
  displayName: 'Noest Express',
  historyUser: 'Noest Express',
  systemActor: 'noest-status-sync',

  normalizeState: (state, overrides): NormalizedDeliveryStatus => {
    const stateStr = String(state ?? '').trim().toLowerCase();

    // Check overrides first
    if (overrides && overrides[stateStr]) {
      const overrideValue = String(overrides[stateStr]).trim().toLowerCase();

      // First check if the override is already a valid normalized status
      const validNormalizedStatuses = [
        'received', 'processing', 'contacting_customer', 'customer_confirmed',
        'preparing', 'ready_for_pickup', 'at_pickup_point', 'dispatch_local',
        'dispatch_interwilaya', 'out_for_delivery', 'with_courier', 'delivered',
        'cash_collected', 'settled', 'cancelled', 'returned', 'unknown'
      ];

      if (validNormalizedStatuses.includes(overrideValue)) {
        return overrideValue as NormalizedDeliveryStatus;
      }

      // Otherwise try to normalize it as a Noest event key
      const normalized = normalizeNoestEvent(overrideValue);
      if (normalized !== 'unknown') return normalized as NormalizedDeliveryStatus;
    }

    return normalizeNoestEvent(stateStr) as NormalizedDeliveryStatus;
  },

  isTerminalState: (state) => {
    const normalized = normalizeNoestEvent(String(state ?? ''));
    return isNoestTerminalStatus(normalized);
  },

  detectSignal: (parcel, history, signalOverrides) =>
    detectNoestOrderSignal(parcel, history, signalOverrides),

  flagsForSituations: (situations: readonly CarrierSituationInput[]): SituationFlag[] =>
    situations.flatMap((situation) =>
      noestSituationFlags(
        situation.name ?? situation.slug ?? null,
        situation.description ?? null,
      ),
    ),

  deliverySignalForStatus: (status): CarrierOrderSignal => {
    const normalized = normalizeNoestEvent(String(status ?? ''));
    if (DELIVERED_NORMALIZED_STATUSES.includes(normalized as any)) return 'delivered';
    if (IN_TRANSIT_NORMALIZED_STATUSES.includes(normalized as any)) return 'in_transit';
    if (normalized === 'cancelled') return 'cancelled';
    if (normalized === 'returned') return 'returned';
    return 'none';
  },
};
