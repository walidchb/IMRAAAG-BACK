import {
  detectDhdOrderSignal,
  DHD_ACTIVITY_RULES,
  DHD_STATUS_RULES,
  dhdSituationFlags,
  mapDhdHistoryEntries,
  mapDhdParcel,
  normalizeDhdOffset,
  normalizeDhdStatus,
  parseDhdInstant,
  validateDhdCatalogue,
} from './dhd-status.mapper';
import type { DhdParcelDto } from './dhd-status.types';

describe('DHD status catalogue', () => {
  it('is internally consistent', () => {
    expect(validateDhdCatalogue()).toEqual([]);
  });

  it.each([
    ['Prêt à expédier', 'processing'],
    ['Prêt à préparer', 'preparing'],
    ['En ramassage', 'dispatch_local'],
    ['Stock en préparation', 'preparing'],
    ['Vers hub', 'dispatch_local'],
    ['En hub', 'dispatch_interwilaya'],
    ['Vers wilaya', 'dispatch_interwilaya'],
    ['En préparation', 'preparing'],
    ['En livraison', 'out_for_delivery'],
    ['Suspendus', 'unknown'],
    ['Livre non encaissé', 'delivered'],
    ['Livre encaissé non payé', 'cash_collected'],
    ['Paiement prêt', 'settled'],
    ['Paiement archivé', 'settled'],
    ['Retours chez livreur', 'returned'],
    ['Retours en transit stock', 'returned'],
    ['Retours en traitement', 'returned'],
    ['Retours reçu', 'returned'],
    ['Retours archivé', 'returned'],
    ['Retours à dispatcher vers stock', 'returned'],
    ['Retours prêts', 'returned'],
    ['Retours en stock', 'returned'],
    ['Annulé', 'cancelled'],
    ['Annulée', 'cancelled'],
    ['Something new', 'unknown'],
  ])('maps %s to %s', (label, expected) => {
    expect(normalizeDhdStatus(label)).toBe(expected);
  });

  it('keeps every frozen status and activity alias covered', () => {
    for (const rule of DHD_STATUS_RULES) {
      expect(normalizeDhdStatus(rule.label)).toBe(rule.normalized);
    }
    for (const rule of DHD_ACTIVITY_RULES) {
      expect(normalizeDhdStatus(rule.label)).not.toBe('');
    }
  });

  it('honours a store state override before the catalogue', () => {
    expect(normalizeDhdStatus('En livraison', { 'en livraison': 'returned' })).toBe(
      'returned',
    );
    expect(normalizeDhdStatus('En livraison', { 'en livraison': 'not-a-status' })).toBe(
      'out_for_delivery',
    );
  });
});

describe('DHD timestamps and flags', () => {
  it('loads offset-free DHD times as Africa/Algiers by default', () => {
    expect(parseDhdInstant('2026-10-21', '10:15:00')?.toISOString()).toBe(
      '2026-10-21T09:15:00.000Z',
    );
    expect(normalizeDhdOffset('+02:30')).toBe('+02:30');
    expect(normalizeDhdOffset('bad')).toBe('+01:00');
  });

  it('keeps explicit offsets untouched', () => {
    expect(parseDhdInstant('2026-10-21T10:15:00Z')?.toISOString()).toBe(
      '2026-10-21T10:15:00.000Z',
    );
  });

  it('turns refusal and postponement text into flags', () => {
    expect(dhdSituationFlags('Suspendu')).toContain('postponed');
    expect(dhdSituationFlags('En livraison', 'Adresse erronée')).toContain(
      'address_issue',
    );
    expect(
      dhdSituationFlags('En livraison', null, {
        status: 'En livraison',
        postponed_to: '2026-10-22',
      }),
    ).toContain('postponed');
  });
});

describe('DHD order signals', () => {
  it('never advances on preparation or suspension', () => {
    expect(detectDhdOrderSignal({ status: 'En préparation' }).signal).toBe('none');
    expect(detectDhdOrderSignal({ status: 'Suspendu' }).signal).toBe('none');
  });

  it('returns the frozen priority when state and activity disagree', () => {
    expect(
      detectDhdOrderSignal(
        {
          status: 'Livre non encaissé',
          activity: [{ status: 'Retours en stock', date: '2026-10-22' }],
        },
        null,
      ).signal,
    ).toBe('returned');
  });

  it('ignores failed delivery attempts', () => {
    expect(
      detectDhdOrderSignal({
        status: 'En livraison',
        activity: [{ status: 'attempt_delivery', date: '2026-10-22' }],
      }).signal,
    ).toBe('in_transit');
  });

  it('lets a tenant signal override win', () => {
    expect(
      detectDhdOrderSignal(
        { status: 'Livre non encaissé' },
        null,
        { 'livre non encaisse': 'cancelled' },
      ),
    ).toEqual({ signal: 'cancelled', source: 'override' });
  });
});

describe('DHD parcel and history mapping', () => {
  const parcel: DhdParcelDto = {
    tracking: 'DHD123',
    reference: 'ORD-1',
    status: 'En livraison',
    activity: [
      {
        date: '2026-10-20',
        time: '08:00:00',
        status: 'Picked',
        station: 'Alger',
      },
      {
        date: '2026-10-21',
        time: '09:30:00',
        status: 'En livraison',
        station: 'Alger',
        driver: 'Karim',
      },
    ],
  };

  it('maps the current parcel with its last transition watermark', () => {
    const mapped = mapDhdParcel(parcel);
    expect(mapped).toMatchObject({
      parcelId: 'DHD123',
      externalId: 'ORD-1',
      deliveryStatus: 'out_for_delivery',
      terminal: false,
      carrierStateDescription: 'En livraison',
    });
    expect(mapped.lastStateUpdateAt?.toISOString()).toBe('2026-10-21T08:30:00.000Z');
    expect(mapped.situationFlags).toEqual([]);
  });

  it('orders history oldest-first with deterministic ids', () => {
    const first = mapDhdHistoryEntries('DHD123', parcel.activity);
    const second = mapDhdHistoryEntries('DHD123', parcel.activity);
    expect(first.map((entry) => entry.at?.toISOString())).toEqual([
      '2026-10-20T07:00:00.000Z',
      '2026-10-21T08:30:00.000Z',
    ]);
    expect(first.map((entry) => entry.toStatus)).toEqual([
      'dispatch_local',
      'out_for_delivery',
    ]);
    expect(first[0].fromStatus).toBe('unknown');
    expect(first[1].fromState).toBe('picked');
    expect(first.map((entry) => entry.providerEntryId)).toEqual(
      second.map((entry) => entry.providerEntryId),
    );
  });

  it('does not use an unchanged raw state as a new transition', () => {
    const entries = mapDhdHistoryEntries('DHD123', [
      { date: '2026-10-21', time: '09:30:00', status: 'En livraison' },
      { date: '2026-10-21', time: '10:30:00', status: 'En livraison' },
    ]);
    expect(entries.map((entry) => entry.toStatus)).toEqual([
      'out_for_delivery',
      'out_for_delivery',
    ]);
  });
});
