import {
  ECOM_SITUATION_FLAGS,
  ECOM_STATUS_RULES,
  detectEcomOrderSignal,
  ecomSituationFlags,
  ecomStatusRule,
  isEcomTerminalStatus,
  mapEcomHistoryEntries,
  mapEcomParcel,
  normalizeEcomStatus,
  validateEcomCatalogue,
} from './ecom-status.mapper';
import { EcomHistoryEntryDto, EcomParcelDto } from './ecom-status.types';

const deliveredParcel: EcomParcelDto = {
  tracking: 'ECBGE309',
  id_externe: 'CMD-1001',
  trouve: true,
  situation: 'Livrée',
  id_situation: 7,
  etat_logistique: 'Livrée',
  id_etat_logistique: 9,
  date_action: '2026-06-10 16:45:00+00:00',
  encaisser: true,
  recouvert: false,
  stopdesk: 0,
};

const history: EcomHistoryEntryDto[] = [
  {
    date: '2026-06-09 09:12:00+00:00',
    ville: 16,
    situation: 'En Préparation',
    commentaire: 'Création Api_v2',
  },
  {
    date: '2026-06-09 14:30:00+00:00',
    ville: 16,
    situation: 'Au Bureau',
    commentaire: null,
  },
  {
    date: '2026-06-10 08:05:00+00:00',
    ville: 16,
    situation: 'Sortir en livraison',
    commentaire: null,
  },
  {
    date: '2026-06-10 11:20:00+00:00',
    ville: 16,
    situation: 'Ne Réponde pas #1',
    commentaire: 'Client injoignable',
  },
  {
    date: '2026-06-10 16:45:00+00:00',
    ville: 16,
    situation: 'Livrée',
    commentaire: 'Remis au client',
  },
];

describe('ecom-status.mapper', () => {
  describe('validateEcomCatalogue()', () => {
    it('reports no problems for the offline contract', () => {
      expect(validateEcomCatalogue()).toEqual([]);
    });

    it('publishes a unique key per rule', () => {
      const keys = ECOM_STATUS_RULES.map((rule) => rule.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('publishes every situation flag with a phrase rule', () => {
      expect(ECOM_SITUATION_FLAGS).toHaveLength(9);
    });
  });

  describe('normalizeEcomStatus()', () => {
    it.each([
      ['EnCours', 'processing'],
      ['En Traitement', 'processing'],
      ['Commande Confirmée', 'customer_confirmed'],
      ['En Préparation', 'preparing'],
      ['Au Bureau', 'at_pickup_point'],
      ['En livraison', 'out_for_delivery'],
      ['Sortir en livraison', 'with_courier'],
      ['Livrée', 'delivered'],
      ['Encaisser', 'cash_collected'],
      ['Recouvert', 'settled'],
    ])('maps %s to %s', (label, expected) => {
      expect(normalizeEcomStatus(label)).toBe(expected);
    });

    it('normalizes accents, case and whitespace', () => {
      expect(normalizeEcomStatus('  LIVREE ')).toBe('delivered');
      expect(normalizeEcomStatus('en preparation')).toBe('preparing');
    });

    it('maps cancellation and return labels', () => {
      expect(normalizeEcomStatus('Commande annulée')).toBe('cancelled');
      expect(normalizeEcomStatus('Annulée')).toBe('cancelled');
      expect(normalizeEcomStatus('Retournée')).toBe('returned');
      expect(normalizeEcomStatus('Refusée')).toBe('returned');
    });

    it('never guesses an unknown label', () => {
      expect(normalizeEcomStatus('Nouvelle situation')).toBe('unknown');
      expect(normalizeEcomStatus(null)).toBe('unknown');
    });

    it('keeps Récupérer unresolved', () => {
      expect(normalizeEcomStatus('Récupérer')).toBe('unknown');
      expect(ecomStatusRule('Récupérer')?.unresolved).toBe(true);
    });

    it('applies a valid display override', () => {
      expect(normalizeEcomStatus('Au Bureau', { 'au bureau': 'dispatch_local' })).toBe(
        'dispatch_local',
      );
    });

    it('ignores an override that invents a status', () => {
      expect(normalizeEcomStatus('Au Bureau', { 'au bureau': 'made_up' })).toBe(
        'at_pickup_point',
      );
    });
  });

  describe('ecomSituationFlags()', () => {
    it('reads a no-answer label and an unreachable comment', () => {
      expect(ecomSituationFlags('Ne Réponde pas #1', 'Client injoignable')).toEqual([
        'no_answer',
        'unreachable',
      ]);
    });

    it('maps a cancellation phrase', () => {
      expect(ecomSituationFlags('Commande annulée')).toEqual(['customer_cancelled']);
    });

    it('returns no flags for a normal transport label', () => {
      expect(ecomSituationFlags('Au Bureau')).toEqual([]);
    });
  });

  describe('isEcomTerminalStatus()', () => {
    it('recognizes the delivered and outcome bands', () => {
      expect(isEcomTerminalStatus('delivered')).toBe(true);
      expect(isEcomTerminalStatus('cash_collected')).toBe(true);
      expect(isEcomTerminalStatus('settled')).toBe(true);
      expect(isEcomTerminalStatus('cancelled')).toBe(true);
      expect(isEcomTerminalStatus('returned')).toBe(true);
    });

    it('does not treat an in-flight or unknown status as terminal', () => {
      expect(isEcomTerminalStatus('preparing')).toBe(false);
      expect(isEcomTerminalStatus('unknown')).toBe(false);
    });
  });

  describe('mapEcomParcel()', () => {
    it('maps the documented delivered status', () => {
      const mapped = mapEcomParcel(deliveredParcel);

      expect(mapped.parcelId).toBe('ECBGE309');
      expect(mapped.trackingNumber).toBe('ECBGE309');
      expect(mapped.externalId).toBe('CMD-1001');
      expect(mapped.deliveryStatus).toBe('delivered');
      expect(mapped.terminal).toBe(true);
      expect(mapped.carrierStateId).toBe('9');
      expect(mapped.carrierStateName).toBe('livree');
      expect(mapped.carrierStateDescription).toBe('Livrée');
      expect(mapped.deliveryType).toBe('home');
      expect(mapped.lastStateUpdateAt?.toISOString()).toBe(
        '2026-06-10T16:45:00.000Z',
      );
    });

    it('maps a stopdesk parcel to a pickup-point delivery type', () => {
      expect(mapEcomParcel({ ...deliveredParcel, stopdesk: 1 }).deliveryType).toBe(
        'pickup-point',
      );
    });

    it('falls back to the situation axis when the logistic label is absent', () => {
      const mapped = mapEcomParcel({
        tracking: 'T1',
        situation: 'Commande Confirmée',
        id_situation: 2,
      });

      expect(mapped.deliveryStatus).toBe('customer_confirmed');
      expect(mapped.carrierStateId).toBe('2');
    });

    it('keeps both raw axes and the financial flags', () => {
      const mapped = mapEcomParcel(deliveredParcel);

      expect(mapped.rawSituation).toEqual({
        situation: 'Livrée',
        id_situation: 7,
        etat_logistique: 'Livrée',
        id_etat_logistique: 9,
        encaisser: true,
        recouvert: false,
      });
    });
  });

  describe('detectEcomOrderSignal()', () => {
    it('signals delivered from the current state', () => {
      expect(detectEcomOrderSignal(deliveredParcel)).toEqual({
        signal: 'delivered',
        source: 'state',
      });
    });

    it('ignores an older cancellation once the current state moved on', () => {
      const parcel: EcomParcelDto = {
        ...deliveredParcel,
        date_action: '2026-06-10 18:00:00+00:00',
      };
      const olderCancel: EcomHistoryEntryDto[] = [
        {
          date: '2026-06-10 12:00:00+00:00',
          ville: 16,
          situation: 'Commande annulée',
          commentaire: null,
        },
      ];

      expect(detectEcomOrderSignal(parcel, olderCancel).signal).toBe('delivered');
    });

    it('lets a newer return override an older delivered state', () => {
      const parcel: EcomParcelDto = {
        tracking: 'T2',
        situation: 'EnCours',
        etat_logistique: 'Au Bureau',
        date_action: '2026-06-10 10:00:00+00:00',
      };
      const newerReturn: EcomHistoryEntryDto[] = [
        {
          date: '2026-06-10 12:00:00+00:00',
          ville: 16,
          situation: 'Retournée',
          commentaire: 'Refusée par le client',
        },
      ];

      expect(detectEcomOrderSignal(parcel, newerReturn)).toEqual({
        signal: 'returned',
        source: 'situation',
      });
    });

    it('signals cancelled from a current cancellation label', () => {
      expect(
        detectEcomOrderSignal({
          tracking: 'T3',
          situation: 'Commande annulée',
          etat_logistique: 'Commande annulée',
          date_action: '2026-06-10 12:00:00+00:00',
        }),
      ).toEqual({ signal: 'cancelled', source: 'state' });
    });

    it('uses financial corroboration only as a delivery signal', () => {
      expect(
        detectEcomOrderSignal({
          tracking: 'T4',
          situation: 'Nouvelle situation',
          etat_logistique: 'Nouvelle situation',
          date_action: '2026-06-10 12:00:00+00:00',
          encaisser: true,
        }),
      ).toEqual({ signal: 'delivered', source: 'state' });
    });

    it('never treats Récupérer as delivered', () => {
      expect(
        detectEcomOrderSignal({
          tracking: 'T5',
          situation: 'EnCours',
          etat_logistique: 'Récupérer',
          date_action: '2026-06-10 12:00:00+00:00',
        }),
      ).toEqual({ signal: 'none', source: 'none' });
    });

    it('ignores an older delivered history while Récupérer is current', () => {
      const parcel: EcomParcelDto = {
        tracking: 'T5',
        situation: 'EnCours',
        etat_logistique: 'Récupérer',
        date_action: '2026-06-10 12:00:00+00:00',
        historique: [
          {
            date: '2026-06-10 09:00:00+00:00',
            ville: 16,
            situation: 'Livrée',
            commentaire: null,
          },
        ],
      };

      expect(detectEcomOrderSignal(parcel).signal).toBe('none');
    });

    it('applies a valid signal override', () => {
      expect(
        detectEcomOrderSignal(
          {
            tracking: 'T6',
            situation: 'EnCours',
            etat_logistique: 'Au Bureau',
            date_action: '2026-06-10 12:00:00+00:00',
          },
          null,
          { 'au bureau': 'returned' },
        ),
      ).toEqual({ signal: 'returned', source: 'override' });
    });

    it('returns none for an unknown event', () => {
      expect(
        detectEcomOrderSignal({
          tracking: 'T7',
          situation: 'Situation inconnue',
          etat_logistique: 'État inconnu',
          date_action: '2026-06-10 12:00:00+00:00',
        }),
      ).toEqual({ signal: 'none', source: 'none' });
    });
  });

  describe('mapEcomHistoryEntries()', () => {
    it('maps the documented history sample chronologically', () => {
      const mapped = mapEcomHistoryEntries('ECBGE309', history);

      expect(mapped).toHaveLength(5);
      expect(mapped[0]).toMatchObject({
        parcelId: 'ECBGE309',
        fromState: null,
        toState: 'en preparation',
        fromStatus: 'unknown',
        toStatus: 'preparing',
      });
      expect(mapped[1]).toMatchObject({
        fromState: 'en preparation',
        toState: 'au bureau',
        fromStatus: 'preparing',
        toStatus: 'at_pickup_point',
      });
      expect(mapped[4]).toMatchObject({
        toState: 'livree',
        toStatus: 'delivered',
        comment: 'Remis au client',
        hubCity: '16',
      });
      expect(mapped[4].providerEntryId).toHaveLength(40);
    });

    it('generates a stable key for the same event', () => {
      const first = mapEcomHistoryEntries('ECBGE309', history)[1];
      const second = mapEcomHistoryEntries('ECBGE309', history)[1];
      expect(second.providerEntryId).toBe(first.providerEntryId);
    });

    it('changes the key when the event position changes', () => {
      const entry = history[1];
      const alone = mapEcomHistoryEntries('ECBGE309', [entry])[0];
      const afterOlder = mapEcomHistoryEntries('ECBGE309', [history[0], entry])[1];

      expect(afterOlder.providerEntryId).not.toBe(alone.providerEntryId);
    });

    it('sorts an unordered payload by carrier timestamp', () => {
      const mapped = mapEcomHistoryEntries('ECBGE309', [
        history[2],
        history[0],
        history[1],
      ]);

      expect(mapped.map((entry) => entry.toState)).toEqual([
        'en preparation',
        'au bureau',
        'sortir en livraison',
      ]);
    });

    it('keeps an unrecognized history label unknown', () => {
      const [mapped] = mapEcomHistoryEntries('ECBGE309', [
        {
          date: '2026-06-10 12:00:00+00:00',
          ville: 16,
          situation: 'Inconnue',
          commentaire: null,
        },
      ]);

      expect(mapped.toStatus).toBe('unknown');
      expect(mapped.situations[0].flags).toEqual([]);
    });
  });
});
