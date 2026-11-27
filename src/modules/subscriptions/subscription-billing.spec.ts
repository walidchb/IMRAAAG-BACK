import {
  addMonthsUtc,
  allowanceForExtension,
  computeBillingOption,
  computeOrdersAllowance,
} from './subscription-billing';
import { AppException } from '../../common/errors/app-exception';

describe('computeBillingOption', () => {
  it('matches the Finance Starter worked table', () => {
    const monthly = computeBillingOption(2000, { durationMonths: 1, discountPercent: 0 });
    expect(monthly).toMatchObject({
      listPrice: 2000,
      finalPrice: 2000,
      savings: 0,
      effectiveDiscountPercent: 0,
      priceSource: 'calculated',
    });

    const six = computeBillingOption(2000, { durationMonths: 6, discountPercent: 10 });
    expect(six).toMatchObject({
      listPrice: 12000,
      calculatedPrice: 10800,
      finalPrice: 10800,
      savings: 1200,
      effectiveDiscountPercent: 10,
      priceSource: 'calculated',
    });

    const yearly = computeBillingOption(2000, { durationMonths: 12, discountPercent: 20 });
    expect(yearly).toMatchObject({
      listPrice: 24000,
      finalPrice: 19200,
      savings: 4800,
      effectiveDiscountPercent: 20,
    });
  });

  it('rounds half-up (2,000 × 6 at 10% discount = 10,800)', () => {
    const result = computeBillingOption(2000, { durationMonths: 6, discountPercent: 10 });
    expect(result.finalPrice).toBe(10800);
  });

  it('supports 0% and 100% discounts', () => {
    expect(
      computeBillingOption(1000, { durationMonths: 3, discountPercent: 0 }).finalPrice,
    ).toBe(3000);
    expect(
      computeBillingOption(1000, { durationMonths: 3, discountPercent: 100 }).finalPrice,
    ).toBe(0);
  });

  it('honours an override below/equal/above the list price', () => {
    const below = computeBillingOption(2000, {
      durationMonths: 6,
      discountPercent: 10,
      priceOverride: 9000,
    });
    expect(below.finalPrice).toBe(9000);
    expect(below.savings).toBe(3000);
    expect(below.priceSource).toBe('override');

    const equal = computeBillingOption(2000, {
      durationMonths: 6,
      discountPercent: 10,
      priceOverride: 12000,
    });
    expect(equal.finalPrice).toBe(12000);
    expect(equal.savings).toBe(0);

    expect(() =>
      computeBillingOption(2000, {
        durationMonths: 6,
        discountPercent: 10,
        priceOverride: 13000,
      }),
    ).toThrow(AppException);
  });

  it('allows a zero price and guards the percent division', () => {
    const free = computeBillingOption(0, { durationMonths: 12, discountPercent: 20 });
    expect(free.listPrice).toBe(0);
    expect(free.finalPrice).toBe(0);
    expect(free.effectiveDiscountPercent).toBe(0);
  });

  it('accepts durations 1, 6, 12 and 36 and rejects 0, 37 and decimals', () => {
    for (const durationMonths of [1, 6, 12, 36]) {
      expect(() => computeBillingOption(100, { durationMonths, discountPercent: 0 })).not.toThrow();
    }
    for (const durationMonths of [0, 37, 1.5]) {
      expect(() => computeBillingOption(100, { durationMonths, discountPercent: 0 })).toThrow(
        AppException,
      );
    }
  });

  it('rejects an invalid or non-integer discount', () => {
    expect(() =>
      computeBillingOption(1000, { durationMonths: 1, discountPercent: 101 }),
    ).toThrow(AppException);
    expect(() =>
      computeBillingOption(1000, { durationMonths: 1, discountPercent: 2.5 }),
    ).toThrow(AppException);
  });
});

describe('computeOrdersAllowance', () => {
  it('multiplies the monthly base by the purchased duration', () => {
    expect(computeOrdersAllowance(1000, 6)).toBe(6000);
    expect(computeOrdersAllowance(1000, 12)).toBe(12000);
  });

  it('stays unlimited (null) for any duration', () => {
    expect(computeOrdersAllowance(null, 12)).toBeNull();
  });
});

describe('allowanceForExtension', () => {
  it('adds monthly orders exactly for month extensions', () => {
    expect(allowanceForExtension(1000, 2)).toBe(2000);
  });

  it('prorates day extensions with floor', () => {
    expect(allowanceForExtension(1000, undefined, 15)).toBe(500);
    expect(allowanceForExtension(1000, undefined, 1)).toBe(33);
  });

  it('stays unlimited when monthly orders are null', () => {
    expect(allowanceForExtension(null, 3)).toBeNull();
    expect(allowanceForExtension(null, undefined, 10)).toBeNull();
  });
});

describe('addMonthsUtc', () => {
  it('clamps Jan 31 + 1 month to the end of February', () => {
    const next = addMonthsUtc(new Date('2026-01-31T10:00:00.000Z'), 1);
    expect(next.toISOString()).toBe('2026-02-28T10:00:00.000Z');
  });

  it('handles a leap year (Feb 29 target)', () => {
    const next = addMonthsUtc(new Date('2028-01-31T00:00:00.000Z'), 1);
    expect(next.toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('adds 12 months from Dec 31 and keeps the day', () => {
    const next = addMonthsUtc(new Date('2026-12-31T00:00:00.000Z'), 12);
    expect(next.toISOString()).toBe('2027-12-31T00:00:00.000Z');
  });

  it('adds calendar months without drifting into the next month', () => {
    const next = addMonthsUtc(new Date('2026-01-15T08:30:00.000Z'), 6);
    expect(next.toISOString()).toBe('2026-07-15T08:30:00.000Z');
  });
});
