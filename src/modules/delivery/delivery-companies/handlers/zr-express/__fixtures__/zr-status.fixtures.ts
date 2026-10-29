import type { ZrParcelDto, ZrStateDto, ZrStateHistoryEntryDto } from '../zr-status.types';

/**
 * Phase 0 contract fixtures for the ZR Express status → order signal refactor.
 *
 * These fixtures are deliberately pure data: they are imported by tests only and never by
 * production code. They freeze the expected behaviour described in
 * `ZR-EXPRESS-STATUS-SYNC-BEHAVIOR-REFACTOR.md` §3 before the mapper and the order write path
 * are changed.
 */
export type FixtureSignal = 'none' | 'in_transit' | 'delivered' | 'cancelled' | 'returned';

export interface CarrierSignalFixture {
  /** A stable name used in test failure messages. */
  name: string;
  /** The parcel payload as `POST /parcels/search` returns it. */
  parcel: ZrParcelDto;
  /** The state history as `GET /parcels/:parcelId/state-history` returns it. */
  history: ZrStateHistoryEntryDto[];
  /** The store's `statusStateOverrides` (known catalogue slugs). */
  stateOverrides?: Record<string, string>;
  /** The store's new `statusSignalOverrides` (unknown slugs → an order signal). */
  signalOverrides?: Record<string, FixtureSignal>;
  /** The order status the fixture is evaluated against. */
  orderStatus: string;
  /** The signal the detector must produce. */
  expectedSignal: FixtureSignal;
  /** The final order status the planner should request (`null` = no action/conflict). */
  expectedTarget: string | null;
}

const AT = '2026-10-22T10:00:00.000Z';

function state(name: string, description = name): ZrStateDto {
  return {
    id: `state-${name}`,
    name,
    description,
    isBlocking: false,
    isLocked: false,
  };
}

function parcel(stateName: string, extra: Partial<ZrParcelDto> = {}): ZrParcelDto {
  return {
    id: 'parcel-1',
    externalId: 'ORD-1',
    trackingNumber: 'TRACK-1',
    state: state(stateName),
    lastStateUpdateAt: AT,
    createdAt: AT,
    ...extra,
  };
}

function entry(
  from: string | null,
  to: string,
  situations: ZrStateHistoryEntryDto['situations'] = [],
): ZrStateHistoryEntryDto {
  return {
    id: `entry-${from ?? 'start'}-${to}`,
    parcelId: 'parcel-1',
    createdAt: AT,
    previousState: from ? state(from) : null,
    newState: state(to),
    situations,
  };
}

/**
 * The 14 core carrier states, each evaluated against a dispatched order.
 *
 * The early intake states (`commande_recue` … `en_preparation`) leave the order dispatched; the
 * first real advance (`pret_a_expedier`) and everything after it put it in transit; the three
 * terminal states imply delivered.
 */
export const CORE_STATE_SIGNAL_FIXTURES: readonly CarrierSignalFixture[] = [
  {
    name: 'commande_recue / dispatched → no change',
    parcel: parcel('commande_recue'),
    history: [entry(null, 'commande_recue')],
    orderStatus: 'dispatched',
    expectedSignal: 'none',
    expectedTarget: 'dispatched',
  },
  {
    name: 'en_traitement / dispatched → no change',
    parcel: parcel('en_traitement'),
    history: [entry('commande_recue', 'en_traitement')],
    orderStatus: 'dispatched',
    expectedSignal: 'none',
    expectedTarget: 'dispatched',
  },
  {
    name: 'appel_confirmation / dispatched → no change',
    parcel: parcel('appel_confirmation'),
    history: [entry('en_traitement', 'appel_confirmation')],
    orderStatus: 'dispatched',
    expectedSignal: 'none',
    expectedTarget: 'dispatched',
  },
  {
    name: 'commande_confirmee / dispatched → no change',
    parcel: parcel('commande_confirmee'),
    history: [entry('appel_confirmation', 'commande_confirmee')],
    orderStatus: 'dispatched',
    expectedSignal: 'none',
    expectedTarget: 'dispatched',
  },
  {
    name: 'en_preparation / dispatched → no change',
    parcel: parcel('en_preparation'),
    history: [entry('commande_confirmee', 'en_preparation')],
    orderStatus: 'dispatched',
    expectedSignal: 'none',
    expectedTarget: 'dispatched',
  },
  {
    name: 'pret_a_expedier / dispatched → in-transit',
    parcel: parcel('pret_a_expedier'),
    history: [entry('en_preparation', 'pret_a_expedier')],
    orderStatus: 'dispatched',
    expectedSignal: 'in_transit',
    expectedTarget: 'in-transit',
  },
  {
    name: 'confirme_au_bureau / dispatched → in-transit',
    parcel: parcel('confirme_au_bureau'),
    history: [entry('pret_a_expedier', 'confirme_au_bureau')],
    orderStatus: 'dispatched',
    expectedSignal: 'in_transit',
    expectedTarget: 'in-transit',
  },
  {
    name: 'dispatch / dispatched → in-transit',
    parcel: parcel('dispatch'),
    history: [entry('confirme_au_bureau', 'dispatch')],
    orderStatus: 'dispatched',
    expectedSignal: 'in_transit',
    expectedTarget: 'in-transit',
  },
  {
    name: 'vers_wilaya / dispatched → in-transit',
    parcel: parcel('vers_wilaya'),
    history: [entry('confirme_au_bureau', 'vers_wilaya')],
    orderStatus: 'dispatched',
    expectedSignal: 'in_transit',
    expectedTarget: 'in-transit',
  },
  {
    name: 'en_livraison / dispatched → in-transit',
    parcel: parcel('en_livraison'),
    history: [entry('vers_wilaya', 'en_livraison')],
    orderStatus: 'dispatched',
    expectedSignal: 'in_transit',
    expectedTarget: 'in-transit',
  },
  {
    name: 'sortie_en_livraison / dispatched → in-transit',
    parcel: parcel('sortie_en_livraison'),
    history: [entry('en_livraison', 'sortie_en_livraison')],
    orderStatus: 'dispatched',
    expectedSignal: 'in_transit',
    expectedTarget: 'in-transit',
  },
  {
    name: 'livre / dispatched → delivered (two steps)',
    parcel: parcel('livre'),
    history: [entry('sortie_en_livraison', 'livre')],
    orderStatus: 'dispatched',
    expectedSignal: 'delivered',
    expectedTarget: 'delivered',
  },
  {
    name: 'encaisse / in-transit → delivered (no-op after)',
    parcel: parcel('encaisse'),
    history: [entry('livre', 'encaisse')],
    orderStatus: 'in-transit',
    expectedSignal: 'delivered',
    expectedTarget: 'delivered',
  },
  {
    name: 'recouvert / delivered → no-op',
    parcel: parcel('recouvert'),
    history: [entry('encaisse', 'recouvert')],
    orderStatus: 'delivered',
    expectedSignal: 'delivered',
    expectedTarget: 'delivered',
  },
] as const;

/**
 * Cancellation fixtures. The documented carrier cancellation is a **situation**, not one of the
 * 14 core states, so the fixture set covers the situation on the two phases where ZR documents
 * it plus a tenant-specific cancel state.
 */
export const CANCEL_SIGNAL_FIXTURES: readonly CarrierSignalFixture[] = [
  {
    name: 'cancel situation during confirmation / confirmed → cancelled',
    parcel: parcel('appel_confirmation', {
      situation: { id: 'sit-cancel', slug: 'commande_annulee', name: 'Commande annulee' },
    }),
    history: [
      entry('commande_confirmee', 'appel_confirmation', [
        { situationSlug: 'commande_annulee', situationName: 'Commande annulee' },
      ]),
    ],
    orderStatus: 'confirmed',
    expectedSignal: 'cancelled',
    expectedTarget: 'cancelled',
  },
  {
    name: 'cancel situation at the door / in-transit → cancelled',
    parcel: parcel('sortie_en_livraison', {
      situation: { id: 'sit-cancel', slug: 'commande_annulee', name: 'Commande annulee' },
    }),
    history: [
      entry('en_livraison', 'sortie_en_livraison', [
        { situationSlug: 'commande_annulee', situationName: 'Commande annulee' },
      ]),
    ],
    orderStatus: 'in-transit',
    expectedSignal: 'cancelled',
    expectedTarget: 'cancelled',
  },
  {
    name: 'tenant cancel state / dispatched → cancelled',
    parcel: parcel('commande_annulee'),
    history: [entry('commande_recue', 'commande_annulee')],
    orderStatus: 'dispatched',
    expectedSignal: 'cancelled',
    expectedTarget: 'cancelled',
  },
  {
    name: 'cancel after delivery is a conflict',
    parcel: parcel('sortie_en_livraison', {
      situation: { id: 'sit-cancel', slug: 'commande_annulee', name: 'Commande annulee' },
    }),
    history: [
      entry('en_livraison', 'sortie_en_livraison', [
        { situationSlug: 'commande_annulee', situationName: 'Commande annulee' },
      ]),
    ],
    orderStatus: 'delivered',
    expectedSignal: 'cancelled',
    expectedTarget: null,
  },
] as const;

/**
 * Return fixtures. ZR exposes `isReturn` on the parcel and documents the special management
 * states in prose; the fixture set covers both, plus a tenant override for an unpublished slug.
 */
export const RETURN_SIGNAL_FIXTURES: readonly CarrierSignalFixture[] = [
  {
    name: 'parcel.isReturn / dispatched → returned',
    parcel: parcel('sortie_en_livraison', { isReturn: true }),
    history: [entry('en_livraison', 'sortie_en_livraison')],
    orderStatus: 'dispatched',
    expectedSignal: 'returned',
    expectedTarget: 'returned',
  },
  {
    name: 'tenant return state / in-transit → returned',
    parcel: parcel('retour_a_lexpediteur', {
      state: { ...state('retour_a_lexpediteur'), description: 'Retour a l expediteur' },
    }),
    history: [entry('sortie_en_livraison', 'retour_a_lexpediteur')],
    orderStatus: 'in-transit',
    expectedSignal: 'returned',
    expectedTarget: 'returned',
  },
  {
    name: 'refused at the door / delivered → returned',
    parcel: parcel('refusee', { isReturn: true }),
    history: [entry('sortie_en_livraison', 'refusee')],
    orderStatus: 'delivered',
    expectedSignal: 'returned',
    expectedTarget: 'returned',
  },
  {
    name: 'return situation / in-transit → returned',
    parcel: parcel('sortie_en_livraison', {
      situation: { id: 'sit-return', slug: 'retour_a_lexpediteur', name: 'Retour a l expediteur' },
    }),
    history: [
      entry('en_livraison', 'sortie_en_livraison', [
        { situationSlug: 'retour_a_lexpediteur', situationName: 'Retour a l expediteur' },
      ]),
    ],
    orderStatus: 'in-transit',
    expectedSignal: 'returned',
    expectedTarget: 'returned',
  },
  {
    name: 'tenant override maps an unknown slug to returned',
    parcel: parcel('tenant_special_state'),
    history: [entry('sortie_en_livraison', 'tenant_special_state')],
    signalOverrides: { tenant_special_state: 'returned' },
    orderStatus: 'in-transit',
    expectedSignal: 'returned',
    expectedTarget: 'returned',
  },
] as const;

/** Unknown states and untouched situations must never move an order. */
export const UNKNOWN_SIGNAL_FIXTURES: readonly CarrierSignalFixture[] = [
  {
    name: 'unknown tenant state / dispatched → no action',
    parcel: parcel('tenant_custom_state'),
    history: [entry('commande_recue', 'tenant_custom_state')],
    orderStatus: 'dispatched',
    expectedSignal: 'none',
    expectedTarget: 'dispatched',
  },
  {
    name: 'unknown situation on a known state / in-transit → no action',
    parcel: parcel('sortie_en_livraison', {
      situation: { id: 'sit-unknown', slug: 'situation_inconnue', name: 'Situation inconnue' },
    }),
    history: [
      entry('en_livraison', 'sortie_en_livraison', [
        { situationSlug: 'situation_inconnue', situationName: 'Situation inconnue' },
      ]),
    ],
    orderStatus: 'in-transit',
    expectedSignal: 'in_transit',
    expectedTarget: 'in-transit',
  },
] as const;

/** A stale cancellation in the history must not override a later, normal state. */
export const HISTORY_PRECEDENCE_FIXTURES: readonly CarrierSignalFixture[] = [
  {
    name: 'old cancel situation followed by pret_a_expedier → in-transit',
    parcel: parcel('pret_a_expedier'),
    history: [
      entry('appel_confirmation', 'appel_confirmation', [
        { situationSlug: 'commande_annulee', situationName: 'Commande annulee' },
      ]),
      entry('appel_confirmation', 'pret_a_expedier'),
    ],
    orderStatus: 'dispatched',
    expectedSignal: 'in_transit',
    expectedTarget: 'in-transit',
  },
] as const;

export const ALL_SIGNAL_FIXTURES: readonly CarrierSignalFixture[] = [
  ...CORE_STATE_SIGNAL_FIXTURES,
  ...CANCEL_SIGNAL_FIXTURES,
  ...RETURN_SIGNAL_FIXTURES,
  ...UNKNOWN_SIGNAL_FIXTURES,
  ...HISTORY_PRECEDENCE_FIXTURES,
] as const;
