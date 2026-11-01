import {
  isNoestDispatchable,
  isNoestMappingRequired,
  isNoestMappingValid,
  normalizeNoestCommuneSelection,
} from './noest-commune';
import { normalizeNoestCommunes } from './handlers/noest.handler';

describe('normalizeNoestCommunes', () => {
  it('parses the documented bare array', () => {
    const communes = normalizeNoestCommunes(
      [
        { nom: 'Batna', wilaya_id: 5, code_postal: '05001', is_active: 1 },
        { nom: 'Barika', wilaya_id: 5, code_postal: '05002', is_active: 1 },
      ],
      '5',
    );

    expect(communes).toEqual([
      { name: 'Barika', wilayaId: '5', postalCode: '05002' },
      { name: 'Batna', wilayaId: '5', postalCode: '05001' },
    ]);
  });

  it('normalises a { data: [...] } envelope and an object-keyed envelope', () => {
    expect(
      normalizeNoestCommunes({ data: [{ nom: 'Batna', wilaya_id: 5 }] }, '5'),
    ).toHaveLength(1);

    expect(
      normalizeNoestCommunes({ 0: { nom: 'Batna', wilaya_id: 5 } }, '5'),
    ).toEqual([{ name: 'Batna', wilayaId: '5', postalCode: null }]);
  });

  it('drops inactive communes in every shape the carrier uses', () => {
    const communes = normalizeNoestCommunes(
      [
        { nom: 'Active', wilaya_id: 5, is_active: 1 },
        { nom: 'Zero', wilaya_id: 5, is_active: 0 },
        { nom: 'StringZero', wilaya_id: 5, is_active: '0' },
        { nom: 'False', wilaya_id: 5, is_active: false },
      ],
      '5',
    );

    expect(communes.map((c) => c.name)).toEqual(['Active']);
  });

  it('drops entries belonging to another wilaya', () => {
    const communes = normalizeNoestCommunes(
      [
        { nom: 'Batna', wilaya_id: 5 },
        { nom: 'Oran', wilaya_id: 31 },
      ],
      '5',
    );

    expect(communes.map((c) => c.name)).toEqual(['Batna']);
  });

  it('deduplicates case-insensitively and sorts with fr collation', () => {
    const communes = normalizeNoestCommunes(
      [
        { nom: 'Tadjena', wilaya_id: 5 },
        { nom: 'tadjena', wilaya_id: 5 },
        { nom: 'Barika', wilaya_id: 5 },
      ],
      '5',
    );

    expect(communes.map((c) => c.name)).toEqual(['Barika', 'Tadjena']);
  });

  it('produces no hasStopDesk key — Noest publishes no such flag', () => {
    const [commune] = normalizeNoestCommunes([{ nom: 'Batna', wilaya_id: 5 }], '5');

    expect(commune).not.toHaveProperty('hasStopDesk');
    expect(Object.keys(commune).sort()).toEqual(['name', 'postalCode', 'wilayaId']);
  });

  it('degrades to an empty list for an unusable body', () => {
    expect(normalizeNoestCommunes(null, '5')).toEqual([]);
    expect(normalizeNoestCommunes('not-json', '5')).toEqual([]);
  });
});

describe('isNoestMappingValid', () => {
  it('accepts a selection for the order wilaya', () => {
    expect(
      isNoestMappingValid({ customer: { wilaya: '5' }, noestCommune: { name: 'Batna', wilayaId: '5' } }),
    ).toBe(true);
  });

  it('rejects a missing/blank selection and a wilaya mismatch', () => {
    expect(isNoestMappingValid({ customer: { wilaya: '5' }, noestCommune: null })).toBe(false);
    expect(
      isNoestMappingValid({ customer: { wilaya: '5' }, noestCommune: { name: '  ', wilayaId: '5' } }),
    ).toBe(false);
    expect(
      isNoestMappingValid({ customer: { wilaya: '5' }, noestCommune: { name: 'Oran', wilayaId: '31' } }),
    ).toBe(false);
  });
});

describe('isNoestDispatchable', () => {
  it('requires a mapping only for Noest orders', () => {
    expect(isNoestMappingRequired({ deliveryCompanyId: 'noest' })).toBe(true);
    expect(isNoestMappingRequired({ deliveryCompanyId: 'dhd' })).toBe(false);
    expect(isNoestDispatchable({ deliveryCompanyId: 'dhd' })).toBe(true);
  });

  it('accepts a registry mapping even with no explicit selection', () => {
    expect(isNoestDispatchable({ deliveryCompanyId: 'noest', customer: { wilaya: '5' } }, 'Batna')).toBe(true);
    expect(isNoestDispatchable({ deliveryCompanyId: 'noest', customer: { wilaya: '5' } }, '   ')).toBe(false);
  });

  it('rejects a Noest order with neither a selection nor a registry mapping', () => {
    expect(isNoestDispatchable({ deliveryCompanyId: 'noest', customer: { wilaya: '5' } })).toBe(false);
  });
});

describe('normalizeNoestCommuneSelection', () => {
  const now = new Date('2026-10-31T10:15:30.000Z');

  it('trims, floors a numeric wilaya and stamps the audit fields', () => {
    expect(
      normalizeNoestCommuneSelection(
        { name: '  Batna  ', wilayaId: '5.9', postalCode: ' 05001 ' },
        'user-1',
        now,
      ),
    ).toEqual({
      name: 'Batna',
      wilayaId: '5',
      postalCode: '05001',
      selectedAt: now,
      selectedBy: 'user-1',
    });
  });

  it('rejects a blank name and a wilaya outside 1..58', () => {
    expect(normalizeNoestCommuneSelection({ name: '', wilayaId: '5' })).toBeNull();
    expect(normalizeNoestCommuneSelection({ name: 'Batna', wilayaId: '0' })).toBeNull();
    expect(normalizeNoestCommuneSelection({ name: 'Batna', wilayaId: '59' })).toBeNull();
    expect(normalizeNoestCommuneSelection({ name: 'Batna', wilayaId: null })).toBeNull();
  });

  it('stores a missing postal code as null and never a hasStopDesk flag', () => {
    const normalized = normalizeNoestCommuneSelection({ name: 'Batna', wilayaId: 5 }, null, now);

    expect(normalized?.postalCode).toBeNull();
    expect(normalized).not.toHaveProperty('hasStopDesk');
  });
});
