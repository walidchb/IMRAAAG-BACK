import {
  ALL_SIGNAL_FIXTURES,
  CANCEL_SIGNAL_FIXTURES,
  CORE_STATE_SIGNAL_FIXTURES,
  HISTORY_PRECEDENCE_FIXTURES,
  RETURN_SIGNAL_FIXTURES,
  UNKNOWN_SIGNAL_FIXTURES,
} from './__fixtures__/zr-status.fixtures';
import {
  CARRIER_ORDER_SIGNALS,
  CARRIER_STATES,
  DELIVERY_TRIGGER_STATUS,
  NORMALIZED_STATUSES,
  OFFICIAL_SITUATIONS_BY_STATE,
  ORDER_ADVANCE_EDGES,
  SITUATION_FLAGS,
  TERMINAL_BAND,
  applySignalOverride,
  applyStateOverride,
  detectCarrierOrderSignal,
  flagForSituation,
  flagsForSituations,
  isTerminalCarrierState,
  mapHistoryEntry,
  mapParcel,
  normalizeCarrierState,
  normalizeText,
  planCarrierOrderAction,
  validateCatalogue,
} from './zr-status.mapper';

describe('zr-status.mapper', () => {
  describe('validateCatalogue()', () => {
    it('reports no problems for the frozen Phase 0 contract', () => {
      expect(validateCatalogue()).toEqual([]);
    });
  });

  describe('the carrier catalogue', () => {
    it('publishes exactly the 14 core workflow states', () => {
      expect(CARRIER_STATES).toHaveLength(14);
    });

    it('has a unique slug per state', () => {
      const slugs = CARRIER_STATES.map((state) => state.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
    });

    it('maps every state to a distinct normalized status', () => {
      const statuses = CARRIER_STATES.map((state) => normalizeCarrierState(state.slug));
      expect(new Set(statuses).size).toBe(statuses.length);
    });

    it('exposes 17 normalized statuses — one per state, the two outcomes, and the unknown escape hatch', () => {
      expect(NORMALIZED_STATUSES).toHaveLength(17);
      expect(NORMALIZED_STATUSES).toEqual(
        expect.arrayContaining(['cancelled', 'returned', 'unknown']),
      );
    });

    it('exposes 10 situation flags, including the raw escape hatch', () => {
      expect(SITUATION_FLAGS).toHaveLength(10);
      expect(SITUATION_FLAGS).toContain('raw');
    });
  });

  describe('normalizeCarrierState()', () => {
    it('normalizes a known state', () => {
      expect(normalizeCarrierState('livre')).toBe('delivered');
      expect(normalizeCarrierState('sortie_en_livraison')).toBe('with_courier');
    });

    it('is case and whitespace tolerant', () => {
      expect(normalizeCarrierState('  Livre ')).toBe('delivered');
    });

    it('never guesses — an unknown state becomes unknown', () => {
      expect(normalizeCarrierState('en_attente_dexchange')).toBe('unknown');
      expect(normalizeCarrierState('totally_new_state')).toBe('unknown');
    });

    it('treats a missing state as unknown', () => {
      expect(normalizeCarrierState(null)).toBe('unknown');
      expect(normalizeCarrierState(undefined)).toBe('unknown');
      expect(normalizeCarrierState('')).toBe('unknown');
    });
  });

  describe('normalizeText()', () => {
    it('strips accents and lowercases', () => {
      expect(normalizeText('Ne Répond pas')).toBe('ne repond pas');
    });

    it('collapses punctuation to single spaces', () => {
      expect(normalizeText('Commande annulée!')).toBe('commande annulee');
    });
  });

  describe('flagForSituation()', () => {
    it('resolves every published situation to a flag', () => {
      for (const situations of Object.values(OFFICIAL_SITUATIONS_BY_STATE)) {
        for (const situation of situations) {
          expect(flagForSituation({ situationDescription: situation })).not.toBeNull();
        }
      }
    });

    it('maps the published descriptions to the expected flags', () => {
      expect(flagForSituation({ situationDescription: 'Ne repond pas (1)' })).toBe('no_answer');
      expect(flagForSituation({ situationDescription: 'Injoignable' })).toBe('unreachable');
      expect(flagForSituation({ situationDescription: 'Commande annulee' })).toBe('customer_cancelled');
      expect(flagForSituation({ situationDescription: 'Appel telephonique' })).toBe('call_attempt');
      expect(flagForSituation({ situationDescription: 'Commune erronee' })).toBe('address_issue');
      expect(flagForSituation({ situationDescription: 'Reporté' })).toBe('postponed');
      expect(flagForSituation({ situationDescription: 'Changement bureau' })).toBe('redirected_to_pickup');
      expect(flagForSituation({ situationDescription: 'En attente du client' })).toBe('awaiting_pickup');
      expect(flagForSituation({ situationDescription: 'SMS envoyé' })).toBe('sms_sent');
    });

    it('reads the slug of a parcel’s current situation', () => {
      expect(flagForSituation({ slug: 'commande_annulee' })).toBe('customer_cancelled');
    });

    it('reads the slug of a transition’s situation', () => {
      expect(flagForSituation({ situationSlug: 'changement_bureau' })).toBe('redirected_to_pickup');
    });

    it('returns null for an unrecognised situation', () => {
      expect(flagForSituation({ situationDescription: 'Situation inconnue de ZR' })).toBeNull();
    });

    it('returns null for an absent situation', () => {
      expect(flagForSituation(null)).toBeNull();
      expect(flagForSituation(undefined)).toBeNull();
    });
  });

  describe('flagsForSituations()', () => {
    it('collects every distinct flag', () => {
      const flags = flagsForSituations([
        { situationDescription: 'Ne repond pas (1)' },
        { situationDescription: 'Injoignable' },
        { situationDescription: 'Appel telephonique' },
      ]);
      expect(flags.sort()).toEqual(['call_attempt', 'no_answer', 'unreachable']);
    });

    it('falls back to raw for an unrecognised situation', () => {
      expect(flagsForSituations([{ situationDescription: 'Situation inconnue de ZR' }])).toEqual(['raw']);
    });

    it('returns an empty list for no situations', () => {
      expect(flagsForSituations(null)).toEqual([]);
      expect(flagsForSituations([])).toEqual([]);
    });
  });

  describe('isTerminalCarrierState()', () => {
    it('recognizes the terminal band', () => {
      expect(TERMINAL_BAND).toEqual(['livre', 'encaisse', 'recouvert']);
      expect(isTerminalCarrierState('livre')).toBe(true);
      expect(isTerminalCarrierState('encaisse')).toBe(true);
      expect(isTerminalCarrierState('recouvert')).toBe(true);
    });

    it('rejects every non-terminal state', () => {
      expect(isTerminalCarrierState('sortie_en_livraison')).toBe(false);
      expect(isTerminalCarrierState('commande_recue')).toBe(false);
      expect(isTerminalCarrierState(null)).toBe(false);
    });
  });

  describe('the advance edge set', () => {
    it('publishes exactly the two legal edges', () => {
      expect(ORDER_ADVANCE_EDGES).toEqual([
        { from: 'dispatched', to: 'in-transit' },
        { from: 'in-transit', to: 'delivered' },
      ]);
    });

    it('triggers only on the delivered band', () => {
      expect(DELIVERY_TRIGGER_STATUS).toBe('delivered');
    });
  });

  describe('detectCarrierOrderSignal()', () => {
    function detect(fixture: (typeof ALL_SIGNAL_FIXTURES)[number]) {
      const parcel = mapParcel(fixture.parcel, fixture.stateOverrides, fixture.signalOverrides);
      const history = fixture.history.map((entry) =>
        mapHistoryEntry(entry, fixture.stateOverrides),
      );
      return {
        parcel,
        detection: detectCarrierOrderSignal(parcel, history, fixture.signalOverrides),
      };
    }

    it('covers every Phase 0 fixture exactly', () => {
      expect(ALL_SIGNAL_FIXTURES).toHaveLength(
        CORE_STATE_SIGNAL_FIXTURES.length +
          CANCEL_SIGNAL_FIXTURES.length +
          RETURN_SIGNAL_FIXTURES.length +
          UNKNOWN_SIGNAL_FIXTURES.length +
          HISTORY_PRECEDENCE_FIXTURES.length,
      );
    });

    it.each(ALL_SIGNAL_FIXTURES)('$name', (fixture) => {
      const { detection } = detect(fixture);
      expect(detection.signal).toBe(fixture.expectedSignal);

      const plan = planCarrierOrderAction(fixture.orderStatus, detection);
      if (fixture.expectedTarget === null) {
        expect(plan.target).toBeNull();
      } else {
        expect(plan.target ?? fixture.orderStatus).toBe(fixture.expectedTarget);
      }
    });

    it('maps the 14 core states to the normative order signal', () => {
      for (const fixture of CORE_STATE_SIGNAL_FIXTURES) {
        expect(detect(fixture).detection.signal).toBe(fixture.expectedSignal);
      }
    });

    it('ignores a stale cancel situation once the parcel has moved on', () => {
      const fixture = HISTORY_PRECEDENCE_FIXTURES[0];
      expect(detect(fixture).detection.signal).toBe('in_transit');
    });

    it('reports the evidence source', () => {
      const cancel = detect(CANCEL_SIGNAL_FIXTURES[0]);
      expect(cancel.detection).toEqual({ signal: 'cancelled', source: 'situation' });

      const returned = detect(RETURN_SIGNAL_FIXTURES[0]);
      expect(returned.detection).toEqual({ signal: 'returned', source: 'state' });

      const overridden = detect(RETURN_SIGNAL_FIXTURES[4]);
      expect(overridden.detection).toEqual({ signal: 'returned', source: 'override' });

      expect(detect(UNKNOWN_SIGNAL_FIXTURES[0]).detection).toEqual({
        signal: 'none',
        source: 'none',
      });
    });

    it('uses the latest state, not the newest array element blindly', () => {
      const parcel = mapParcel({
        id: 'p',
        state: { name: 'pret_a_expedier' },
        lastStateUpdateAt: '2026-10-22T12:00:00.000Z',
      });
      const history = [
        mapHistoryEntry({ id: 'new', createdAt: '2026-10-22T12:00:00.000Z', newState: { name: 'pret_a_expedier' } }),
        mapHistoryEntry({
          id: 'old',
          createdAt: '2026-10-22T10:00:00.000Z',
          newState: { name: 'appel_confirmation' },
          situations: [{ situationSlug: 'commande_annulee' }],
        }),
      ];

      expect(detectCarrierOrderSignal(parcel, history).signal).toBe('in_transit');
    });

    it('treats an exact signal override as auditable evidence', () => {
      expect(applySignalOverride('tenant_state', { tenant_state: 'returned' })).toBe('returned');
      expect(applySignalOverride('tenant_state', { tenant_state: 'nonsense' as never })).toBeNull();
      expect(applySignalOverride('tenant_state', null)).toBeNull();
    });

    it('maps a cancel state and a return state to their display outcome', () => {
      expect(mapParcel({ id: 'p', state: { name: 'commande_annulee' } }).deliveryStatus).toBe(
        'cancelled',
      );
      expect(
        mapParcel({ id: 'p', state: { name: 'retour_a_lexpediteur' } }).deliveryStatus,
      ).toBe('returned');
    });
  });

  describe('planCarrierOrderAction()', () => {
    it('walks dispatched → in-transit → delivered in one plan', () => {
      expect(planCarrierOrderAction('dispatched', 'delivered')).toEqual({
        signal: 'delivered',
        target: 'delivered',
        steps: ['in-transit', 'delivered'],
        inventoryAware: false,
      });
    });

    it('plans a single delivered step from in-transit', () => {
      expect(planCarrierOrderAction('in-transit', 'delivered').steps).toEqual(['delivered']);
    });

    it('plans the first advance only for in_transit', () => {
      expect(planCarrierOrderAction('dispatched', 'in_transit')).toEqual({
        signal: 'in_transit',
        target: 'in-transit',
        steps: ['in-transit'],
        inventoryAware: false,
      });
      expect(planCarrierOrderAction('in-transit', 'in_transit').target).toBeNull();
    });

    it('marks only a cancel as inventory-aware', () => {
      expect(planCarrierOrderAction('confirmed', 'cancelled')).toEqual({
        signal: 'cancelled',
        target: 'cancelled',
        steps: ['cancelled'],
        inventoryAware: true,
      });
      expect(planCarrierOrderAction('dispatched', 'returned').inventoryAware).toBe(false);
    });

    it('turns a cancel after delivery into a no-op for the order service to conflict on', () => {
      expect(planCarrierOrderAction('delivered', 'cancelled')).toEqual({
        signal: 'cancelled',
        target: null,
        steps: [],
        inventoryAware: true,
      });
    });

    it('refuses a second terminal outcome', () => {
      expect(planCarrierOrderAction('cancelled', 'returned').target).toBeNull();
      expect(planCarrierOrderAction('returned', 'cancelled').target).toBeNull();
    });

    it('keeps the signal vocabulary closed', () => {
      expect(CARRIER_ORDER_SIGNALS).toEqual([
        'none',
        'in_transit',
        'delivered',
        'cancelled',
        'returned',
      ]);
    });
  });

  describe('mapParcel()', () => {
    it('maps a parcel to the platform vocabulary', () => {
      const mapped = mapParcel({
        id: 'parcel-1',
        externalId: 'ORD-1',
        trackingNumber: 'TRK-1',
        state: { id: 'state-uuid', name: 'sortie_en_livraison', description: 'Driver is on the road' },
        situation: { slug: 'changement_bureau' },
        lastStateUpdateAt: '2026-10-20T10:00:00.000Z',
        createdAt: '2026-10-19T08:00:00.000Z',
        deliveryType: 'COD',
      });

      expect(mapped.parcelId).toBe('parcel-1');
      expect(mapped.externalId).toBe('ORD-1');
      expect(mapped.trackingNumber).toBe('TRK-1');
      expect(mapped.deliveryStatus).toBe('with_courier');
      expect(mapped.carrierStateId).toBe('state-uuid');
      expect(mapped.carrierStateName).toBe('sortie_en_livraison');
      expect(mapped.terminal).toBe(false);
      expect(mapped.situationFlags).toEqual(['redirected_to_pickup']);
      expect(mapped.lastStateUpdateAt).toEqual(new Date('2026-10-20T10:00:00.000Z'));
      expect(mapped.createdAt).toEqual(new Date('2026-10-19T08:00:00.000Z'));
    });

    it('marks a delivered parcel as terminal', () => {
      const mapped = mapParcel({ id: 'p', state: { name: 'livre' } });
      expect(mapped.deliveryStatus).toBe('delivered');
      expect(mapped.terminal).toBe(true);
    });

    it('never guesses — an unknown state is unknown and not terminal', () => {
      const mapped = mapParcel({ id: 'p', state: { name: 'en_attente_dexchange' } });
      expect(mapped.deliveryStatus).toBe('unknown');
      expect(mapped.terminal).toBe(false);
    });

    it('survives a parcel with no state at all', () => {
      const mapped = mapParcel({ id: 'p' });
      expect(mapped.deliveryStatus).toBe('unknown');
      expect(mapped.carrierStateName).toBeNull();
      expect(mapped.lastStateUpdateAt).toBeNull();
    });

    it('keeps the raw payload for diagnostics', () => {
      const raw = { id: 'p', state: { name: 'livre' }, custom: 'field' };
      expect(mapParcel(raw).raw).toBe(raw);
    });
  });

  describe('the per-tenant override (§11.3)', () => {
    it('redirects a carrier slug to another catalogue slug', () => {
      const overrides = { pret_a_expedier: 'en_preparation' };

      expect(applyStateOverride('pret_a_expedier', overrides)).toBe('en_preparation');
      expect(normalizeCarrierState('pret_a_expedier', overrides)).toBe('preparing');
    });

    it('leaves an unmapped carrier slug alone', () => {
      expect(applyStateOverride('livre', { pret_a_expedier: 'en_preparation' })).toBe('livre');
      expect(normalizeCarrierState('livre', { pret_a_expedier: 'en_preparation' })).toBe('delivered');
    });

    it('ignores an override that targets a slug outside the catalogue', () => {
      const overrides = { pret_a_expedier: 'not_a_real_state' };

      expect(applyStateOverride('pret_a_expedier', overrides)).toBe('pret_a_expedier');
      expect(normalizeCarrierState('pret_a_expedier', overrides)).toBe('ready_for_pickup');
    });

    it('changes only the normalized status — the raw carrier state is kept', () => {
      const mapped = mapParcel(
        { id: 'p', state: { id: 'state-uuid', name: 'pret_a_expedier' } },
        { pret_a_expedier: 'en_preparation' },
      );

      expect(mapped.deliveryStatus).toBe('preparing');
      expect(mapped.carrierStateName).toBe('pret_a_expedier');
      expect(mapped.carrierStateId).toBe('state-uuid');
    });

    it('applies to a transition as well', () => {
      const mapped = mapHistoryEntry(
        { id: 'entry-1', previousState: { name: 'pret_a_expedier' }, newState: { name: 'livre' } },
        { pret_a_expedier: 'en_preparation' },
      );

      expect(mapped.fromStatus).toBe('preparing');
      expect(mapped.toStatus).toBe('delivered');
    });
  });

  describe('mapHistoryEntry()', () => {
    it('maps a transition', () => {
      const mapped = mapHistoryEntry({
        id: 'entry-1',
        parcelId: 'parcel-1',
        createdAt: '2026-10-20T10:00:00.000Z',
        previousState: { name: 'en_livraison' },
        newState: { name: 'sortie_en_livraison' },
        modifiedBy: { fullName: 'Karim B.' },
        location: { hubName: 'Hub Alger Centre', hubCity: 'Alger' },
        comment: 'Driver departed',
        situations: [{ situationName: 'Appel telephonique' }],
      });

      expect(mapped.providerEntryId).toBe('entry-1');
      expect(mapped.parcelId).toBe('parcel-1');
      expect(mapped.fromState).toBe('en_livraison');
      expect(mapped.toState).toBe('sortie_en_livraison');
      expect(mapped.fromStatus).toBe('out_for_delivery');
      expect(mapped.toStatus).toBe('with_courier');
      expect(mapped.at).toEqual(new Date('2026-10-20T10:00:00.000Z'));
      expect(mapped.comment).toBe('Driver departed');
      expect(mapped.hubName).toBe('Hub Alger Centre');
      expect(mapped.hubCity).toBe('Alger');
      expect(mapped.modifiedBy).toBe('Karim B.');
      expect(mapped.situations[0].flags).toEqual(['call_attempt']);
    });

    it('falls back to the arrival hub when there is no location', () => {
      const mapped = mapHistoryEntry({
        id: 'e',
        newState: { name: 'livre' },
        arrivalHub: { hubName: 'StopDesk Bab Ezzouar' },
      });
      expect(mapped.hubName).toBe('StopDesk Bab Ezzouar');
    });

    it('survives a transition with no states and no situations', () => {
      const mapped = mapHistoryEntry({ id: 'e' });
      expect(mapped.fromStatus).toBe('unknown');
      expect(mapped.toStatus).toBe('unknown');
      expect(mapped.at).toBeNull();
      expect(mapped.situations).toEqual([]);
    });
  });
});
