import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { BoxQueryDto, VendorBoxQueryDto } from './box-query.dto';

/**
 * Query validation for the Box listings.
 *
 * The global `ValidationPipe` runs `whitelist + forbidNonWhitelisted + transform` without
 * implicit conversion, so numeric query parameters arrive as strings and MUST be coerced by
 * `@Type(() => Number)`. Without it a perfectly valid `?limit=100` fails `@IsInt`, `@Min`
 * and `@Max` at once (the 2026-11-17 storefront/vendorFront 400s).
 */
const buildPublic = (raw: Record<string, unknown>) =>
  validateSync(plainToInstance(BoxQueryDto, raw), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

const buildVendor = (raw: Record<string, unknown>) =>
  validateSync(plainToInstance(VendorBoxQueryDto, raw), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

const STORE_ID = '6aef2981465528603283687c';

describe('BoxQueryDto', () => {
  it('accepts numeric strings from the URL, coercing them to numbers', () => {
    const instance = plainToInstance(BoxQueryDto, { storeId: STORE_ID, limit: '100' });
    expect(buildPublic({ storeId: STORE_ID, limit: '100' })).toHaveLength(0);
    expect(instance.limit).toBe(100);
    expect(typeof instance.limit).toBe('number');
  });

  it('accepts an omitted limit (service applies the default)', () => {
    expect(buildPublic({ storeId: STORE_ID })).toHaveLength(0);
  });

  it('rejects out-of-range or non-numeric limits', () => {
    expect(buildPublic({ storeId: STORE_ID, limit: '0' }).length).toBeGreaterThan(0);
    expect(buildPublic({ storeId: STORE_ID, limit: '101' }).length).toBeGreaterThan(0);
    expect(buildPublic({ storeId: STORE_ID, limit: 'many' }).length).toBeGreaterThan(0);
    expect(buildPublic({ storeId: STORE_ID, limit: '10.5' }).length).toBeGreaterThan(0);
  });

  it('rejects a missing or malformed storeId', () => {
    expect(buildPublic({}).length).toBeGreaterThan(0);
    expect(buildPublic({ storeId: 'not-an-id' }).length).toBeGreaterThan(0);
  });
});

describe('VendorBoxQueryDto', () => {
  it('accepts numeric strings for page and limit', () => {
    const instance = plainToInstance(VendorBoxQueryDto, { page: '1', limit: '20' });
    expect(buildVendor({ page: '1', limit: '20' })).toHaveLength(0);
    expect(instance.page).toBe(1);
    expect(instance.limit).toBe(20);
  });

  it('accepts an omitted page (service applies the default)', () => {
    expect(buildVendor({})).toHaveLength(0);
  });

  it('rejects out-of-range or non-numeric pagination', () => {
    expect(buildVendor({ page: '0' }).length).toBeGreaterThan(0);
    expect(buildVendor({ limit: '0' }).length).toBeGreaterThan(0);
    expect(buildVendor({ limit: '101' }).length).toBeGreaterThan(0);
    expect(buildVendor({ page: 'x' }).length).toBeGreaterThan(0);
  });

  it('rejects an unknown status', () => {
    expect(buildVendor({ status: 'deleted' }).length).toBeGreaterThan(0);
    expect(buildVendor({ status: 'active' })).toHaveLength(0);
  });
});
