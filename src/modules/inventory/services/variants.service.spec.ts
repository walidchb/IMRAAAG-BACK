import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { VariantsService } from './variants.service';
import { ProductOption } from '../schemas/product-option.schema';
import { ProductOptionValue } from '../schemas/product-option-value.schema';
import { ProductVariant } from '../schemas/product-variant.schema';
import { VariantOptionValue } from '../schemas/variant-option-value.schema';
import { InventoryBalance } from '../schemas/inventory-balance.schema';
import { InventoryMovement } from '../schemas/inventory-movement.schema';
import { Product } from '../../products/schemas/product.schema';

/**
 * Buyer-facing availability (inventory audit ME-11a, roadmap 4.1).
 *
 * `getAvailability` is a public endpoint, so its contract is the safety-relevant one: it must
 * agree with `getPublicMatrix` about what a shopper can order, or the storefront will disable
 * rows that are actually sellable (lost sales) or worse, keep orderable rows the matrix hides.
 * These tests pin the shared variant set (active + non-deleted only) and the shared balance
 * math (`max(0, onHand - reserved)`) that keep the two endpoints consistent.
 */

const PRODUCT_ID = new Types.ObjectId();
const STORE_ID = new Types.ObjectId();
const VARIANT_A = new Types.ObjectId();
const VARIANT_B = new Types.ObjectId();
const VARIANT_INACTIVE = new Types.ObjectId();
const VARIANT_DELETED = new Types.ObjectId();

/** A query-chain stub: every mongoose builder method returns itself, `.exec()` resolves. */
const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate', 'session']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

describe('VariantsService.getAvailability', () => {
  let service: VariantsService;

  let productModel: any;
  let variantModel: any;
  let balanceModel: any;
  let unusedModel: any;

  beforeEach(async () => {
    unusedModel = { find: jest.fn() };

    productModel = { findById: jest.fn() };
    variantModel = { find: jest.fn() };
    balanceModel = { find: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VariantsService,
        { provide: getModelToken(ProductOption.name), useValue: unusedModel },
        { provide: getModelToken(ProductOptionValue.name), useValue: unusedModel },
        { provide: getModelToken(ProductVariant.name), useValue: variantModel },
        { provide: getModelToken(VariantOptionValue.name), useValue: unusedModel },
        { provide: getModelToken(InventoryBalance.name), useValue: balanceModel },
        { provide: getModelToken(InventoryMovement.name), useValue: unusedModel },
        { provide: getModelToken(Product.name), useValue: productModel },
      ],
    }).compile();

    service = module.get<VariantsService>(VariantsService);
  });

  const liveProduct = (over: Record<string, unknown> = {}) => ({
    _id: PRODUCT_ID,
    storeId: STORE_ID,
    published: true,
    ...over,
  });

  const variant = (id: Types.ObjectId, over: Record<string, unknown> = {}) => ({
    _id: id,
    productId: PRODUCT_ID,
    storeId: STORE_ID,
    position: 1,
    combinationKey: String(id),
    isActive: true,
    isDeleted: false,
    lowStockThreshold: null,
    ...over,
  });

  it('returns an empty list for an unknown product', async () => {
    productModel.findById.mockReturnValue(query(null));
    await expect(service.getAvailability(PRODUCT_ID.toString())).resolves.toEqual({
      productId: PRODUCT_ID.toString(),
      variants: [],
    });
    expect(variantModel.find).not.toHaveBeenCalled();
  });

  it('returns an empty list for an unpublished product', async () => {
    productModel.findById.mockReturnValue(query(liveProduct({ published: false })));
    await expect(service.getAvailability(PRODUCT_ID.toString())).resolves.toEqual({
      productId: PRODUCT_ID.toString(),
      variants: [],
    });
  });

  it('reports available = max(0, onHand - reserved) for active variants', async () => {
    productModel.findById.mockReturnValue(query(liveProduct()));
    variantModel.find.mockReturnValue(
      query([
        variant(VARIANT_A, { onHandNotUsed: true }),
        variant(VARIANT_B),
        variant(VARIANT_INACTIVE, { isActive: false }),
        variant(VARIANT_DELETED, { isDeleted: true }),
      ]),
    );
    balanceModel.find.mockReturnValue(
      query([
        { variantId: VARIANT_A, onHand: 10, reserved: 2 },
        { variantId: VARIANT_B, onHand: 5, reserved: 9 },
      ]),
    );

    await expect(service.getAvailability(PRODUCT_ID.toString())).resolves.toEqual({
      productId: PRODUCT_ID.toString(),
      variants: [
        { variantId: VARIANT_A.toString(), available: 8 },
        { variantId: VARIANT_B.toString(), available: 0 },
      ],
    });

    // The filtered variant set drives the balance query: the deactivated and deleted variants
    // are excluded, so their balances are never fetched and they never appear in the answer.
    const queriedVariantIds = balanceModel.find.mock.calls[0][0].variantId.$in;
    expect(queriedVariantIds).toHaveLength(2);
    expect(queriedVariantIds.map((id: Types.ObjectId) => id.toString())).toEqual([
      VARIANT_A.toString(),
      VARIANT_B.toString(),
    ]);
  });

  it('treats an active variant with no balance row as sold out (available 0)', async () => {
    productModel.findById.mockReturnValue(query(liveProduct()));
    variantModel.find.mockReturnValue(query([variant(VARIANT_A)]));
    balanceModel.find.mockReturnValue(query([]));

    await expect(service.getAvailability(PRODUCT_ID.toString())).resolves.toEqual({
      productId: PRODUCT_ID.toString(),
      variants: [{ variantId: VARIANT_A.toString(), available: 0 }],
    });
  });
});

/**
 * The buyer-facing matrix must stay a narrower shape than the vendor matrix: the whole point of
 * `getPublicMatrix` (as opposed to `getMatrix` behind the vendor guard) is that a shopper can
 * never read a seller's barcodes, SKUs or stock internals. Barcode/SKU rollout makes this a
 * live risk, so the exclusion is pinned here.
 */
describe('VariantsService.getPublicMatrix — buy-side shape', () => {
  let service: VariantsService;

  let productModel: any;
  let optionModel: any;
  let valueModel: any;
  let variantModel: any;
  let joinModel: any;
  let balanceModel: any;

  const OPTION_ID = new Types.ObjectId();
  const VALUE_ID = new Types.ObjectId();

  beforeEach(async () => {
    productModel = { findById: jest.fn() };
    optionModel = { find: jest.fn() };
    valueModel = { find: jest.fn() };
    variantModel = { find: jest.fn() };
    joinModel = { find: jest.fn() };
    balanceModel = { find: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VariantsService,
        { provide: getModelToken(ProductOption.name), useValue: optionModel },
        { provide: getModelToken(ProductOptionValue.name), useValue: valueModel },
        { provide: getModelToken(ProductVariant.name), useValue: variantModel },
        { provide: getModelToken(VariantOptionValue.name), useValue: joinModel },
        { provide: getModelToken(InventoryBalance.name), useValue: balanceModel },
        { provide: getModelToken(InventoryMovement.name), useValue: { find: jest.fn() } },
        { provide: getModelToken(Product.name), useValue: productModel },
      ],
    }).compile();

    service = module.get<VariantsService>(VariantsService);
  });

  it('never exposes sku, barcode, onHand or reserved to the storefront', async () => {
    productModel.findById.mockReturnValue(
      query({ _id: PRODUCT_ID, storeId: STORE_ID, price: 1000, published: true }),
    );
    optionModel.find.mockReturnValue(
      query([
        { _id: OPTION_ID, key: 'color', nameEn: 'Color', nameFr: 'Couleur', nameAr: 'Couleur', position: 1 },
      ]),
    );
    valueModel.find.mockReturnValue(
      query([{ _id: VALUE_ID, optionId: OPTION_ID, value: 'red', valueEn: 'Red', position: 1, isActive: true }]),
    );
    variantModel.find.mockReturnValue(
      query([
        {
          _id: VARIANT_A,
          productId: PRODUCT_ID,
          storeId: STORE_ID,
          combinationKey: 'k',
          position: 1,
          isActive: true,
          isDeleted: false,
          sku: 'IMR-SECRET',
          barcode: '2000000000053',
          priceOverride: null,
          compareAtPrice: null,
        },
      ]),
    );
    joinModel.find.mockReturnValue(query([{ variantId: VARIANT_A, optionValueId: VALUE_ID }]));
    balanceModel.find.mockReturnValue(query([{ variantId: VARIANT_A, onHand: 7, reserved: 2 }]));

    const matrix = await service.getPublicMatrix(PRODUCT_ID.toString());

    expect(matrix.hasVariants).toBe(true);
    expect(matrix.variants).toHaveLength(1);

    const row: any = matrix.variants[0];
    expect(row.available).toBe(5);
    // The chargeable price is resolved in the projection: a null override inherits the product
    // price. The raw override is exposed so the picker can show a variant-specific price.
    expect(row.priceOverride).toBeNull();
    expect(row.effectivePrice).toBe(1000);
    expect(row.compareAtPrice).toBeNull();
    expect(row).not.toHaveProperty('sku');
    expect(row).not.toHaveProperty('barcode');
    expect(row).not.toHaveProperty('onHand');
    expect(row).not.toHaveProperty('reserved');
  });

  it('resolves effectivePrice from the variant override when one is set', async () => {
    productModel.findById.mockReturnValue(
      query({ _id: PRODUCT_ID, storeId: STORE_ID, price: 1000, published: true }),
    );
    optionModel.find.mockReturnValue(query([]));
    valueModel.find.mockReturnValue(query([]));
    variantModel.find.mockReturnValue(
      query([
        {
          _id: VARIANT_A,
          productId: PRODUCT_ID,
          storeId: STORE_ID,
          combinationKey: 'k',
          isActive: true,
          isDeleted: false,
          priceOverride: 700,
          compareAtPrice: 900,
        },
      ]),
    );
    joinModel.find.mockReturnValue(query([]));
    balanceModel.find.mockReturnValue(query([]));

    const matrix = await service.getPublicMatrix(PRODUCT_ID.toString());
    const row: any = matrix.variants[0];

    // override (700) wins over the product price (1000); compare-at is surfaced separately.
    expect(row.priceOverride).toBe(700);
    expect(row.effectivePrice).toBe(700);
    expect(row.compareAtPrice).toBe(900);
  });
});

/**
 * The listing rollup feeds every list screen's price range. `overrideMin/Max` cover only variants
 * that carry an override, so a caller combines them with the product's own base price. Zero is a
 * real override (a free variant), not an absent one — a `truthy` filter would silently report "no
 * override" and mis-price the range.
 */
describe('VariantsService.getProductSummaries — price override rollup', () => {
  let service: VariantsService;
  let variantModel: any;

  beforeEach(async () => {
    variantModel = { aggregate: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VariantsService,
        { provide: getModelToken(ProductOption.name), useValue: {} },
        { provide: getModelToken(ProductOptionValue.name), useValue: {} },
        { provide: getModelToken(ProductVariant.name), useValue: variantModel },
        { provide: getModelToken(VariantOptionValue.name), useValue: {} },
        {
          provide: getModelToken(InventoryBalance.name),
          // `getProductSummaries` reads the balance collection name for its `$lookup` (`from`).
          useValue: { collection: { name: 'inventorybalances' } },
        },
        { provide: getModelToken(InventoryMovement.name), useValue: {} },
        { provide: getModelToken(Product.name), useValue: {} },
      ],
    }).compile();

    service = module.get<VariantsService>(VariantsService);
  });

  const summaryRow = (over: Record<string, unknown> = {}) => ({
    _id: PRODUCT_ID,
    variantCount: 3,
    activeVariantCount: 3,
    availableTotal: 9,
    overrideValues: [],
    skuValues: [],
    ...over,
  });

  it('reports hasPriceOverride + min/max from the numeric overrides', async () => {
    variantModel.aggregate.mockReturnValue(query([summaryRow({ overrideValues: [1200, 900, 1500] })]));

    const summary = (await service.getProductSummaries([PRODUCT_ID.toString()])).get(PRODUCT_ID.toString())!;

    expect(summary.hasPriceOverride).toBe(true);
    expect(summary.overrideMin).toBe(900);
    expect(summary.overrideMax).toBe(1500);
  });

  it('treats a zero override as a real override', async () => {
    variantModel.aggregate.mockReturnValue(query([summaryRow({ overrideValues: [0] })]));

    const summary = (await service.getProductSummaries([PRODUCT_ID.toString()])).get(PRODUCT_ID.toString())!;

    expect(summary.hasPriceOverride).toBe(true);
    expect(summary.overrideMin).toBe(0);
    expect(summary.overrideMax).toBe(0);
  });

  it('reports no override when no variant carries one', async () => {
    variantModel.aggregate.mockReturnValue(query([summaryRow({ overrideValues: [] })]));

    const summary = (await service.getProductSummaries([PRODUCT_ID.toString()])).get(PRODUCT_ID.toString())!;

    expect(summary.hasPriceOverride).toBe(false);
    expect(summary.overrideMin).toBeNull();
    expect(summary.overrideMax).toBeNull();
  });

  it('maps per-variant price/compare-at pairs, coercing non-numbers to null', async () => {
    variantModel.aggregate.mockReturnValue(
      query([
        summaryRow({
          variantPrices: [
            { priceOverride: 900, compareAtPrice: 1200 },
            { priceOverride: null, compareAtPrice: 'nope' },
            { priceOverride: 'bad' },
          ],
        }),
      ]),
    );

    const summary = (await service.getProductSummaries([PRODUCT_ID.toString()])).get(PRODUCT_ID.toString())!;

    expect(summary.variantPrices).toEqual([
      { priceOverride: 900, compareAtPrice: 1200 },
      { priceOverride: null, compareAtPrice: null },
      { priceOverride: null, compareAtPrice: null },
    ]);
  });

  it('returns an empty map for an empty or malformed id list without querying', async () => {
    await expect(service.getProductSummaries([])).resolves.toEqual(new Map());
    await expect(service.getProductSummaries(['not-an-id'])).resolves.toEqual(new Map());
    expect(variantModel.aggregate).not.toHaveBeenCalled();
  });
});