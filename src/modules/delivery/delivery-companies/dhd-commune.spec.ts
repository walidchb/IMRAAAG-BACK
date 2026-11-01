import {
  isDhdDispatchable,
  isDhdMappingRequired,
  isDhdMappingValid,
  normalizeDhdCommuneSelection,
} from './dhd-commune';

describe('dhd-commune domain functions', () => {
  describe('isDhdMappingRequired', () => {
    it('returns true when deliveryCompanyId is dhd', () => {
      expect(isDhdMappingRequired({ deliveryCompanyId: 'dhd' })).toBe(true);
    });

    it('returns false for other delivery companies or unassigned orders', () => {
      expect(isDhdMappingRequired({ deliveryCompanyId: 'zr' })).toBe(false);
      expect(isDhdMappingRequired({ deliveryCompanyId: 'noest' })).toBe(false);
      expect(isDhdMappingRequired({ deliveryCompanyId: null })).toBe(false);
      expect(isDhdMappingRequired({})).toBe(false);
    });
  });

  describe('isDhdMappingValid', () => {
    it('returns true when commune name is present and wilaya matches', () => {
      expect(
        isDhdMappingValid({
          customer: { wilaya: '5' },
          dhdCommune: { name: 'Batna', wilayaId: '5' },
        }),
      ).toBe(true);
    });

    it('normalizes string/number wilayas (e.g. "05" vs "5")', () => {
      expect(
        isDhdMappingValid({
          customer: { wilaya: '05' },
          dhdCommune: { name: 'Batna', wilayaId: '5' },
        }),
      ).toBe(true);
      expect(
        isDhdMappingValid({
          customer: { wilaya: '5' },
          dhdCommune: { name: 'Batna', wilayaId: '05' },
        }),
      ).toBe(true);
    });

    it('returns false when dhdCommune is null, undefined, or empty name', () => {
      expect(isDhdMappingValid({ customer: { wilaya: '5' }, dhdCommune: null })).toBe(false);
      expect(isDhdMappingValid({ customer: { wilaya: '5' }, dhdCommune: undefined })).toBe(false);
      expect(
        isDhdMappingValid({
          customer: { wilaya: '5' },
          dhdCommune: { name: '   ', wilayaId: '5' },
        }),
      ).toBe(false);
    });

    it('returns false when wilaya does not match', () => {
      expect(
        isDhdMappingValid({
          customer: { wilaya: '16' },
          dhdCommune: { name: 'Batna', wilayaId: '5' },
        }),
      ).toBe(false);
    });

    it('returns false when customer wilaya is invalid/missing', () => {
      expect(
        isDhdMappingValid({
          customer: null,
          dhdCommune: { name: 'Batna', wilayaId: '5' },
        }),
      ).toBe(false);
      expect(
        isDhdMappingValid({
          customer: { wilaya: '' },
          dhdCommune: { name: 'Batna', wilayaId: '5' },
        }),
      ).toBe(false);
    });
  });

  describe('isDhdDispatchable', () => {
    it('returns true for non-DHD orders regardless of mapping', () => {
      expect(isDhdDispatchable({ deliveryCompanyId: 'zr' })).toBe(true);
      expect(isDhdDispatchable({ deliveryCompanyId: 'noest', customer: { wilaya: '5' } })).toBe(true);
    });

    it('returns true for home delivery when mapping is valid', () => {
      expect(
        isDhdDispatchable({
          deliveryCompanyId: 'dhd',
          customer: { wilaya: '5' },
          dhdCommune: { name: 'Batna', wilayaId: '5', hasStopDesk: false },
          shippingMethod: 'home',
        }),
      ).toBe(true);
    });

    it('returns false for home delivery when mapping is invalid', () => {
      expect(
        isDhdDispatchable({
          deliveryCompanyId: 'dhd',
          customer: { wilaya: '5' },
          dhdCommune: null,
          shippingMethod: 'home',
        }),
      ).toBe(false);
    });

    it('for stopdesk delivery, requires hasStopDesk === true', () => {
      expect(
        isDhdDispatchable({
          deliveryCompanyId: 'dhd',
          customer: { wilaya: '5' },
          dhdCommune: { name: 'Ain Djasser', wilayaId: '5', hasStopDesk: false },
          shippingMethod: 'stopdesk',
        }),
      ).toBe(false);

      expect(
        isDhdDispatchable({
          deliveryCompanyId: 'dhd',
          customer: { wilaya: '5' },
          dhdCommune: { name: 'Batna', wilayaId: '5', hasStopDesk: true },
          shippingMethod: 'stopdesk',
        }),
      ).toBe(true);
    });
  });

  describe('normalizeDhdCommuneSelection', () => {
    it('normalizes valid selection and stamps server audit fields', () => {
      const fixedDate = new Date('2026-10-30T12:00:00.000Z');
      const result = normalizeDhdCommuneSelection(
        {
          name: '  Batna  ',
          wilayaId: '05',
          postalCode: '  05001  ',
          hasStopDesk: true,
        },
        'user-123',
        fixedDate,
      );

      expect(result).toEqual({
        name: 'Batna',
        wilayaId: '5',
        postalCode: '05001',
        hasStopDesk: true,
        selectedAt: fixedDate,
        selectedBy: 'user-123',
      });
    });

    it('handles numeric wilayaId input', () => {
      const result = normalizeDhdCommuneSelection({
        name: 'Batna',
        wilayaId: 5,
      });
      expect(result?.wilayaId).toBe('5');
    });

    it('returns null if name is empty or invalid wilayaId', () => {
      expect(normalizeDhdCommuneSelection({ name: '', wilayaId: '5' })).toBeNull();
      expect(normalizeDhdCommuneSelection({ name: '   ', wilayaId: '5' })).toBeNull();
      expect(normalizeDhdCommuneSelection({ name: 'Batna', wilayaId: 'abc' })).toBeNull();
      expect(normalizeDhdCommuneSelection({ name: 'Batna', wilayaId: null })).toBeNull();
    });
  });
});
