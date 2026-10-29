import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListInventoryQueryDto } from './dto/inventory-list.dto';

/**
 * Query validation for `GET /inventory` (spec §3, §6).
 *
 * The global `ValidationPipe` runs `whitelist + forbidNonWhitelisted + transform`, so these
 * checks are the request's security boundary: an unknown parameter is a 400 rather than a
 * silently ignored hint, and page/limit arrive already clamped to the range the service
 * additionally enforces.
 */
const build = (raw: Record<string, unknown>) =>
  validateSync(plainToInstance(ListInventoryQueryDto, raw), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe('ListInventoryQueryDto', () => {
  it('accepts a fully populated query', () => {
    const errors = build({
      search: 'shirt',
      productId: '653f5f8f8f8f8f8f8f8f8f8f',
      status: 'out',
      page: 2,
      limit: 25,
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts an empty query (all defaults applied downstream)', () => {
    expect(build({})).toHaveLength(0);
  });

  it('accepts every documented status', () => {
    for (const status of ['all', 'active', 'inactive', 'low', 'out', 'in_stock']) {
      expect(build({ status })).toHaveLength(0);
    }
  });

  it('rejects an unknown status', () => {
    expect(build({ status: 'shredded' }).length).toBeGreaterThan(0);
  });

  it('rejects the removed sort and order parameters', () => {
    expect(build({ sort: 'onHand' }).length).toBeGreaterThan(0);
    expect(build({ order: 'desc' }).length).toBeGreaterThan(0);
    expect(build({ sortBy: 'stock' }).length).toBeGreaterThan(0);
    expect(build({ sortOrder: 'asc' }).length).toBeGreaterThan(0);
  });

  it('rejects out-of-range pagination', () => {
    expect(build({ page: 0 }).length).toBeGreaterThan(0);
    expect(build({ page: -1 }).length).toBeGreaterThan(0);
    expect(build({ limit: 0 }).length).toBeGreaterThan(0);
    expect(build({ limit: 1000 }).length).toBeGreaterThan(0);
    expect(build({ page: 'second' }).length).toBeGreaterThan(0);
  });

  it('rejects an over-long search and a malformed productId', () => {
    expect(build({ search: 'x'.repeat(121) }).length).toBeGreaterThan(0);
    expect(build({ productId: 'not-an-id' }).length).toBeGreaterThan(0);
  });

  it('rejects unknown query parameters instead of ignoring them', () => {
    expect(build({ storeId: 'anything' }).length).toBeGreaterThan(0);
    expect(build({ vendorEmail: 'a@b.c' }).length).toBeGreaterThan(0);
    expect(build({ $where: 'true' }).length).toBeGreaterThan(0);
  });
});
