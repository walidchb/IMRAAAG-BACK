import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';

/**
 * Resolved money state of a POS sale. `subtotal` is always the server-priced line sum;
 * `total` is the amount actually charged (`customFinalPrice` when the seller set one,
 * otherwise `subtotal`). `customFinalPrice` is `null` when no customization was requested,
 * which is distinct from a deliberate `0` (free sale).
 */
export interface PosPricing {
  subtotal: number;
  customFinalPrice: number | null;
  priceAdjustment: number;
  total: number;
}

/**
 * Validates the seller-entered final amount against the server-priced subtotal and derives
 * the stored adjustment. Throws before any transaction opens, so an invalid sale can never
 * write an order or move stock.
 *
 * Frozen rules: integer DZD only (no rounding), `0 <= customFinalPrice <= subtotal`.
 * `0` and equality are both valid and are recorded as an explicit customization.
 */
export function resolvePosPricing(
  subtotal: number,
  customFinalPrice?: number | null,
): PosPricing {
  if (customFinalPrice === undefined || customFinalPrice === null) {
    return { subtotal, customFinalPrice: null, priceAdjustment: 0, total: subtotal };
  }
  if (
    !Number.isFinite(customFinalPrice) ||
    !Number.isInteger(customFinalPrice) ||
    customFinalPrice < 0
  ) {
    throw new AppException(AppErrorCode.POS_CUSTOM_PRICE_INVALID, { customFinalPrice });
  }
  if (customFinalPrice > subtotal) {
    throw new AppException(AppErrorCode.POS_CUSTOM_PRICE_EXCEEDS_SUBTOTAL, {
      customFinalPrice,
      subtotal,
    });
  }
  return {
    subtotal,
    customFinalPrice,
    priceAdjustment: subtotal - customFinalPrice,
    total: customFinalPrice,
  };
}
