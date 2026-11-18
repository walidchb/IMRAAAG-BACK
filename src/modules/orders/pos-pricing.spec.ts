import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode, AppErrorCodeType } from '../../common/errors/error-codes.enum';
import { resolvePosPricing } from './pos-pricing';

function expectCode(fn: () => unknown, code: AppErrorCodeType): AppException {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppException);
    expect((err as AppException).errorCode).toBe(code);
    return err as AppException;
  }
  throw new Error(`Expected ${code} to be thrown`);
}

describe('resolvePosPricing', () => {
  it('leaves the sale uncustomized when the field is absent', () => {
    expect(resolvePosPricing(6000)).toEqual({
      subtotal: 6000,
      customFinalPrice: null,
      priceAdjustment: 0,
      total: 6000,
    });
    expect(resolvePosPricing(6000, null)).toEqual({
      subtotal: 6000,
      customFinalPrice: null,
      priceAdjustment: 0,
      total: 6000,
    });
  });

  it('stores a valid custom final price and its difference', () => {
    expect(resolvePosPricing(6000, 5080)).toEqual({
      subtotal: 6000,
      customFinalPrice: 5080,
      priceAdjustment: 920,
      total: 5080,
    });
  });

  it('allows a custom price equal to the subtotal (explicit zero adjustment)', () => {
    expect(resolvePosPricing(6000, 6000)).toEqual({
      subtotal: 6000,
      customFinalPrice: 6000,
      priceAdjustment: 0,
      total: 6000,
    });
  });

  it('allows a zero final price (free sale)', () => {
    expect(resolvePosPricing(6000, 0)).toEqual({
      subtotal: 6000,
      customFinalPrice: 0,
      priceAdjustment: 6000,
      total: 0,
    });
  });

  it('rejects a negative value', () => {
    const err = expectCode(() => resolvePosPricing(6000, -1), AppErrorCode.POS_CUSTOM_PRICE_INVALID);
    expect(err.errorParams).toEqual({ customFinalPrice: -1 });
  });

  it('rejects a fractional value instead of truncating it', () => {
    expectCode(() => resolvePosPricing(6000, 5080.5), AppErrorCode.POS_CUSTOM_PRICE_INVALID);
  });

  it('rejects NaN', () => {
    expectCode(() => resolvePosPricing(6000, Number.NaN), AppErrorCode.POS_CUSTOM_PRICE_INVALID);
  });

  it('rejects a value above the server subtotal', () => {
    const err = expectCode(
      () => resolvePosPricing(6000, 6001),
      AppErrorCode.POS_CUSTOM_PRICE_EXCEEDS_SUBTOTAL,
    );
    expect(err.errorParams).toEqual({ customFinalPrice: 6001, subtotal: 6000 });
  });

  it('supports a zero subtotal (zero is the only valid custom price)', () => {
    expect(resolvePosPricing(0, 0)).toEqual({
      subtotal: 0,
      customFinalPrice: 0,
      priceAdjustment: 0,
      total: 0,
    });
  });
});
