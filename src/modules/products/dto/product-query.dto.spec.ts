import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ProductSuggestionQueryDto } from './product-query.dto';

/**
 * Query validation for `GET /products/search` (inventory autocomplete).
 *
 * The global `ValidationPipe` runs `whitelist + forbidNonWhitelisted + transform`, so these
 * checks are the request's security boundary: the endpoint is a keystroke-frequency lookup
 * over one store's catalogue, and an unknown parameter (a smuggled `storeId`, or a
 * `search` meant for the listing endpoint) must be a 400 rather than a silently ignored
 * hint that widens the scan.
 */
const build = (raw: Record<string, unknown>) =>
  validateSync(plainToInstance(ProductSuggestionQueryDto, raw), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe('ProductSuggestionQueryDto', () => {
  it('accepts a query and applies the default limit', () => {
    const instance = plainToInstance(ProductSuggestionQueryDto, { q: 'VB' });
    expect(build({ q: 'VB' })).toHaveLength(0);
    expect(instance.limit).toBe(8);
  });

  it('accepts an explicit in-range limit', () => {
    expect(build({ q: 'VB', limit: 20 })).toHaveLength(0);
  });

  it('accepts a blank q — the service answers it with an empty list, not a 400', () => {
    expect(build({ q: '' })).toHaveLength(0);
  });

  it('rejects a missing q, so an empty request cannot scan the catalogue', () => {
    expect(build({}).length).toBeGreaterThan(0);
  });

  it('rejects an over-long q', () => {
    expect(build({ q: 'x'.repeat(121) }).length).toBeGreaterThan(0);
  });

  it('rejects out-of-range or non-numeric limits', () => {
    expect(build({ q: 'VB', limit: 0 }).length).toBeGreaterThan(0);
    expect(build({ q: 'VB', limit: 1000 }).length).toBeGreaterThan(0);
    expect(build({ q: 'VB', limit: 'many' }).length).toBeGreaterThan(0);
  });

  it('rejects unknown query parameters instead of ignoring them', () => {
    expect(build({ q: 'VB', storeId: 'anything' }).length).toBeGreaterThan(0);
    expect(build({ q: 'VB', vendorEmail: 'a@b.c' }).length).toBeGreaterThan(0);
    expect(build({ q: 'VB', search: 'dress' }).length).toBeGreaterThan(0);
  });
});
