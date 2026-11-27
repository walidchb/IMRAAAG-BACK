import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';

export { addMonthsUtc } from '../../common/constants/subscription.const';

/**
 * Pure billing math for plan billing options. This is the **only** place the price/allowance
 * formulas live: admin, vendor and storefront all consume values computed by the backend and
 * never re-implement them. All amounts are integer DZD (`Math.round`, half-up).
 *
 *   listPrice   = P × M
 *   calculated  = round(listPrice × (100 - D) / 100)
 *   finalPrice  = O ?? calculated
 *   savings     = listPrice - finalPrice
 */

export const MIN_DURATION_MONTHS = 1;
export const MAX_DURATION_MONTHS = 36;

export interface BillingOptionLike {
  durationMonths: number;
  discountPercent: number;
  priceOverride?: number | null;
}

export interface BillingComputation {
  durationMonths: number;
  listPrice: number;
  calculatedPrice: number;
  finalPrice: number;
  savings: number;
  effectiveDiscountPercent: number;
  priceSource: 'calculated' | 'override';
}

function requireInteger(value: unknown, field: string, min: number, max?: number): number {
  const parsed = Number(value);
  if (
    typeof value === 'boolean' ||
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < min ||
    (max !== undefined && parsed > max)
  ) {
    throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, { field, value });
  }
  return parsed;
}

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeBillingOption(
  monthlyBasePrice: number,
  option: BillingOptionLike,
): BillingComputation {
  const basePrice = requireInteger(monthlyBasePrice, 'price', 0);
  const durationMonths = requireInteger(
    option?.durationMonths,
    'durationMonths',
    MIN_DURATION_MONTHS,
    MAX_DURATION_MONTHS,
  );
  const discountPercent = requireInteger(option?.discountPercent, 'discountPercent', 0, 100);
  const priceOverride =
    option?.priceOverride === null || option?.priceOverride === undefined
      ? null
      : requireInteger(option.priceOverride, 'priceOverride', 0);

  const listPrice = basePrice * durationMonths;
  const calculatedPrice = Math.round((listPrice * (100 - discountPercent)) / 100);
  const finalPrice = priceOverride ?? calculatedPrice;

  if (priceOverride !== null && priceOverride > listPrice) {
    throw new AppException(AppErrorCode.SUBSCRIPTION_BILLING_INVALID_PRICE_OVERRIDE, {
      priceOverride,
      listPrice,
    });
  }

  return {
    durationMonths,
    listPrice,
    calculatedPrice,
    finalPrice,
    savings: listPrice - finalPrice,
    effectiveDiscountPercent:
      listPrice > 0 ? roundTwo((1 - finalPrice / listPrice) * 100) : 0,
    priceSource: priceOverride !== null ? 'override' : 'calculated',
  };
}

/** Total order allowance for a purchased period. `null` monthly orders = unlimited. */
export function computeOrdersAllowance(
  monthlyOrders: number | null,
  durationMonths: number,
): number | null {
  const months = requireInteger(durationMonths, 'durationMonths', MIN_DURATION_MONTHS);
  if (monthlyOrders === null) return null;
  const monthly = requireInteger(monthlyOrders, 'monthlyOrders', 0);
  return monthly * months;
}

/**
 * Allowance delta for an extension. Months are exact (`monthlyOrders × months`); days are
 * prorated (`floor(monthlyOrders × days / 30)`). `null` monthly orders stays unlimited.
 */
export function allowanceForExtension(
  monthlyOrders: number | null,
  months?: number,
  days?: number,
): number | null {
  if (monthlyOrders === null) return null;
  const monthly = requireInteger(monthlyOrders, 'monthlyOrders', 0);
  if (months !== undefined && months !== null) {
    const validMonths = requireInteger(months, 'months', 1);
    return monthly * validMonths;
  }
  if (days !== undefined && days !== null) {
    const validDays = requireInteger(days, 'days', 1);
    return Math.floor((monthly * validDays) / 30);
  }
  throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, { field: 'months' });
}
