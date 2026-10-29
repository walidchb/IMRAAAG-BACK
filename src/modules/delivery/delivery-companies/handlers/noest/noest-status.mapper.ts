import { createHash } from 'crypto';
import {
  NoestActivityDto,
  NoestDiscoveryEntry,
  NoestHistoryResponseDto,
  NoestStatusSnapshot,
  NoestTimelineEntry,
} from './noest-status.types';

/**
 * Maps Noest event keys to normalized platform statuses.
 */
export function normalizeNoestEvent(event: string): string {
  const normalizedEvent = event?.toLowerCase().trim() || '';

  const map: Record<string, string> = {
    // Initial processing states
    upload: 'processing',
    customer_validation: 'processing',
    validation_collect_colis: 'processing',
    validation_reception_admin: 'processing',
    validation_reception: 'processing',
    received_at_hub: 'processing',

    // Ready for pickup/collection
    pickedup: 'ready_for_pickup',
    picked_up: 'ready_for_pickup',
    valid_return_pickup: 'ready_for_pickup',

    // In transit states
    fdr_activated: 'out_for_delivery',
    sent_to_redispatch: 'dispatch_local',
    dispatched: 'dispatch_local',
    in_transit: 'dispatch_interwilaya',
    out_for_delivery: 'out_for_delivery',

    // Out for delivery
    // (fdr_activated = "Out for delivery" = route sheet activated)

    // Delivered states
    livre: 'delivered',
    livred: 'delivered', // Typo variant in API
    delivered: 'delivered',

    // Failed delivery
    // `mise_a_jour` is a failed attempt, not a terminal state and not a new dispatch: it stays
    // `processing` so it never emits an order signal (Q-6).
    mise_a_jour: 'processing',

    // Return states
    return_asked_by_customer: 'returned',
    return_asked_by_hub: 'returned',
    retour_dispatched_to_partenaires: 'returned',
    return_dispatched_to_partenaire: 'returned',
    colis_retour_transmit_to_partner: 'returned',
    livraison_echoue_recu: 'returned',
    return_validated_by_partener: 'returned',
    return_redispatched_to_livraison: 'returned',
    return_dispatched_to_warehouse: 'returned',
    returned: 'returned',

    // Pickup states
    colis_pickup_transmit_to_partner: 'at_pickup_point',
    pickup_picked_recu: 'at_pickup_point',
    ready_for_pickup: 'ready_for_pickup',

    // Suspended/On hold — no dedicated platform status; `processing` carries no order signal.
    colis_suspendu: 'processing',

    // Cancelled
    annulation_dispatch_retour: 'cancelled',
    cancel_return_dispatched_to_partenaire: 'cancelled',
    cancelled: 'cancelled',

    // Payment/Settlement (map to delivered as final state)
    verssement_admin_cust: 'delivered',
    validation_reception_cash_by_partener: 'delivered',

    // Exchange (map to processing)
    echange_valide: 'processing',
    echange_valid_by_hub: 'processing',

    // Administrative
    ask_to_delete_by_admin: 'cancelled',
    ask_to_delete_by_hub: 'cancelled',
    edited_informations: 'processing',
    edit_price: 'processing',
    edit_wilaya: 'processing',
    extra_fee: 'processing',

    // New attempt requested
    nouvel_tentative_asked_by_customer: 'processing',
  };

  return map[normalizedEvent] || 'unknown';
}

/**
 * Derives situation flags from Noest event key.
 */
export function deriveSituationFlags(event: string): string[] {
  const normalizedEvent = event?.toLowerCase().trim() || '';
  const flags: string[] = [];

  // Delivered
  if (['livre', 'livred'].includes(normalizedEvent)) {
    flags.push('DELIVERED');
  }

  // Delivery failed
  if (['mise_a_jour'].includes(normalizedEvent)) {
    flags.push('DELIVERY_FAILED');
  }

  // Returned
  if ([
    'return_asked_by_customer',
    'return_asked_by_hub',
    'retour_dispatched_to_partenaires',
    'return_dispatched_to_partenaire',
    'colis_retour_transmit_to_partner',
    'livraison_echoue_recu',
    'return_validated_by_partener',
    'return_redispatched_to_livraison',
    'return_dispatched_to_warehouse',
  ].includes(normalizedEvent)) {
    flags.push('RETURNED');
  }

  // Cancelled
  if ([
    'annulation_dispatch_retour',
    'cancel_return_dispatched_to_partenaire',
    'ask_to_delete_by_admin',
    'ask_to_delete_by_hub',
  ].includes(normalizedEvent)) {
    flags.push('CANCELLED');
  }

  // Out for delivery
  if (['fdr_activated'].includes(normalizedEvent)) {
    flags.push('OUT_FOR_DELIVERY');
  }

  // At pickup point
  if ([
    'colis_pickup_transmit_to_partner',
    'pickup_picked_recu',
    'pickedup',
  ].includes(normalizedEvent)) {
    flags.push('AT_PICKUP_POINT');
  }

  return flags;
}

/**
 * Generates a deterministic timeline ID from activity data.
 */
function generateTimelineId(
  tracking: string,
  activity: NoestActivityDto,
): string {
  const input = [
    tracking || '',
    activity.date || '',
    activity.event || activity.event_key || '',
    activity.by || activity.name || '',
    activity.driver || '',
  ]
    .filter(Boolean)
    .join('|');

  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 40);
}

/**
 * Maps a Noest discovery entry to a status snapshot.
 */
export function mapNoestDiscoveryEntry(
  entry: NoestDiscoveryEntry,
  tracking: string,
): NoestStatusSnapshot {
  const activity = entry.activity || [];

  // Sort activity oldest to newest (verified: API returns in this order)
  const sortedActivity = [...activity].sort((a, b) => {
    const dateA = a.date ? new Date(a.date).getTime() : 0;
    const dateB = b.date ? new Date(b.date).getTime() : 0;
    return dateA - dateB;
  });

  const latestActivity = sortedActivity[sortedActivity.length - 1];

  if (!latestActivity) {
    // Empty activity: fallback to OrderInfo status or processing
    const fallbackStatus = String(entry.OrderInfo?.status || entry.status || 'unknown');
    return {
      providerState: fallbackStatus,
      providerStateName: fallbackStatus,
      normalizedStatus: 'processing',
      situations: [],
      timeline: [],
    };
  }

  // Map timeline entries
  const timeline: NoestTimelineEntry[] = sortedActivity
    .filter((act) => act.event || act.event_key)
    .map((act) => ({
      providerEntryId: generateTimelineId(tracking, act),
      event: act.event_key || act.event || 'unknown',
      date: act.date ? new Date(act.date) : new Date(),
      location: act.by || act.name || undefined,
      description: act.event || undefined,
      status: act.event || undefined,
      causer: act.causer || undefined,
      createdAt: new Date(),
    }));

  const providerState = latestActivity.event_key || latestActivity.event || 'unknown';
  const normalizedStatus = normalizeNoestEvent(providerState);
  const situations = deriveSituationFlags(providerState);

  return {
    providerState,
    providerStateName: String(latestActivity.event || latestActivity.event_key || ''),
    normalizedStatus,
    situations,
    timeline,
  };
}

/**
 * Maps a Noest history response to a status snapshot.
 */
export function mapNoestHistoryResponse(
  response: NoestHistoryResponseDto,
): NoestStatusSnapshot {
  const history = response.history || [];
  const tracking = response.tracking || 'unknown';

  // Sort history oldest to newest
  const sortedHistory = [...history].sort((a, b) => {
    const dateA = a.date ? new Date(a.date).getTime() : 0;
    const dateB = b.date ? new Date(b.date).getTime() : 0;
    return dateA - dateB;
  });

  const latestEntry = sortedHistory[sortedHistory.length - 1];

  if (!latestEntry) {
    return {
      providerState: response.status || 'unknown',
      providerStateName: response.status || 'unknown',
      normalizedStatus: 'unknown',
      situations: [],
      timeline: [],
    };
  }

  // Map timeline entries
  const timeline: NoestTimelineEntry[] = sortedHistory
    .filter((entry) => entry.event || entry.event_key)
    .map((entry) => ({
      providerEntryId: generateTimelineId(tracking, entry),
      event: entry.event_key || entry.event || 'unknown',
      date: entry.date ? new Date(entry.date) : new Date(),
      location: entry.by || entry.name || undefined,
      description: entry.event || undefined,
      status: entry.event || undefined,
      causer: entry.causer || undefined,
      createdAt: new Date(),
    }));

  const providerState = latestEntry.event_key || latestEntry.event || 'unknown';
  const normalizedStatus = normalizeNoestEvent(providerState);
  const situations = deriveSituationFlags(providerState);

  return {
    providerState,
    providerStateName: String(latestEntry.event || latestEntry.event_key || ''),
    normalizedStatus,
    situations,
    timeline,
  };
}
