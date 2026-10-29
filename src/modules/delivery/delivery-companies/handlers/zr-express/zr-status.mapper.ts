import {
  ZrParcelDto,
  ZrStateDto,
  ZrStateHistoryEntryDto,
  ZrSituationDto,
  ZrSituationHistoryDto,
} from './zr-status.types';

/**
 * The ZR Express status vocabulary — the platform's single source of truth for what a carrier
 * state means.
 *
 * This module was **frozen in Phase 0** (`ZR-EXPRESS-STATUS-SYNC-ROADMAP.md` §21.0) and is the
 * production home of the contract that was first drafted as a standalone script. It is a pure
 * module: no Nest decorators, no I/O, no imports outside the ZR types. That keeps it trivially
 * unit-testable and lets the read-only spike script validate the *same* catalogue the
 * application uses.
 *
 * Three rules hold everywhere in this file:
 *
 *  1. **Never guess.** An unrecognised carrier state maps to `unknown` and an unrecognised
 *     situation maps to `raw`. Neither is an error, and neither ever advances an order.
 *  2. **Key on the name, never the id.** A ZR state's `id` is a workflow-scoped uuid that
 *     differs per tenant; the `name` slug is the stable, meaningful value.
 *  3. **The carrier drives the order's life cycle, but only through the platform's rules.**
 *     It may advance, cancel or return an order; the order service still validates every step
 *     (`ZR-EXPRESS-STATUS-SYNC-BEHAVIOR-REFACTOR.md` §3.2). The mapper only *proposes* a plan.
 */

/* ------------------------------------------------------------------ *
 * The official ZR Express carrier catalogue
 * ------------------------------------------------------------------ */

export interface ZrCarrierState {
  /** The stable slug (`state.name`). */
  slug: string;
  /** The published French name. */
  nameFr: string;
  /** The published responsibility. */
  responsibility: string;
  /** The published description. */
  description: string;
  /** The published `visibleFor` bitmask. */
  visibleFor: number;
  /** The published `editableBy` bitmask. */
  editableBy: number;
}

/**
 * The 14 core workflow states, exactly as published in the ZR Express state-history reference
 * (`IMRAAAH-BACK/updates-zrexpress.md` § "Core Workflow States").
 */
export const CARRIER_STATES: readonly ZrCarrierState[] = [
  {
    slug: 'commande_recue',
    nameFr: 'Commande reçue',
    responsibility: 'Supplier',
    description: 'Initial creation of the parcel.',
    visibleFor: 1,
    editableBy: 3,
  },
  {
    slug: 'en_traitement',
    nameFr: 'En traitement',
    responsibility: 'Admin',
    description: 'Acknowledged by the system, awaiting validation.',
    visibleFor: 1,
    editableBy: 3,
  },
  {
    slug: 'appel_confirmation',
    nameFr: 'Appel de confirmation',
    responsibility: 'Call Center',
    description: 'Active phase where agents call the customer to confirm details.',
    visibleFor: 15,
    editableBy: 3,
  },
  {
    slug: 'commande_confirmee',
    nameFr: 'Commande confirmée',
    responsibility: 'Call Center',
    description: 'Order details validated with the customer.',
    visibleFor: 15,
    editableBy: 3,
  },
  {
    slug: 'en_preparation',
    nameFr: 'En préparation',
    responsibility: 'Supplier',
    description: 'Merchant is packing the items for the driver.',
    visibleFor: 3,
    editableBy: 3,
  },
  {
    slug: 'pret_a_expedier',
    nameFr: 'Prêt à expédier',
    responsibility: 'Supplier',
    description: 'Marking the parcel as ready for pickup from the supplier location.',
    visibleFor: 3,
    editableBy: 3,
  },
  {
    slug: 'confirme_au_bureau',
    nameFr: 'Confirmé au bureau',
    responsibility: 'Hub Agent',
    description: 'Parcel arrived at a ProDelivery Hub or StopDesk.',
    visibleFor: 7,
    editableBy: 2,
  },
  {
    slug: 'dispatch',
    nameFr: 'Dispatch (Local)',
    responsibility: 'Logistics',
    description: 'Sorting for delivery within the same city/wilaya.',
    visibleFor: 7,
    editableBy: 2,
  },
  {
    slug: 'vers_wilaya',
    nameFr: 'Dispatch (Inter-wilaya)',
    responsibility: 'Logistics',
    description: 'Transporting to another province hub.',
    visibleFor: 7,
    editableBy: 2,
  },
  {
    slug: 'en_livraison',
    nameFr: 'En livraison',
    responsibility: 'Admin',
    description: "Assigned to a specific delivery person's bag/tour.",
    visibleFor: 15,
    editableBy: 2,
  },
  {
    slug: 'sortie_en_livraison',
    nameFr: 'Sortie en livraison',
    responsibility: 'Driver',
    description: 'Driver is currently on the road with the parcel.',
    visibleFor: 15,
    editableBy: 2,
  },
  {
    slug: 'livre',
    nameFr: 'Livré',
    responsibility: 'Driver',
    description: 'Handed over to the customer and payment received (if COD).',
    visibleFor: 15,
    editableBy: 6,
  },
  {
    slug: 'encaisse',
    nameFr: 'Encaissé',
    responsibility: 'Finance',
    description: 'Payment validated and deposited at the hub.',
    visibleFor: 7,
    editableBy: 2,
  },
  {
    slug: 'recouvert',
    nameFr: 'Recouvert',
    responsibility: 'Finance',
    description: 'Funds cleared for supplier payout.',
    visibleFor: 7,
    editableBy: 2,
  },
] as const;

/**
 * The three "Special Management States" ZR documents. They belong to ZR's exchange / refund /
 * restock flows, which this feature never creates (roadmap §1.3). If one ever shows up on a
 * parcel it is treated as an unknown state — never guessed at.
 */
export const SPECIAL_MANAGEMENT_STATES: readonly { nameFr: string; description: string }[] = [
  { nameFr: "En attente d'echange", description: 'Used when a new parcel is sent only after receiving an old one.' },
  { nameFr: 'Remboursement reinjecte', description: 'Handling of partial or full refunds returned to stock.' },
  { nameFr: 'Reinjecte dans le stock', description: 'Parcel items have been returned to inventory.' },
] as const;

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

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

/** Carrier state slug → provider-neutral status. */
export const NORMALIZED_STATUS_BY_STATE: Readonly<Record<string, NormalizedDeliveryStatus>> = {
  commande_recue: 'received',
  en_traitement: 'processing',
  appel_confirmation: 'contacting_customer',
  commande_confirmee: 'customer_confirmed',
  en_preparation: 'preparing',
  pret_a_expedier: 'ready_for_pickup',
  confirme_au_bureau: 'at_pickup_point',
  dispatch: 'dispatch_local',
  vers_wilaya: 'dispatch_interwilaya',
  en_livraison: 'out_for_delivery',
  sortie_en_livraison: 'with_courier',
  livre: 'delivered',
  encaisse: 'cash_collected',
  recouvert: 'settled',
};

/**
 * The complete normalized vocabulary: 14 core states + the two carrier outcomes that have no
 * core state slug (`cancelled`, `returned`) + the `unknown` escape hatch.
 */
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

/**
 * The **terminal band** — the carrier states after which the parcel stops moving.
 *
 * This is a **platform judgement**, not a ZR statement: ZR documents what each state means but
 * never labels one terminal. `livre` / `encaisse` / `recouvert` are terminal because nothing
 * further changes the parcel's physical location. The terminal band only stops the *polling*; it
 * never moves an order.
 */
export const TERMINAL_BAND: readonly string[] = ['livre', 'encaisse', 'recouvert'] as const;

/**
 * The **delivery-trigger band** — the single normalized status allowed to move an order forward.
 *
 * Deliberately narrower than the terminal band: `encaisse` / `recouvert` normalize to
 * `cash_collected` / `settled`, not `delivered`, and they arrive *after* `livre`, by which time
 * the order has already reached `delivered`.
 */
export const DELIVERY_TRIGGER_STATUS: NormalizedDeliveryStatus = 'delivered';

/* ------------------------------------------------------------------ *
 * The order signal (behaviour refactor, §3.1)
 * ------------------------------------------------------------------ */

/**
 * What the carrier is telling the **order** to do. Deliberately separate from the display
 * status: `pret_a_expedier` displays as `ready_for_pickup` but signals `in_transit`, and a
 * cancel situation always signals `cancelled` even when the state itself is `appel_confirmation`.
 */
export type CarrierOrderSignal =
  | 'none'
  | 'in_transit'
  | 'delivered'
  | 'cancelled'
  | 'returned';

/** The complete signal vocabulary. */
export const CARRIER_ORDER_SIGNALS: readonly CarrierOrderSignal[] = [
  'none',
  'in_transit',
  'delivered',
  'cancelled',
  'returned',
] as const;

/** Which piece of evidence produced a signal. Persisted for audit (§5.4). */
export type CarrierSignalSource = 'state' | 'situation' | 'override' | 'none';

export interface DetectedCarrierOrderSignal {
  signal: CarrierOrderSignal;
  source: CarrierSignalSource;
}

/**
 * A store's per-state signal overrides: exact carrier slug → the signal it should produce.
 *
 * Unlike `StateOverrides`, this map **can** introduce the two outcomes that have no core state
 * slug (`cancelled`, `returned`). It exists because ZR does not publish a return state in the 14
 * core states, so a tenant-specific return state must be opted into explicitly (§5.2, D6).
 */
export type SignalOverrides = Readonly<Record<string, string>>;

/** Normalized state/description tokens that mean "the carrier cancelled this parcel". */
export const CANCELLED_STATE_PATTERNS: readonly string[] = [
  'annul',
  'annule',
  'annulee',
  'cancel',
] as const;

/** Normalized state/description tokens that mean "the parcel is coming back". */
export const RETURN_STATE_PATTERNS: readonly string[] = [
  'retour',
  'retourn',
  'renvoy',
  'reinject',
  'restit',
  'refus',
] as const;

/** Normalized situation tokens that mean "the customer/carrier cancelled". */
export const CANCELLED_SITUATION_PATTERNS: readonly string[] = [
  'annul',
  'annule',
  'annulee',
  'cancel',
] as const;

/** Normalized situation tokens that mean "the parcel is coming back". */
export const RETURN_SITUATION_PATTERNS: readonly string[] = [
  'retour',
  'retourn',
  'renvoy',
  'reinject',
  'restit',
  'refus',
] as const;

/** Normalized statuses that mean the parcel has left the merchant but is not delivered yet. */
export const IN_TRANSIT_NORMALIZED_STATUSES: readonly NormalizedDeliveryStatus[] = [
  'ready_for_pickup',
  'at_pickup_point',
  'dispatch_local',
  'dispatch_interwilaya',
  'out_for_delivery',
  'with_courier',
] as const;

/** Normalized statuses that mean the parcel was delivered (including the financial tail). */
export const DELIVERED_NORMALIZED_STATUSES: readonly NormalizedDeliveryStatus[] = [
  'delivered',
  'cash_collected',
  'settled',
] as const;

/** The signal priority frozen in §3.1. The first matching signal wins. */
export const CARRIER_SIGNAL_PRIORITY: readonly CarrierOrderSignal[] = [
  'returned',
  'cancelled',
  'delivered',
  'in_transit',
  'none',
] as const;

/* ------------------------------------------------------------------ *
 * Situation flags
 * ------------------------------------------------------------------ */

/** Every flag the platform can surface for a parcel. */
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

/**
 * Situation → flag.
 *
 * Matched on the situation's **description** (published, stable, French) and on its **slug**
 * (discoverable per tenant via `POST /workflows/search`, but not a fixed published list).
 * Matching runs on a normalized form of both, so `commande_annulee` and "Commande annulee"
 * resolve to the same flag.
 */
export const SITUATION_FLAG_BY_PHRASE: readonly { flag: SituationFlag; phrases: string[] }[] = [
  { flag: 'no_answer', phrases: ['ne repond pas'] },
  { flag: 'unreachable', phrases: ['injoignable'] },
  { flag: 'customer_cancelled', phrases: ['commande annulee'] },
  { flag: 'call_attempt', phrases: ['appel telephonique'] },
  { flag: 'address_issue', phrases: ['commune erronee'] },
  { flag: 'postponed', phrases: ['reporte', 'reportee', 'reporter'] },
  { flag: 'redirected_to_pickup', phrases: ['changement bureau'] },
  { flag: 'awaiting_pickup', phrases: ['en attente du client'] },
  { flag: 'sms_sent', phrases: ['sms envoye'] },
] as const;

/** The complete flag vocabulary. `raw` is the escape hatch for anything unmapped. */
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

/**
 * The published situation catalogue, by the phase it belongs to. Used to validate the flag
 * vocabulary and to sanity-check what a tenant reports.
 */
export const OFFICIAL_SITUATIONS_BY_STATE: Readonly<Record<string, readonly string[]>> = {
  appel_confirmation: [
    'Ne répond pas (1)',
    'Ne repond pas (2)',
    'Ne repond pas (3)',
    'Injoignable',
    'Commande annulee',
  ],
  sortie_en_livraison: [
    'Appel telephonique',
    'Ne repond pas (1)',
    'Ne repond pas (2)',
    'Ne repond pas (3)',
    'Commune erronee',
    'Reporté',
    'Changement bureau',
    'Commande annulee',
  ],
  confirme_au_bureau: ['En attente du client', 'SMS envoyé'],
} as const;

/* ------------------------------------------------------------------ *
 * The order-status advance
 * ------------------------------------------------------------------ */

/** One legal order-status edge the carrier sync may take. */
export interface OrderAdvanceEdge {
  from: string;
  to: string;
}

/**
 * The guarded advance.
 *
 * One legal edge per cycle, ever. The carrier's normalized status must be in the
 * delivery-trigger band AND the order's current status must be the `from` of a legal edge. There
 * is deliberately **no** `dispatched → delivered` edge: `ORDER_STATUS_TRANSITIONS` does not allow
 * it, so the sync steps through `in-transit`.
 */
export const ORDER_ADVANCE_EDGES: readonly OrderAdvanceEdge[] = [
  { from: 'dispatched', to: 'in-transit' },
  { from: 'in-transit', to: 'delivered' },
] as const;

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

/** Lowercase, strip accents, collapse everything that is not a letter or a digit to one space. */
export function normalizeText(value: unknown): string {
  return String(value === null || value === undefined ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * A store's carrier-state overrides: carrier state slug → the catalogue slug it should be
 * treated as.
 *
 * This is the per-tenant escape hatch of roadmap §11.3. The target must be a slug of the
 * built-in catalogue, so an override can *redirect* a state but can never introduce a new
 * normalized status — the vocabulary stays closed.
 */
export type StateOverrides = Readonly<Record<string, string>>;

/**
 * Applies the store's overrides to a carrier state slug.
 *
 * An override whose target is not a known catalogue slug is **ignored**: the default mapping
 * still applies, so a typo in the configuration degrades to the standard behaviour instead of
 * silently turning every parcel of that store into `unknown`.
 */
export function applyStateOverride(
  stateSlug: unknown,
  overrides?: StateOverrides | null,
): string | null {
  if (!stateSlug) return null;
  const key = String(stateSlug).trim().toLowerCase();
  if (!overrides) return key;

  const target = overrides[key];
  if (!target) return key;

  const normalizedTarget = String(target).trim().toLowerCase();
  if (!(normalizedTarget in NORMALIZED_STATUS_BY_STATE)) return key;

  return normalizedTarget;
}

/** The normalized status for a carrier state slug. Unknown or absent → `unknown`. */
export function normalizeCarrierState(
  stateSlug: unknown,
  overrides?: StateOverrides | null,
): NormalizedDeliveryStatus {
  if (!stateSlug) return 'unknown';
  const effective = applyStateOverride(stateSlug, overrides);
  if (!effective) return 'unknown';
  return NORMALIZED_STATUS_BY_STATE[effective] ?? 'unknown';
}

/** The flag for a situation, or `null` when it is not recognised. */
export function flagForSituation(situation: ZrSituationDto | ZrSituationHistoryDto | null | undefined): SituationFlag | null {
  if (!situation) return null;

  // The two situation shapes carry their label under different keys (`slug`/`name`/`description`
  // on the parcel's current situation, `situationSlug`/`situationName`/`situationDescription` on a
  // transition's situation), so every known key is read and the first match wins.
  const source = situation as Record<string, unknown>;
  const candidates = [
    source.situationSlug,
    source.situationName,
    source.situationDescription,
    source.slug,
    source.name,
    source.description,
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean);

  for (const candidate of candidates) {
    for (const rule of SITUATION_FLAG_BY_PHRASE) {
      if (rule.phrases.some((phrase) => candidate.includes(phrase))) return rule.flag;
    }
  }
  return null;
}

/** Every flag carried by a list of situations. Unrecognised situations contribute `raw`. */
export function flagsForSituations(situations: (ZrSituationDto | ZrSituationHistoryDto)[] | null | undefined): SituationFlag[] {
  const flags = new Set<SituationFlag>();
  for (const situation of situations || []) {
    flags.add(flagForSituation(situation) ?? 'raw');
  }
  return Array.from(flags);
}

/** True when the carrier state is in the terminal band. */
export function isTerminalCarrierState(stateSlug: unknown): boolean {
  return TERMINAL_BAND.includes(String(stateSlug ?? '').trim().toLowerCase());
}

/* ------------------------------------------------------------------ *
 * Order-signal detection (behaviour refactor, §5)
 * ------------------------------------------------------------------ */

function matchesAnyToken(value: unknown, patterns: readonly string[]): boolean {
  const text = normalizeText(value);
  if (!text) return false;
  return patterns.some((pattern) => text.includes(normalizeText(pattern)));
}

/** Resolve an exact per-tenant signal override. `null` means "no (valid) override". */
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

/**
 * The minimal history shape the signal detector needs.
 *
 * It is deliberately structural rather than `MappedHistoryEntry`: the poller receives the
 * provider-neutral `DeliveryStatusEntry` and must be able to feed it to the detector without
 * a cast.
 */
export interface CarrierSignalHistoryEntry {
  toState: string | null;
  at: Date | null;
  situations?: readonly CarrierSignalSituation[] | null;
  raw?: unknown;
}

/** The minimal situation shape the signal detector needs. */
export interface CarrierSignalSituation {
  slug: string | null;
  name: string | null;
  description: string | null;
  flags: readonly string[];
}

/** The minimal parcel shape the signal detector needs. */
export interface CarrierSignalParcel {
  carrierStateName?: string | null;
  carrierStateDescription?: string | null;
  deliveryStatus?: string | null;
  situationFlags?: readonly string[] | null;
  raw?: unknown;
}

/** The newest history entry, tolerating an unsorted array and missing timestamps. */
function newestHistoryEntry(
  history?: readonly CarrierSignalHistoryEntry[] | null,
): CarrierSignalHistoryEntry | null {
  if (!history || history.length === 0) return null;
  return history.reduce((newest, entry) => {
    const newestAt = newest.at?.getTime() ?? Number.NEGATIVE_INFINITY;
    const entryAt = entry.at?.getTime() ?? Number.NEGATIVE_INFINITY;
    return entryAt >= newestAt ? entry : newest;
  });
}

/** The newest history entry that landed on `stateSlug`, else `null`. */
function newestEntryForState(
  history: readonly CarrierSignalHistoryEntry[] | null | undefined,
  stateSlug: string | null,
): CarrierSignalHistoryEntry | null {
  if (!history || !stateSlug) return null;
  const matching = history.filter((entry) => entry.toState === stateSlug);
  return newestHistoryEntry(matching);
}

function stateTextSignal(
  stateSlug: string | null,
  stateDescription: string | null,
  isReturn: boolean,
): DetectedCarrierOrderSignal | null {
  if (isReturn) return { signal: 'returned', source: 'state' };

  const text = `${stateSlug ?? ''} ${stateDescription ?? ''}`;
  if (matchesAnyToken(text, RETURN_STATE_PATTERNS)) return { signal: 'returned', source: 'state' };
  if (matchesAnyToken(text, CANCELLED_STATE_PATTERNS)) return { signal: 'cancelled', source: 'state' };
  return null;
}

function situationsSignal(
  situations: readonly CarrierSignalSituation[] | null | undefined,
  flags: readonly string[] | null | undefined,
  source: CarrierSignalSource,
): DetectedCarrierOrderSignal | null {
  if ((flags ?? []).includes('customer_cancelled')) {
    return { signal: 'cancelled', source };
  }

  for (const situation of situations ?? []) {
    const text = `${situation.slug ?? ''} ${situation.name ?? ''} ${situation.description ?? ''}`;
    if (matchesAnyToken(text, RETURN_SITUATION_PATTERNS)) return { signal: 'returned', source };
    if (
      situation.flags.includes('customer_cancelled') ||
      matchesAnyToken(text, CANCELLED_SITUATION_PATTERNS)
    ) {
      return { signal: 'cancelled', source };
    }
  }
  return null;
}

function newestSignal(candidates: DetectedCarrierOrderSignal[]): DetectedCarrierOrderSignal {
  for (const signal of CARRIER_SIGNAL_PRIORITY) {
    const match = candidates.find((candidate) => candidate.signal === signal && signal !== 'none');
    if (match) return match;
  }
  return { signal: 'none', source: 'none' };
}

/**
 * Derive the signal carried by the **latest** carrier event only.
 *
 * Evidence, in priority order (§3.1): `returned` > `cancelled` > `delivered` > `in_transit`.
 * Only the newest state/situation may decide — an older cancel situation is history, not an
 * action, because a carrier can record a failed call and continue. A newer history entry that
 * belongs to a different state than the parcel's current state is ignored.
 */
export function detectCarrierOrderSignal(
  parcel: CarrierSignalParcel,
  history?: readonly CarrierSignalHistoryEntry[] | null,
  signalOverrides?: SignalOverrides | null,
): DetectedCarrierOrderSignal {
  const rawParcel = (parcel?.raw ?? null) as ZrParcelDto | null;
  const latest = newestHistoryEntry(history);
  const stateSlug = parcel?.carrierStateName ?? latest?.toState ?? null;
  const latestForState = newestEntryForState(history, stateSlug);
  const relevant = latestForState ?? latest;
  const stateDescription =
    parcel?.carrierStateDescription ??
    ((relevant?.raw as ZrStateHistoryEntryDto | null | undefined)?.newState as
      | ZrStateDto
      | null
      | undefined)?.description ??
    null;

  const candidates: DetectedCarrierOrderSignal[] = [];

  const fromState = stateTextSignal(stateSlug, stateDescription, rawParcel?.isReturn === true);
  if (fromState) candidates.push(fromState);

  const fromParcelSituation = situationsSignal(
    rawParcel?.situation
      ? [
          {
            slug: rawParcel.situation.slug ?? null,
            name: rawParcel.situation.name ?? null,
            description: rawParcel.situation.description ?? null,
            flags: flagsForSituations([rawParcel.situation]),
          },
        ]
      : [],
    parcel?.situationFlags,
    'situation',
  );
  if (fromParcelSituation) candidates.push(fromParcelSituation);

  const fromHistorySituation = situationsSignal(relevant?.situations, null, 'situation');
  if (fromHistorySituation) candidates.push(fromHistorySituation);

  const override = applySignalOverride(stateSlug, signalOverrides);
  if (override && override !== 'none') {
    candidates.push({ signal: override, source: 'override' });
  }

  const normalized = (parcel?.deliveryStatus ?? null) as NormalizedDeliveryStatus | null;
  if (normalized === 'returned') {
    candidates.push({ signal: 'returned', source: 'state' });
  } else if (normalized === 'cancelled') {
    candidates.push({ signal: 'cancelled', source: 'state' });
  } else if (normalized && DELIVERED_NORMALIZED_STATUSES.includes(normalized)) {
    candidates.push({ signal: 'delivered', source: 'state' });
  } else if (normalized && IN_TRANSIT_NORMALIZED_STATUSES.includes(normalized)) {
    candidates.push({ signal: 'in_transit', source: 'state' });
  }

  return newestSignal(candidates);
}

/** One target the carrier may apply to an order. */
export type CarrierOrderTarget = 'in-transit' | 'delivered' | 'cancelled' | 'returned';

/** The pure plan the poller hands to `OrdersService` (§6.1). */
export interface CarrierOrderPlan {
  signal: CarrierOrderSignal;
  /** The final order status, or `null` when this event is a no-op/conflict. */
  target: CarrierOrderTarget | null;
  /** The ordered transitions to apply, each one validated by the order service. */
  steps: string[];
  /** Only `cancelled` touches reservations. */
  inventoryAware: boolean;
}

/**
 * Plan the order action for one carrier event.
 *
 * `target` is absent (`null`) when the order is already at the destination or the event is not
 * allowed from the current status. The order service remains the authority: every step is still
 * conditionally claimed and re-validated against the state machine.
 */
export function planCarrierOrderAction(
  currentOrderSlug: unknown,
  signalOrDetection: CarrierOrderSignal | DetectedCarrierOrderSignal,
): CarrierOrderPlan {
  const signal =
    typeof signalOrDetection === 'string' ? signalOrDetection : signalOrDetection.signal;
  const current = String(currentOrderSlug ?? '').trim().toLowerCase();

  switch (signal) {
    case 'in_transit':
      return current === 'dispatched'
        ? { signal, target: 'in-transit', steps: ['in-transit'], inventoryAware: false }
        : { signal, target: null, steps: [], inventoryAware: false };

    case 'delivered':
      if (current === 'dispatched') {
        return {
          signal,
          target: 'delivered',
          steps: ['in-transit', 'delivered'],
          inventoryAware: false,
        };
      }
      if (current === 'in-transit') {
        return { signal, target: 'delivered', steps: ['delivered'], inventoryAware: false };
      }
      return { signal, target: null, steps: [], inventoryAware: false };

    case 'cancelled':
      if (['placed', 'confirmed', 'dispatched', 'in-transit'].includes(current)) {
        return { signal, target: 'cancelled', steps: ['cancelled'], inventoryAware: true };
      }
      return { signal, target: null, steps: [], inventoryAware: signal === 'cancelled' };

    case 'returned':
      if (['dispatched', 'in-transit', 'delivered'].includes(current)) {
        return { signal, target: 'returned', steps: ['returned'], inventoryAware: false };
      }
      return { signal, target: null, steps: [], inventoryAware: false };

    case 'none':
    default:
      return { signal: 'none', target: null, steps: [], inventoryAware: false };
  }
}

/* ------------------------------------------------------------------ *
 * Wire → platform mapping
 * ------------------------------------------------------------------ */

/** A situation attached to a transition, normalized. */
export interface MappedSituation {
  slug: string | null;
  name: string | null;
  description: string | null;
  flags: SituationFlag[];
  raw: ZrSituationDto | ZrSituationHistoryDto;
}

/** A parcel, normalized. */
export interface MappedParcel {
  parcelId: string;
  externalId: string | null;
  trackingNumber: string | null;
  deliveryStatus: NormalizedDeliveryStatus;
  carrierStateId: string | null;
  carrierStateName: string | null;
  carrierStateDescription: string | null;
  carrierStateRank: number | null;
  carrierStateLocked: boolean | null;
  carrierStateBlocking: boolean | null;
  terminal: boolean;
  situationFlags: SituationFlag[];
  rawSituation: ZrSituationDto | null;
  deliveryType: string | null;
  lastStateUpdateAt: Date | null;
  createdAt: Date | null;
  raw: ZrParcelDto;
}

/** One transition, normalized. */
export interface MappedHistoryEntry {
  providerEntryId: string;
  parcelId: string | null;
  fromState: string | null;
  toState: string | null;
  fromStatus: NormalizedDeliveryStatus;
  toStatus: NormalizedDeliveryStatus;
  at: Date | null;
  comment: string | null;
  hubName: string | null;
  hubCity: string | null;
  hubDistrict: string | null;
  modifiedBy: string | null;
  situations: MappedSituation[];
  raw: ZrStateHistoryEntryDto;
}

/** Parse a carrier timestamp, tolerating the ISO-8601 forms ZR emits. */
function toDate(value: unknown): Date | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Map a `StateDto` to its slug plus the diagnostic fields the platform stores. */
function mapState(state: ZrStateDto | null | undefined): {
  slug: string | null;
  id: string | null;
  description: string | null;
  rank: number | null;
  locked: boolean | null;
  blocking: boolean | null;
} {
  return {
    slug: state?.name ? String(state.name).trim().toLowerCase() : null,
    id: state?.id ?? null,
    description: state?.description ?? null,
    rank: typeof state?.ranking === 'number' ? state.ranking : null,
    locked: typeof state?.isLocked === 'boolean' ? state.isLocked : null,
    blocking: typeof state?.isBlocking === 'boolean' ? state.isBlocking : null,
  };
}

/**
 * Map one parcel from `POST /parcels/search`.
 *
 * `overrides` is the store's per-tenant state remapping (roadmap §11.3). It is applied to the
 * **normalized status only** — the raw carrier state id, name and description are stored
 * verbatim either way, so an override never hides what the carrier actually said.
 */
export function mapParcel(
  dto: ZrParcelDto,
  overrides?: StateOverrides | null,
  signalOverrides?: SignalOverrides | null,
): MappedParcel {
  const state = mapState(dto?.state);
  const situation = dto?.situation ?? null;
  const situationFlags = flagsForSituations(situation ? [situation] : []);
  const normalized = normalizeCarrierState(state.slug, overrides);

  const mappedSituation: MappedSituation | null = situation
    ? {
        slug: situation.slug ?? null,
        name: situation.name ?? null,
        description: situation.description ?? null,
        flags: situationFlags,
        raw: situation,
      }
    : null;
  const overrideSignal = applySignalOverride(state.slug, signalOverrides);
  const displaySignal = newestSignal(
    [
      stateTextSignal(state.slug, state.description, dto?.isReturn === true),
      situationsSignal(mappedSituation ? [mappedSituation] : [], situationFlags, 'situation'),
      overrideSignal && overrideSignal !== 'none'
        ? { signal: overrideSignal, source: 'override' as CarrierSignalSource }
        : null,
    ].filter((candidate): candidate is DetectedCarrierOrderSignal => candidate !== null),
  );

  const deliveryStatus: NormalizedDeliveryStatus =
    displaySignal.signal === 'cancelled' || displaySignal.signal === 'returned'
      ? displaySignal.signal
      : normalized;

  return {
    parcelId: dto?.id ? String(dto.id) : '',
    externalId: dto?.externalId ?? null,
    trackingNumber: dto?.trackingNumber ?? null,
    deliveryStatus,
    carrierStateId: state.id,
    carrierStateName: state.slug,
    carrierStateDescription: state.description,
    carrierStateRank: state.rank,
    carrierStateLocked: state.locked,
    carrierStateBlocking: state.blocking,
    terminal: isTerminalCarrierState(state.slug),
    situationFlags,
    rawSituation: situation,
    deliveryType: dto?.deliveryType ?? null,
    lastStateUpdateAt: toDate(dto?.lastStateUpdateAt),
    createdAt: toDate(dto?.createdAt),
    raw: dto,
  };
}

/** Map one transition from `GET /parcels/{parcelId}/state-history`. */
export function mapHistoryEntry(
  dto: ZrStateHistoryEntryDto,
  overrides?: StateOverrides | null,
): MappedHistoryEntry {
  const previous = mapState(dto?.previousState);
  const next = mapState(dto?.newState);
  const location = dto?.location ?? null;
  const arrival = dto?.arrivalHub ?? null;

  return {
    providerEntryId: dto?.id ? String(dto.id) : '',
    parcelId: dto?.parcelId ?? null,
    fromState: previous.slug,
    toState: next.slug,
    fromStatus: normalizeCarrierState(previous.slug, overrides),
    toStatus: normalizeCarrierState(next.slug, overrides),
    at: toDate(dto?.createdAt),
    comment: dto?.comment ?? null,
    hubName: location?.hubName ?? arrival?.hubName ?? null,
    hubCity: location?.hubCity ?? arrival?.hubCity ?? null,
    hubDistrict: location?.hubDistrict ?? arrival?.hubDistrict ?? null,
    modifiedBy: dto?.modifiedBy?.fullName ?? null,
    situations: (dto?.situations || []).map((situation) => ({
      slug: situation?.situationSlug ?? null,
      name: situation?.situationName ?? null,
      description: situation?.situationDescription ?? null,
      flags: flagsForSituations([situation]),
      raw: situation,
    })),
    raw: dto,
  };
}

/* ------------------------------------------------------------------ *
 * Self-validation
 * ------------------------------------------------------------------ */

/**
 * Checks the frozen contract for internal consistency. Returns a list of human-readable
 * problems; an empty list means the contract is coherent.
 *
 * The read-only spike calls this (`node scripts/spike-zr-status-sync.js --offline`) so the
 * contract is checked by the same code the application runs.
 */
export function validateCatalogue(): string[] {
  const problems: string[] = [];

  const carrierSlugs = CARRIER_STATES.map((state) => state.slug);
  const mappedSlugs = Object.keys(NORMALIZED_STATUS_BY_STATE);

  for (const slug of mappedSlugs) {
    if (!carrierSlugs.includes(slug)) {
      problems.push(`NORMALIZED_STATUS_BY_STATE maps an unknown carrier state "${slug}"`);
    }
  }
  for (const slug of carrierSlugs) {
    if (!mappedSlugs.includes(slug)) {
      problems.push(`carrier state "${slug}" has no normalized status`);
    }
  }
  if (new Set(mappedSlugs).size !== mappedSlugs.length) {
    problems.push('NORMALIZED_STATUS_BY_STATE contains a duplicate key');
  }

  for (const status of Object.values(NORMALIZED_STATUS_BY_STATE)) {
    if (!NORMALIZED_STATUSES.includes(status)) {
      problems.push(`normalized status "${status}" is not in NORMALIZED_STATUSES`);
    }
  }
  const expectedStatuses = CARRIER_STATES.length + 3; // one per state + cancelled + returned + unknown
  if (NORMALIZED_STATUSES.length !== expectedStatuses) {
    problems.push(`NORMALIZED_STATUSES has ${NORMALIZED_STATUSES.length} entries, expected ${expectedStatuses}`);
  }
  for (const status of ['cancelled', 'returned', 'unknown'] as const) {
    if (!NORMALIZED_STATUSES.includes(status)) {
      problems.push(`NORMALIZED_STATUSES must contain the "${status}" outcome`);
    }
  }
  for (const status of ['cancelled', 'returned']) {
    if (Object.values(NORMALIZED_STATUS_BY_STATE).includes(status as NormalizedDeliveryStatus)) {
      problems.push(`"${status}" is an order outcome and must not be a core state's display status`);
    }
  }

  for (const slug of TERMINAL_BAND) {
    if (!carrierSlugs.includes(slug)) {
      problems.push(`TERMINAL_BAND contains "${slug}", which is not a carrier state`);
    }
  }
  if (!TERMINAL_BAND.includes('livre')) {
    problems.push('TERMINAL_BAND must contain "livre"');
  }

  const triggerStates = carrierSlugs.filter((slug) => NORMALIZED_STATUS_BY_STATE[slug] === DELIVERY_TRIGGER_STATUS);
  if (triggerStates.length !== 1) {
    problems.push(`exactly one carrier state must normalize to "${DELIVERY_TRIGGER_STATUS}", found ${triggerStates.length}`);
  }
  for (const slug of ['encaisse', 'recouvert']) {
    if (NORMALIZED_STATUS_BY_STATE[slug] === DELIVERY_TRIGGER_STATUS) {
      problems.push(`"${slug}" is a financial state and must not normalize to "${DELIVERY_TRIGGER_STATUS}"`);
    }
  }

  for (const rule of SITUATION_FLAG_BY_PHRASE) {
    if (!SITUATION_FLAGS.includes(rule.flag)) {
      problems.push(`situation rule "${rule.flag}" is not in SITUATION_FLAGS`);
    }
  }
  if (!SITUATION_FLAGS.includes('raw')) {
    problems.push('SITUATION_FLAGS must contain the "raw" escape hatch');
  }

  // Every published situation must resolve to a flag, otherwise the published catalogue and the
  // flag vocabulary have drifted apart.
  for (const [stateSlug, situations] of Object.entries(OFFICIAL_SITUATIONS_BY_STATE)) {
    for (const situation of situations) {
      const flag = flagForSituation({ situationDescription: situation });
      if (!flag) {
        problems.push(`published situation "${situation}" (state "${stateSlug}") does not resolve to any flag`);
      }
    }
  }

  if (CARRIER_ORDER_SIGNALS.length !== 5 || !CARRIER_ORDER_SIGNALS.includes('none')) {
    problems.push('CARRIER_ORDER_SIGNALS must contain the five signals including "none"');
  }
  for (const [label, patterns] of [
    ['CANCELLED_STATE_PATTERNS', CANCELLED_STATE_PATTERNS],
    ['RETURN_STATE_PATTERNS', RETURN_STATE_PATTERNS],
    ['CANCELLED_SITUATION_PATTERNS', CANCELLED_SITUATION_PATTERNS],
    ['RETURN_SITUATION_PATTERNS', RETURN_SITUATION_PATTERNS],
  ] as const) {
    if (patterns.length === 0) problems.push(`${label} must not be empty`);
    if (patterns.some((pattern) => normalizeText(pattern) !== pattern)) {
      problems.push(`${label} must contain pre-normalized tokens`);
    }
  }

  // Every core state's signal must match the normative §3.1 table.
  for (const state of CARRIER_STATES) {
    const normalized = NORMALIZED_STATUS_BY_STATE[state.slug];
    const expected: CarrierOrderSignal = DELIVERED_NORMALIZED_STATUSES.includes(normalized)
      ? 'delivered'
      : IN_TRANSIT_NORMALIZED_STATUSES.includes(normalized)
        ? 'in_transit'
        : 'none';
    const actual = stateTextSignal(state.slug, state.description, false)?.signal ?? expected;
    if (actual !== expected) {
      problems.push(
        `carrier state "${state.slug}" should signal "${expected}" but its text signals "${actual}"`,
      );
    }
  }

  const planChecks: Array<[string, CarrierOrderSignal, string | null, string[]]> = [
    ['dispatched', 'in_transit', 'in-transit', ['in-transit']],
    ['dispatched', 'delivered', 'delivered', ['in-transit', 'delivered']],
    ['in-transit', 'delivered', 'delivered', ['delivered']],
    ['confirmed', 'cancelled', 'cancelled', ['cancelled']],
    ['dispatched', 'returned', 'returned', ['returned']],
    ['delivered', 'returned', 'returned', ['returned']],
    ['delivered', 'cancelled', null, []],
    ['cancelled', 'returned', null, []],
    ['dispatched', 'none', null, []],
  ];
  for (const [current, signal, target, steps] of planChecks) {
    const plan = planCarrierOrderAction(current, signal);
    if (plan.target !== target || plan.steps.join(',') !== steps.join(',')) {
      problems.push(
        `planCarrierOrderAction(${current}, ${signal}) should be ${target ?? 'no-op'} [${steps.join(', ')}] but was ${plan.target ?? 'no-op'} [${plan.steps.join(', ')}]`,
      );
    }
  }

  const edgeFroms = ORDER_ADVANCE_EDGES.map((edge) => edge.from);
  if (new Set(edgeFroms).size !== edgeFroms.length) {
    problems.push('ORDER_ADVANCE_EDGES has two edges with the same "from" status');
  }
  if (!edgeFroms.includes('dispatched')) {
    problems.push('ORDER_ADVANCE_EDGES must contain the dispatched -> in-transit edge');
  }
  if (!edgeFroms.includes('in-transit')) {
    problems.push('ORDER_ADVANCE_EDGES must contain the in-transit -> delivered edge');
  }
  if (edgeFroms.includes('delivered')) {
    problems.push('ORDER_ADVANCE_EDGES must not advance out of "delivered"');
  }
  if (edgeFroms.includes('cancelled') || edgeFroms.includes('returned')) {
    problems.push('ORDER_ADVANCE_EDGES must not advance out of a terminal order status');
  }

  return problems;
}
