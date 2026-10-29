import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { PosService } from './pos.service';
import { ProductVariant } from '../inventory/schemas/product-variant.schema';
import { InventoryBalance } from '../inventory/schemas/inventory-balance.schema';
import { ProductOption } from '../inventory/schemas/product-option.schema';
import { ProductOptionValue } from '../inventory/schemas/product-option-value.schema';
import { VariantOptionValue } from '../inventory/schemas/variant-option-value.schema';
import { Product } from '../products/schemas/product.schema';
import { Order } from '../orders/schemas/order.schema';

/**
 * POS catalog (roadmap Phase 1).
 *
 * Two contracts are safety-relevant and pinned here: the store filter is always the session's
 * store (isolation), and `available` is `max(0, onHand - reserved)` — the same expression the
 * storefront uses, clamped so a data anomaly can never produce a negative quantity at the till.
 */

const STORE_ID = new Types.ObjectId();
const OTHER_STORE_ID = new Types.ObjectId();
const PRODUCT_ID = new Types.ObjectId();
const PRODUCT_B = new Types.ObjectId();
const VARIANT_A = new Types.ObjectId();
const VARIANT_B = new Types.ObjectId();

/** Query-chain stub: every mongoose builder returns itself, `.exec()` resolves the value. */
const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate', 'session']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

describe('PosService', () => {
  let service: PosService;

  let variantModel: any;
  let balanceModel: any;
  let optionModel: any;
  let valueModel: any;
  let joinModel: any;
  let productModel: any;
  let orderModel: any;

  beforeEach(async () => {
    variantModel = { find: jest.fn(), findOne: jest.fn(), aggregate: jest.fn() };
    balanceModel = { find: jest.fn().mockReturnValue(query([])) };
    optionModel = { find: jest.fn().mockReturnValue(query([])) };
    valueModel = { find: jest.fn().mockReturnValue(query([])) };
    joinModel = { find: jest.fn().mockReturnValue(query([])) };
    productModel = { find: jest.fn(), collection: { name: 'products' } };
    orderModel = { aggregate: jest.fn().mockReturnValue(query([])) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PosService,
        { provide: getModelToken(ProductVariant.name), useValue: variantModel },
        { provide: getModelToken(InventoryBalance.name), useValue: balanceModel },
        { provide: getModelToken(ProductOption.name), useValue: optionModel },
        { provide: getModelToken(ProductOptionValue.name), useValue: valueModel },
        { provide: getModelToken(VariantOptionValue.name), useValue: joinModel },
        { provide: getModelToken(Product.name), useValue: productModel },
        { provide: getModelToken(Order.name), useValue: orderModel },
      ],
    }).compile();

    service = module.get<PosService>(PosService);
  });

  const product = (id: Types.ObjectId, over: Record<string, unknown> = {}) => ({
    _id: id,
    storeId: STORE_ID,
    nameEn: 'Shirt',
    nameAr: 'قميص',
    nameFr: 'Chemise',
    slug: `shirt-${id}`,
    image: 'img.png',
    price: 1000,
    ...over,
  });

  const variant = (id: Types.ObjectId, over: Record<string, unknown> = {}) => ({
    _id: id,
    productId: PRODUCT_ID,
    storeId: STORE_ID,
    position: 1,
    isActive: true,
    isDeleted: false,
    sku: null,
    barcode: null,
    priceOverride: null,
    ...over,
  });

  const aggregateReturns = (ids: Types.ObjectId[]) =>
    variantModel.aggregate.mockReturnValue(query(ids.map((id) => ({ _id: id }))));

  // ---------------------------------------------------------------- search

  it('scopes the catalog aggregation to the session store (isolation)', async () => {
    aggregateReturns([PRODUCT_ID]);
    productModel.find.mockReturnValue(query([product(PRODUCT_ID)]));
    variantModel.find.mockReturnValue(query([variant(VARIANT_A)]));

    await service.searchProducts(STORE_ID, {});

    const pipeline = variantModel.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match.storeId).toBe(STORE_ID);
    expect(pipeline[0].$match.storeId).not.toBe(OTHER_STORE_ID);
  });

  it('clamps available to max(0, onHand - reserved)', async () => {
    aggregateReturns([PRODUCT_ID]);
    productModel.find.mockReturnValue(query([product(PRODUCT_ID)]));
    variantModel.find.mockReturnValue(query([variant(VARIANT_A)]));
    balanceModel.find.mockReturnValue(
      query([{ variantId: VARIANT_A, onHand: 2, reserved: 5 }]),
    );

    const { data } = await service.searchProducts(STORE_ID, {});

    expect(data[0].variants[0].available).toBe(0);
  });

  it('reports available = onHand - reserved for a healthy variant', async () => {
    aggregateReturns([PRODUCT_ID]);
    productModel.find.mockReturnValue(query([product(PRODUCT_ID)]));
    variantModel.find.mockReturnValue(query([variant(VARIANT_A)]));
    balanceModel.find.mockReturnValue(
      query([{ variantId: VARIANT_A, onHand: 8, reserved: 3 }]),
    );

    const { data } = await service.searchProducts(STORE_ID, {});

    expect(data[0].variants[0].available).toBe(5);
  });

  it('returns the product option groups and each variant optionValueIds (register composition)', async () => {
    const optionId = new Types.ObjectId();
    const valueA = new Types.ObjectId();
    const valueB = new Types.ObjectId();

    aggregateReturns([PRODUCT_ID]);
    productModel.find.mockReturnValue(query([product(PRODUCT_ID)]));
    variantModel.find.mockReturnValue(query([variant(VARIANT_A), variant(VARIANT_B)]));
    joinModel.find.mockReturnValue(
      query([
        { variantId: VARIANT_A, optionValueId: valueA },
        { variantId: VARIANT_B, optionValueId: valueB },
      ]),
    );
    optionModel.find.mockReturnValue(
      query([
        {
          _id: optionId,
          productId: PRODUCT_ID,
          storeId: STORE_ID,
          key: 'size',
          nameEn: 'Size',
          nameFr: 'Taille',
          type: 'text',
          position: 0,
        },
      ]),
    );
    valueModel.find.mockReturnValue(
      query([
        { _id: valueA, optionId, productId: PRODUCT_ID, storeId: STORE_ID, value: 's', valueEn: 'Small', position: 0 },
        { _id: valueB, optionId, productId: PRODUCT_ID, storeId: STORE_ID, value: 'm', valueEn: 'Medium', position: 1 },
      ]),
    );

    const { data } = await service.searchProducts(STORE_ID, {});

    expect(data[0].options).toHaveLength(1);
    expect(data[0].options[0]).toMatchObject({
      optionId: String(optionId),
      key: 'size',
      name: { en: 'Size', fr: 'Taille' },
      type: 'text',
    });
    expect(data[0].options[0].values.map((v) => v.valueId)).toEqual([String(valueA), String(valueB)]);
    expect(
      data[0].variants.find((v) => v.variantId === String(VARIANT_A))?.optionValueIds,
    ).toEqual([String(valueA)]);
  });

  it('returns all active variants of a matched product, not only the matching one', async () => {
    aggregateReturns([PRODUCT_ID]);
    productModel.find.mockReturnValue(query([product(PRODUCT_ID)]));
    variantModel.find.mockReturnValue(
      query([variant(VARIANT_A, { sku: 'A' }), variant(VARIANT_B, { sku: 'B' })]),
    );

    const { data } = await service.searchProducts(STORE_ID, { q: 'A' });

    expect(data[0].variants).toHaveLength(2);
  });

  it('escapes a regex term before it reaches Mongo (LO-4)', async () => {
    aggregateReturns([]);

    await service.searchProducts(STORE_ID, { q: 'C++ (test)[1]' });

    const pipeline = variantModel.aggregate.mock.calls[0][0];
    const searchStage = pipeline.find((s: any) => s.$match?.$or);
    const skuRegex = searchStage.$match.$or[0].sku;
    expect(skuRegex.source).toBe('C\\+\\+ \\(test\\)\\[1\\]');
    expect(skuRegex.flags).toBe('i');
  });

  it('pages by productId and returns the next cursor when there is a further page', async () => {
    aggregateReturns([PRODUCT_ID, PRODUCT_B, new Types.ObjectId()]);
    productModel.find.mockReturnValue(
      query([product(PRODUCT_ID), product(PRODUCT_B)]),
    );
    variantModel.find.mockReturnValue(query([]));

    const page = await service.searchProducts(STORE_ID, { limit: 2 });

    expect(page.data).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(String(PRODUCT_B));
  });

  it('sets no cursor when the page is the last one', async () => {
    aggregateReturns([PRODUCT_ID]);
    productModel.find.mockReturnValue(query([product(PRODUCT_ID)]));
    variantModel.find.mockReturnValue(query([]));

    const page = await service.searchProducts(STORE_ID, { limit: 2 });

    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('drops products that are not active (draft) from the page', async () => {
    aggregateReturns([PRODUCT_ID]);
    productModel.find.mockReturnValue(query([]));

    const { data } = await service.searchProducts(STORE_ID, {});

    expect(data).toEqual([]);
  });

  it('carries a variant price override over the product price', async () => {
    aggregateReturns([PRODUCT_ID]);
    productModel.find.mockReturnValue(query([product(PRODUCT_ID)]));
    variantModel.find.mockReturnValue(query([variant(VARIANT_A, { priceOverride: 777 })]));

    const { data } = await service.searchProducts(STORE_ID, {});

    expect(data[0].variants[0].price).toBe(777);
  });

  // --------------------------------------------------------------- barcode

  it('resolves a barcode to the variant’s whole product', async () => {
    variantModel.findOne.mockReturnValue(query(variant(VARIANT_A, { barcode: '123' })));
    productModel.find.mockReturnValue(query([product(PRODUCT_ID)]));
    variantModel.find.mockReturnValue(
      query([variant(VARIANT_A, { barcode: '123' }), variant(VARIANT_B)]),
    );

    const hit = await service.findByBarcode(STORE_ID, '123');

    expect(hit.productId).toBe(String(PRODUCT_ID));
    expect(hit.matchedVariantId).toBe(String(VARIANT_A));
    expect(hit.variants).toHaveLength(2);
  });

  it('scopes the barcode lookup to the session store (isolation)', async () => {
    variantModel.findOne.mockReturnValue(query(null));

    await expect(service.findByBarcode(STORE_ID, '123')).rejects.toMatchObject({
      errorCode: 'POS_BARCODE_NOT_FOUND',
    });
    expect(variantModel.findOne.mock.calls[0][0].storeId).toBe(STORE_ID);
  });

  it('rejects an unknown barcode', async () => {
    variantModel.findOne.mockReturnValue(query(null));

    await expect(service.findByBarcode(STORE_ID, 'nope')).rejects.toMatchObject({
      errorCode: 'POS_BARCODE_NOT_FOUND',
    });
  });

  it('rejects a barcode whose product is a draft (not sellable)', async () => {
    variantModel.findOne.mockReturnValue(query(variant(VARIANT_A, { barcode: '123' })));
    productModel.find.mockReturnValue(query([]));

    await expect(service.findByBarcode(STORE_ID, '123')).rejects.toMatchObject({
      errorCode: 'POS_BARCODE_NOT_FOUND',
    });
  });

  // ------------------------------------------------------------- customers

  it('scopes the customer search to the session store (isolation)', async () => {
    orderModel.aggregate.mockReturnValue(query([]));

    await service.searchCustomers(STORE_ID);

    const pipeline = orderModel.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match.storeId).toBe(STORE_ID);
    expect(pipeline[0].$match.storeId).not.toBe(OTHER_STORE_ID);
  });

  it('escapes the search term before matching it against name/phone', async () => {
    orderModel.aggregate.mockReturnValue(query([]));

    await service.searchCustomers(STORE_ID, 'C++ (test)[1]');

    const { $or } = orderModel.aggregate.mock.calls[0][0][0].$match;
    expect($or[0]['customer.name'].source).toBe('C\\+\\+ \\(test\\)\\[1\\]');
    expect($or[1]['customer.phone'].source).toBe('C\\+\\+ \\(test\\)\\[1\\]');
  });

  it('maps distinct rows to { name, phone } and drops empty entries', async () => {
    orderModel.aggregate.mockReturnValue(
      query([
        { _id: { name: 'Ali', phone: '0550' } },
        { _id: { name: '', phone: '' } },
      ]),
    );

    const { data } = await service.searchCustomers(STORE_ID);

    expect(data).toEqual([{ name: 'Ali', phone: '0550' }]);
  });
});
