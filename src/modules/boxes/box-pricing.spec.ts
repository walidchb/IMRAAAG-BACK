import {
  availableBoxes,
  bestReferenceTotal,
  selectionAvailableBoxes,
  selectionIssues,
  selectionReferenceTotal,
  selectionSavings,
  worstReferenceTotal,
  BoxPricingEligibilityEntry,
} from './box-pricing';

const units = (...pairs: Array<[number, number]>) =>
  pairs.map(([unitPrice, available]) => ({ unitPrice, available }));

describe('box-pricing', () => {
  describe('availableBoxes', () => {
    it('divides the aggregate stock when duplicates are allowed', () => {
      expect(availableBoxes([3, 4], 2, true)).toBe(3);
      expect(availableBoxes([1, 0, 0], 2, true)).toBe(0);
    });

    it('takes the requiredQuantity-th largest availability when duplicates are off', () => {
      expect(availableBoxes([5, 4, 3], 2, false)).toBe(4);
      expect(availableBoxes([5, 0, 3], 2, false)).toBe(3);
      // Fewer than two stocked variants cannot fill a Box of two.
      expect(availableBoxes([5, 0], 2, false)).toBe(0);
    });

    it('returns 0 for a non-positive required quantity', () => {
      expect(availableBoxes([5], 0, true)).toBe(0);
    });
  });

  describe('bestReferenceTotal / worstReferenceTotal', () => {
    it('uses the cheapest in-stock units and respects the duplicate cap', () => {
      const stock = units([500, 2], [300, 1], [900, 3]);
      expect(bestReferenceTotal(stock, 2, true)).toBe(800); // 300 + 500
      expect(worstReferenceTotal(stock, 2, true)).toBe(1800); // 900 + 900
    });

    it('takes distinct variants when duplicates are disallowed', () => {
      const stock = units([100, 5], [200, 1]);
      expect(bestReferenceTotal(stock, 2, false)).toBe(300);
      expect(bestReferenceTotal(stock, 3, false)).toBeNull();
    });

    it('returns null when there is not enough stock', () => {
      expect(bestReferenceTotal(units([100, 1]), 2, true)).toBeNull();
      expect(worstReferenceTotal(units([100, 1]), 2, true)).toBeNull();
    });
  });

  describe('selection math', () => {
    const prices = new Map([
      ['v1', 400],
      ['v2', 250],
      ['v3', 900],
    ]);

    it('sums the chosen composition', () => {
      expect(
        selectionReferenceTotal(
          [
            { variantId: 'v1', quantity: 2 },
            { variantId: 'v2', quantity: 2 },
          ],
          prices,
        ),
      ).toBe(1300);
    });

    it('clamps savings to zero and never reports a fake discount', () => {
      expect(selectionSavings(1300, 1000)).toBe(300);
      expect(selectionSavings(900, 1000)).toBe(0);
    });

    it('computes the exact-composition available Box count', () => {
      const availability = new Map([
        ['v1', 5],
        ['v2', 3],
      ]);
      expect(
        selectionAvailableBoxes(
          [
            { variantId: 'v1', quantity: 2 },
            { variantId: 'v2', quantity: 1 },
          ],
          availability,
        ),
      ).toBe(2);
      expect(
        selectionAvailableBoxes([{ variantId: 'missing', quantity: 1 }], availability),
      ).toBe(0);
    });
  });

  describe('selectionIssues', () => {
    const base = {
      price: 1000,
      requiredQuantity: 2,
      allowDuplicates: true,
      storeId: 'store-1',
      published: true,
      isArchived: false,
    };
    const eligibilityEntry = (
      overrides: Partial<BoxPricingEligibilityEntry> = {},
    ): BoxPricingEligibilityEntry => ({
      productId: 'p1',
      storeId: 'store-1',
      isActive: true,
      isDeleted: false,
      productPublished: true,
      productArchived: false,
      ...overrides,
    });
    const eligibility = new Map([
      ['v1', eligibilityEntry()],
      ['v2', eligibilityEntry()],
    ]);
    const availability = new Map([
      ['v1', 5],
      ['v2', 5],
    ]);

    it('accepts an exact, eligible, stocked selection', () => {
      expect(
        selectionIssues({
          box: base,
          selections: [
            { variantId: 'v1', quantity: 1 },
            { variantId: 'v2', quantity: 1 },
          ],
          eligibility,
          availability,
          storeId: 'store-1',
          mode: 'public',
        }),
      ).toEqual([]);
    });

    it('rejects a sum that does not equal requiredQuantity', () => {
      expect(
        selectionIssues({
          box: base,
          selections: [{ variantId: 'v1', quantity: 1 }],
          eligibility,
          availability,
          storeId: 'store-1',
          mode: 'public',
        }),
      ).toContain('BOX_SELECTION_INVALID');
    });

    it('rejects duplicate variant ids and duplicates when disallowed', () => {
      const duplicateSelection = {
        box: { ...base, allowDuplicates: false },
        selections: [
          { variantId: 'v1', quantity: 2 },
          { variantId: 'v2', quantity: 1 },
        ],
        eligibility,
        availability,
        storeId: 'store-1',
        mode: 'public' as const,
      };
      expect(selectionIssues(duplicateSelection)).toContain(
        'BOX_SELECTION_INVALID',
      );
    });

    it('rejects an ineligible variant and a foreign-store selection', () => {
      const foreign = new Map([
        ['v1', eligibilityEntry({ storeId: 'store-2' })],
        ['v2', eligibilityEntry()],
      ]);
      expect(
        selectionIssues({
          box: base,
          selections: [
            { variantId: 'v1', quantity: 1 },
            { variantId: 'v2', quantity: 1 },
          ],
          eligibility: foreign,
          availability,
          storeId: 'store-1',
          mode: 'public',
        }),
      ).toContain('BOX_STORE_MISMATCH');
    });

    it('reports unavailable stock and archived/unpublished Boxes', () => {
      const issues = selectionIssues({
        box: { ...base, published: false, isArchived: true },
        selections: [
          { variantId: 'v1', quantity: 2 },
          { variantId: 'v2', quantity: 1 },
        ],
        eligibility,
        availability: new Map([
          ['v1', 0],
          ['v2', 5],
        ]),
        storeId: 'store-1',
        mode: 'public',
      });
      expect(issues).toEqual(
        expect.arrayContaining(['BOX_ARCHIVED', 'BOX_NOT_ACTIVE']),
      );
    });
  });
});
