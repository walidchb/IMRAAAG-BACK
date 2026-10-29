import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SetOnHandDto, AdjustDeltaDto, BulkAdjustDto, BulkAdjustItemDto, ListMovementsQueryDto } from './dto/inventory.dto';
import { ReceiveReturnDto, ReceiveReturnLineDto } from './dto/reservations.dto';
import { UpdateVariantDto, SelectedCombinationDto } from './dto/variants.dto';

/**
 * Request-shape coverage for the write endpoints (roadmap Phase 7, "invalid requests").
 *
 * The global `ValidationPipe` (`src/common/pipes/validation.pipe.ts`) runs
 * `whitelist + forbidNonWhitelisted + transform`, so these checks are the boundary a bad
 * request dies at — before a controller, a session or the database is ever touched:
 *
 *  - a float quantity is a 400 here (and a second line of defence as INVALID_QUANTITY in
 *    the services), never a `$inc` that silently truncates;
 *  - a reason-less manual adjustment is a 400 here and ADJUSTMENT_REASON_REQUIRED in the
 *    service, so no stock can move without an auditable reason;
 *  - unknown fields are rejected rather than ignored, matching the query DTO's rule.
 */
const build = <T extends object>(raw: Record<string, unknown>, dto: new () => T): unknown[] =>
  validateSync(plainToInstance(dto, raw), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

const validLine = { orderItemIndex: 0, disposition: 'restock' };

describe('SetOnHandDto', () => {
  it('accepts a fully populated body', () => {
    expect(
      build({ quantity: 25, reason: 'Initial stock count', note: 'shelf A', idempotencyKey: 'k-1' }, SetOnHandDto),
    ).toHaveLength(0);
  });

  it('accepts the minimal body (quantity + reason)', () => {
    expect(build({ quantity: 0, reason: 'count correction' }, SetOnHandDto)).toHaveLength(0);
  });

  it('rejects a float quantity', () => {
    expect(build({ quantity: 2.5, reason: 'x' }, SetOnHandDto).length).toBeGreaterThan(0);
    expect(build({ quantity: '2.5', reason: 'x' }, SetOnHandDto).length).toBeGreaterThan(0);
  });

  it('rejects a negative quantity', () => {
    expect(build({ quantity: -1, reason: 'x' }, SetOnHandDto).length).toBeGreaterThan(0);
  });

  it('rejects a missing or empty reason', () => {
    expect(build({ quantity: 5 }, SetOnHandDto).length).toBeGreaterThan(0);
    expect(build({ quantity: 5, reason: '' }, SetOnHandDto).length).toBeGreaterThan(0);
  });

  it('rejects unknown fields instead of ignoring them', () => {
    expect(build({ quantity: 5, reason: 'x', storeId: 'someone-elses' }, SetOnHandDto).length).toBeGreaterThan(0);
  });
});

describe('AdjustDeltaDto', () => {
  it('accepts a signed delta with a reason', () => {
    expect(build({ delta: -3, reason: 'Damaged in transit' }, AdjustDeltaDto)).toHaveLength(0);
    expect(build({ delta: 7, reason: 'restock', note: 'box 2', idempotencyKey: 'k' }, AdjustDeltaDto)).toHaveLength(0);
  });

  it('rejects a float delta', () => {
    expect(build({ delta: 1.5, reason: 'x' }, AdjustDeltaDto).length).toBeGreaterThan(0);
    expect(build({ delta: '0.1', reason: 'x' }, AdjustDeltaDto).length).toBeGreaterThan(0);
  });

  it('rejects a missing or empty reason (no anonymous stock movement)', () => {
    expect(build({ delta: 2 }, AdjustDeltaDto).length).toBeGreaterThan(0);
    expect(build({ delta: 2, reason: '' }, AdjustDeltaDto).length).toBeGreaterThan(0);
  });

  it('rejects unknown fields', () => {
    expect(build({ delta: 2, reason: 'x', onHand: 0 }, AdjustDeltaDto).length).toBeGreaterThan(0);
  });
});

describe('BulkAdjustDto', () => {
  it('accepts a valid batch mixing set and delta items', () => {
    expect(
      build(
        {
          items: [
            { variantId: '653f5f8f8f8f8f8f8f8f8f8f', quantity: 10 },
            { variantId: '653f5f8f8f8f8f8f8f8f8f90', delta: -2 },
          ],
          reason: 'weekly count',
        },
        BulkAdjustDto,
      ),
    ).toHaveLength(0);
  });

  it('rejects a missing reason for the whole batch', () => {
    expect(build({ items: [], }, BulkAdjustDto).length).toBeGreaterThan(0);
    expect(build({ items: [{ variantId: 'x', delta: 1 }], reason: '' }, BulkAdjustDto).length).toBeGreaterThan(0);
  });

  it('rejects non-array items', () => {
    expect(build({ items: 'nope', reason: 'x' }, BulkAdjustDto).length).toBeGreaterThan(0);
  });

  it('rejects an item with a float quantity or float delta', () => {
    expect(
      build({ items: [{ variantId: '653f5f8f8f8f8f8f8f8f8f8f', quantity: 1.5 }], reason: 'x' }, BulkAdjustDto).length,
    ).toBeGreaterThan(0);
    expect(
      build({ items: [{ variantId: '653f5f8f8f8f8f8f8f8f8f8f', delta: -0.5 }], reason: 'x' }, BulkAdjustDto).length,
    ).toBeGreaterThan(0);
  });

  it('rejects an item with a negative absolute quantity', () => {
    expect(
      build({ items: [{ variantId: '653f5f8f8f8f8f8f8f8f8f8f', quantity: -5 }], reason: 'x' }, BulkAdjustDto).length,
    ).toBeGreaterThan(0);
  });

  it('rejects an item with no variantId', () => {
    expect(build({ items: [{ delta: 1 }], reason: 'x' }, BulkAdjustDto).length).toBeGreaterThan(0);
  });
});

describe('ReceiveReturnDto (return receipt lines)', () => {
  it('accepts a full-quantity restock line', () => {
    expect(build({ items: [{ ...validLine, quantity: 3 }] }, ReceiveReturnDto)).toHaveLength(0);
  });

  it('accepts an omitted quantity (defaults to the dispatched amount)', () => {
    expect(build({ items: [validLine] }, ReceiveReturnDto)).toHaveLength(0);
  });

  it('accepts write_off and the optional note/markReturned fields', () => {
    expect(
      build(
        { items: [{ ...validLine, disposition: 'write_off' }], note: 'crushed in transit', markOrderReturned: true },
        ReceiveReturnDto,
      ),
    ).toHaveLength(0);
  });

  it('rejects a float or sub-unit quantity', () => {
    expect(build({ items: [{ ...validLine, quantity: 1.5 }] }, ReceiveReturnDto).length).toBeGreaterThan(0);
    expect(build({ items: [{ ...validLine, quantity: 0 }] }, ReceiveReturnDto).length).toBeGreaterThan(0);
    expect(build({ items: [{ ...validLine, quantity: -2 }] }, ReceiveReturnDto).length).toBeGreaterThan(0);
  });

  it('rejects a negative line index', () => {
    expect(build({ items: [{ ...validLine, orderItemIndex: -1 }] }, ReceiveReturnDto).length).toBeGreaterThan(0);
  });

  it('rejects an unknown disposition', () => {
    expect(build({ items: [{ ...validLine, disposition: 'destroy' }] }, ReceiveReturnDto).length).toBeGreaterThan(0);
  });

  it('rejects a line with no disposition', () => {
    expect(build({ items: [{ orderItemIndex: 0 }] }, ReceiveReturnDto).length).toBeGreaterThan(0);
  });

  it('rejects a missing items array', () => {
    expect(build({}, ReceiveReturnDto).length).toBeGreaterThan(0);
    expect(build({ items: 'nope' }, ReceiveReturnDto).length).toBeGreaterThan(0);
  });

  it('rejects an over-long note', () => {
    expect(build({ items: [validLine], note: 'x'.repeat(501) }, ReceiveReturnDto).length).toBeGreaterThan(0);
  });
});

describe('ListMovementsQueryDto', () => {
  it('accepts a valid cursor page', () => {
    expect(build({ limit: 50, cursor: '653f5f8f8f8f8f8f8f8f8f8f' }, ListMovementsQueryDto)).toHaveLength(0);
  });

  it('rejects a non-integer or sub-1 limit', () => {
    expect(build({ limit: 1.5 }, ListMovementsQueryDto).length).toBeGreaterThan(0);
    expect(build({ limit: 0 }, ListMovementsQueryDto).length).toBeGreaterThan(0);
    expect(build({ limit: -10 }, ListMovementsQueryDto).length).toBeGreaterThan(0);
  });

  it('rejects unknown parameters', () => {
    expect(build({ storeId: '653f5f8f8f8f8f8f8f8f8f8f' }, ListMovementsQueryDto).length).toBeGreaterThan(0);
  });
});

/**
 * Per-variant price boundary (variant-pricing roadmap Phase 1).
 *
 * A price is money, so the DTO is the first line of defence: integer DZD only (`@IsInt()`), never
 * negative, and an explicit `null` is allowed because it is the *clear the override* signal — not a
 * missing value. A float or a string must die here, before the service or a `$set` is ever built.
 */
describe('UpdateVariantDto — price fields', () => {
  it('accepts an omitted price, a set override, an explicit zero and a null clear', () => {
    expect(build({ sku: 'X-1' }, UpdateVariantDto)).toHaveLength(0);
    expect(build({ priceOverride: 1500 }, UpdateVariantDto)).toHaveLength(0);
    expect(build({ priceOverride: 0 }, UpdateVariantDto)).toHaveLength(0);
    expect(build({ priceOverride: null }, UpdateVariantDto)).toHaveLength(0);
    expect(build({ compareAtPrice: 1990 }, UpdateVariantDto)).toHaveLength(0);
    expect(build({ compareAtPrice: null }, UpdateVariantDto)).toHaveLength(0);
  });

  it('rejects a negative, non-integer or non-numeric price override', () => {
    expect(build({ priceOverride: -1 }, UpdateVariantDto).length).toBeGreaterThan(0);
    expect(build({ priceOverride: 12.5 }, UpdateVariantDto).length).toBeGreaterThan(0);
    expect(build({ priceOverride: '1500' }, UpdateVariantDto).length).toBeGreaterThan(0);
    expect(build({ priceOverride: 'abc' }, UpdateVariantDto).length).toBeGreaterThan(0);
    expect(build({ priceOverride: '12abc' }, UpdateVariantDto).length).toBeGreaterThan(0);
    expect(build({ priceOverride: '' }, UpdateVariantDto).length).toBeGreaterThan(0);
    expect(build({ priceOverride: true }, UpdateVariantDto).length).toBeGreaterThan(0);
  });

  it('rejects a negative, non-integer or non-numeric compare-at price', () => {
    expect(build({ compareAtPrice: -1 }, UpdateVariantDto).length).toBeGreaterThan(0);
    expect(build({ compareAtPrice: 19.9 }, UpdateVariantDto).length).toBeGreaterThan(0);
    expect(build({ compareAtPrice: 'abc' }, UpdateVariantDto).length).toBeGreaterThan(0);
  });

  it('rejects a smuggled store id instead of ignoring it', () => {
    expect(build({ priceOverride: 1500, storeId: 'someone-elses' }, UpdateVariantDto).length).toBeGreaterThan(0);
  });
});

describe('SelectedCombinationDto — per-variant price at creation', () => {
  const selection = (over: Record<string, unknown> = {}) => ({
    combinationKey: 'k',
    optionValueIds: ['653f5f8f8f8f8f8f8f8f8f8f'],
    ...over,
  });

  it('accepts an optional integer price override and compare-at price', () => {
    expect(build(selection(), SelectedCombinationDto)).toHaveLength(0);
    expect(build(selection({ priceOverride: 1500 }), SelectedCombinationDto)).toHaveLength(0);
    expect(build(selection({ priceOverride: 0 }), SelectedCombinationDto)).toHaveLength(0);
    expect(build(selection({ compareAtPrice: 1990 }), SelectedCombinationDto)).toHaveLength(0);
  });

  it('rejects a negative or non-integer price at creation', () => {
    expect(build(selection({ priceOverride: -1 }), SelectedCombinationDto).length).toBeGreaterThan(0);
    expect(build(selection({ priceOverride: 12.5 }), SelectedCombinationDto).length).toBeGreaterThan(0);
  });
});
