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
import { AppErrorCode } from '../../../common/errors/error-codes.enum';

/**
 * Phase 7 "invalid requests" + store-isolation matrix for the variants module (roadmap 1,
 * spec §5.4 / §8.5).
 *
 * Three rules are pinned here, all of them ownership or data-integrity boundaries rather than
 * preferences:
 *
 *  1. Every mutation resolves its product/option/value/variant THROUGH the caller's store.
 *     A product id from another vendor is PRODUCT_NOT_IN_STORE; an id that exists but is not
 *     part of *this* product is OPTION_NOT_FOUND / OPTION_VALUE_NOT_FOUND / VARIANT_NOT_FOUND.
 *     Nothing about a foreign tenant's data is ever observable — not even its existence.
 *  2. A combination may only be built from the product's own option values (spec §8.5), so a
 *     value copied from another product's matrix is refused instead of silently splicing two
 *     products' dimensions.
 *  3. The unique indexes are the authority for SKU/combination uniqueness; an E11000 is
 *     translated to DUPLICATE_SKU / DUPLICATE_VARIANT_COMBINATION and anything else is
 *     rethrown, never swallowed.
 */

const PRODUCT_ID = new Types.ObjectId();
const STORE_ID = new Types.ObjectId();
const OTHER_STORE_ID = new Types.ObjectId();
const OPTION_A = new Types.ObjectId();
const OPTION_B = new Types.ObjectId();
const VALUE_A = new Types.ObjectId();
const VALUE_B = new Types.ObjectId();
const FOREIGN_VALUE = new Types.ObjectId();
const VARIANT_ID = new Types.ObjectId();

/** A query-chain stub: every mongoose builder method returns itself, `.exec()` resolves. */
const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate', 'session']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

const e11000 = (keyPattern: Record<string, number>, keyValue: Record<string, unknown> = {}) => {
  const index = Object.keys(keyPattern)[0];
  const err: any = new Error(`E11000 duplicate key error collection: imraaah, index: ${index}`);
  err.code = 11000;
  err.keyPattern = keyPattern;
  err.keyValue = keyValue;
  return err;
};

describe('VariantsService — ownership, cross-product values, duplicate indexes', () => {
  let service: VariantsService;

  let productModel: any;
  let optionModel: any;
  let valueModel: any;
  let variantModel: any;
  let joinModel: any;
  let balanceModel: any;
  let movementModel: any;
  let variantSave: jest.Mock;
  let optionSave: jest.Mock;
  let sessions: Array<{ withTransaction: jest.Mock; endSession: jest.Mock }>;

  const ownedProduct = (over: Record<string, unknown> = {}) => ({
    _id: PRODUCT_ID,
    storeId: STORE_ID,
    ...over,
  });

  const option = (id: Types.ObjectId, key: string, over: Record<string, unknown> = {}) => ({
    _id: id,
    key,
    productId: PRODUCT_ID,
    storeId: STORE_ID,
    type: 'text',
    ...over,
  });

  const value = (id: Types.ObjectId, optionId: Types.ObjectId, value: string, over: Record<string, unknown> = {}) => ({
    _id: id,
    optionId,
    productId: PRODUCT_ID,
    storeId: STORE_ID,
    value,
    isActive: true,
    ...over,
  });

  const variantDoc = (over: Record<string, unknown> = {}) => ({
    _id: VARIANT_ID,
    productId: PRODUCT_ID,
    storeId: STORE_ID,
    isActive: true,
    isDeleted: false,
    ...over,
  });

  /** Documents returned per model, dispatched on the filter shape. */
  let context: {
    product: Record<string, unknown> | null;
    variant: Record<string, unknown> | null;
    comboExists: boolean;
    optionValues: Array<Record<string, unknown>>;
  };

  beforeEach(async () => {
    sessions = [];
    variantSave = jest.fn().mockResolvedValue({ _id: new Types.ObjectId() });
    optionSave = jest.fn().mockResolvedValue({ _id: new Types.ObjectId() });

    context = {
      product: ownedProduct(),
      variant: variantDoc(),
      comboExists: false,
      optionValues: [
        value(VALUE_A, OPTION_A, 'small'),
        value(VALUE_B, OPTION_B, 'red'),
      ],
    };

    productModel = { findById: jest.fn().mockReturnValue(query(ownedProduct())) };

    // Dual role: purge looks up the auto-default scaffold via findOne({$or:...}) — never
    // found here — while createOption constructs instances through the same jest.fn.
    const optionCtor: any = jest.fn().mockImplementation((doc: any) => ({
      ...doc,
      _id: new Types.ObjectId(),
      save: optionSave,
    }));
    optionCtor.findOne = jest.fn().mockImplementation((filter: any) => {
      if (filter?.$or) return query(null); // no auto-default scaffold
      return query(option(OPTION_A, 'size'));
    });
    optionCtor.find = jest
      .fn()
      .mockReturnValue(query([option(OPTION_A, 'size'), option(OPTION_B, 'color')]));
    optionCtor.findOneAndUpdate = jest.fn().mockReturnValue(query(option(OPTION_A, 'size')));
    optionModel = optionCtor;

    const valueCtor: any = jest.fn().mockImplementation((doc: any) => ({
      ...doc,
      _id: new Types.ObjectId(),
      save: optionSave,
    }));
    valueCtor.find = jest.fn().mockImplementation((filter: any) => {
      const rows = context.optionValues.filter((v) => String(v.optionId) === String(filter.optionId));
      return query(rows);
    });
    valueCtor.findOne = jest.fn().mockReturnValue(query(null));
    valueCtor.findOneAndUpdate = jest.fn().mockReturnValue(query(value(VALUE_A, OPTION_A, 'small')));
    valueModel = valueCtor;

    const variantCtor: any = jest.fn().mockImplementation((doc: any) => ({
      ...doc,
      _id: new Types.ObjectId(),
      save: variantSave,
    }));
    variantCtor.findOne = jest.fn().mockImplementation((filter: any) => {
      if (filter?.combinationKey)
        return query(context.comboExists ? variantDoc({ combinationKey: filter.combinationKey }) : null);
      return query(context.variant);
    });
    variantCtor.findOneAndUpdate = jest.fn().mockReturnValue(query(variantDoc()));
    variantCtor.find = jest.fn().mockReturnValue(query([]));
    variantModel = variantCtor;

    joinModel = { insertMany: jest.fn().mockResolvedValue([]), find: jest.fn().mockReturnValue(query([])) };
    balanceModel = {
      create: jest.fn().mockResolvedValue([]),
      find: jest.fn().mockReturnValue(query([])),
      findOne: jest.fn().mockReturnValue(query(null)),
    };
    movementModel = { insertMany: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VariantsService,
        { provide: getModelToken(ProductOption.name), useValue: optionModel },
        { provide: getModelToken(ProductOptionValue.name), useValue: valueModel },
        { provide: getModelToken(ProductVariant.name), useValue: variantModel },
        { provide: getModelToken(VariantOptionValue.name), useValue: joinModel },
        { provide: getModelToken(InventoryBalance.name), useValue: balanceModel },
        { provide: getModelToken(InventoryMovement.name), useValue: movementModel },
        { provide: getModelToken(Product.name), useValue: productModel },
      ],
    }).compile();

    service = module.get<VariantsService>(VariantsService);

    // startSession is used by purge/create/deactivate paths; the fake runs the callback
    // inline so ordering is observable without a replica set.
    (service as any).startSession = jest.fn().mockImplementation(async () => {
      const s = { withTransaction: jest.fn(async (cb: any) => cb()), endSession: jest.fn().mockResolvedValue(undefined) };
      sessions.push(s);
      return s;
    });
  });

  // ------------------------------------------------------------------ store scoping

  it('refuses createOption on another vendor\'s product', async () => {
    productModel.findById.mockReturnValue(query({ _id: PRODUCT_ID, storeId: OTHER_STORE_ID }));

    await expect(
      service.createOption(PRODUCT_ID.toString(), STORE_ID, { nameEn: 'Size' }),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.PRODUCT_NOT_IN_STORE });
    expect(optionSave).not.toHaveBeenCalled();
  });

  it('refuses createValue on another vendor\'s product', async () => {
    productModel.findById.mockReturnValue(query({ _id: PRODUCT_ID, storeId: OTHER_STORE_ID }));

    await expect(
      service.createValue(PRODUCT_ID.toString(), STORE_ID, OPTION_A.toString(), { valueEn: 'Large' }),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.PRODUCT_NOT_IN_STORE });
    expect(valueModel).not.toHaveBeenCalled();
  });

  it('refuses updateVariant on another vendor\'s product (before the variant is read)', async () => {
    productModel.findById.mockReturnValue(query({ _id: PRODUCT_ID, storeId: OTHER_STORE_ID }));

    await expect(
      service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), { sku: 'X-1' }),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.PRODUCT_NOT_IN_STORE });
    expect(variantModel.findOne).not.toHaveBeenCalled();
  });

  it('refuses listOptions on another vendor\'s product', async () => {
    productModel.findById.mockReturnValue(query({ _id: PRODUCT_ID, storeId: OTHER_STORE_ID }));

    await expect(service.listOptions(PRODUCT_ID.toString(), STORE_ID)).rejects.toMatchObject({
      errorCode: AppErrorCode.PRODUCT_NOT_IN_STORE,
    });
  });

  it('reports a variant of a different product as not found, even inside one\'s own store', async () => {
    context.variant = null;

    await expect(
      service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), { sku: 'X-1' }),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.VARIANT_NOT_FOUND });
    expect(variantModel.findOne).toHaveBeenCalledWith({
      _id: VARIANT_ID.toString(), // passed through raw: requireVariant does not cast
      productId: new Types.ObjectId(PRODUCT_ID.toString()),
      storeId: STORE_ID,
    });
  });

  it('reports a value that is not part of the given option/product/store as not found', async () => {
    await expect(
      service.updateValue(PRODUCT_ID.toString(), STORE_ID, OPTION_A.toString(), FOREIGN_VALUE.toString(), {
        valueEn: 'Medium',
      }),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.OPTION_VALUE_NOT_FOUND });
    expect(valueModel.findOne).toHaveBeenCalledWith({
      _id: FOREIGN_VALUE.toString(), // passed through raw: requireValue does not cast
      optionId: OPTION_A,
      productId: new Types.ObjectId(PRODUCT_ID.toString()),
      storeId: STORE_ID,
    });
  });

  it('rejects malformed ids without touching the database', async () => {
    productModel.findById.mockReturnValue(query(ownedProduct()));

    await expect(
      service.createValue(PRODUCT_ID.toString(), STORE_ID, 'not-an-id', { valueEn: 'Large' }),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.OPTION_NOT_FOUND });
    expect(optionModel.findOne).not.toHaveBeenCalled();

    await expect(
      service.updateVariant(PRODUCT_ID.toString(), STORE_ID, 'not-an-id', { sku: 'X' }),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.VARIANT_NOT_FOUND });
  });

  // -------------------------------------------------- createVariants combination rules

  it('refuses a value from another product\'s matrix (spec §8.5)', async () => {
    await expect(
      service.createVariants(PRODUCT_ID.toString(), STORE_ID, {
        selections: [{ combinationKey: 'k', optionValueIds: [VALUE_A.toString(), FOREIGN_VALUE.toString()] }],
      }),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.OPTION_VALUE_NOT_FOUND });
    expect(variantSave).not.toHaveBeenCalled();
  });

  it('refuses a combination that repeats the same value twice', async () => {
    await expect(
      service.createVariants(PRODUCT_ID.toString(), STORE_ID, {
        selections: [{ combinationKey: 'k', optionValueIds: [VALUE_A.toString(), VALUE_A.toString()] }],
      }),
    ).rejects.toMatchObject({
      errorCode: AppErrorCode.INVALID_COMBINATION,
      errorParams: { reason: 'duplicate_value_in_combination' },
    });
  });

  it('refuses a combination that does not cover every option', async () => {
    await expect(
      service.createVariants(PRODUCT_ID.toString(), STORE_ID, {
        selections: [{ combinationKey: 'k', optionValueIds: [VALUE_A.toString()] }],
      }),
    ).rejects.toMatchObject({
      errorCode: AppErrorCode.INVALID_COMBINATION,
      errorParams: { reason: 'option_count_mismatch', expected: 2, received: 1 },
    });
  });

  it('refuses an empty selection set', async () => {
    await expect(service.createVariants(PRODUCT_ID.toString(), STORE_ID, { selections: [] })).rejects.toMatchObject({
      errorCode: AppErrorCode.INVALID_COMBINATION,
      errorParams: { reason: 'empty_selection' },
    });
  });

  it('refuses another vendor\'s product outright', async () => {
    productModel.findById.mockReturnValue(query({ _id: PRODUCT_ID, storeId: OTHER_STORE_ID }));

    await expect(
      service.createVariants(PRODUCT_ID.toString(), STORE_ID, {
        selections: [{ combinationKey: 'k', optionValueIds: [VALUE_A.toString(), VALUE_B.toString()] }],
      }),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.PRODUCT_NOT_IN_STORE });
    expect(sessions).toHaveLength(0);
  });

  it('creates variant + joins + zeroed balance + initial movement on one session', async () => {
    const result = await service.createVariants(PRODUCT_ID.toString(), STORE_ID, {
      selections: [{ combinationKey: 'k1', optionValueIds: [VALUE_A.toString(), VALUE_B.toString()], sku: 'T-SM-RED' }],
      reason: 'first matrix',
    });

    expect(result.createdCount).toBe(1);
    expect(variantSave).toHaveBeenCalledWith({ session: expect.anything() });
    expect(joinModel.insertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({ storeId: STORE_ID, optionValueId: VALUE_A }),
        expect.objectContaining({ storeId: STORE_ID, optionValueId: VALUE_B }),
      ],
      expect.objectContaining({ session: expect.anything(), ordered: true }),
    );
    expect(balanceModel.create).toHaveBeenCalledWith(
      [expect.objectContaining({ storeId: STORE_ID, onHand: 0, reserved: 0 })],
      expect.objectContaining({ session: expect.anything() }),
    );
    expect(movementModel.insertMany).toHaveBeenCalledWith(
      [expect.objectContaining({ type: 'initial_stock', quantityDelta: 0, reason: 'first matrix' })],
      expect.objectContaining({ session: expect.anything() }),
    );
    expect(sessions).toHaveLength(2); // purge scaffold check + create transaction
    for (const s of sessions) expect(s.endSession).toHaveBeenCalled();
  });

  it('refuses a selection priced above the product initial price', async () => {
    productModel.findById.mockReturnValue(query(ownedProduct({ price: 1000, originalPrice: 1200 })));

    await expect(
      service.createVariants(PRODUCT_ID.toString(), STORE_ID, {
        selections: [
          {
            combinationKey: 'k1',
            optionValueIds: [VALUE_A.toString(), VALUE_B.toString()],
            priceOverride: 1500,
          },
        ],
      }),
    ).rejects.toMatchObject({
      errorCode: AppErrorCode.VARIANT_PRICE_EXCEEDS_INITIAL_PRICE,
      errorParams: { price: 1500, initialPrice: 1200 },
    });
    expect(variantSave).not.toHaveBeenCalled();
  });

  it('skips an already-existing combination instead of duplicating it', async () => {
    context.comboExists = true;

    const result = await service.createVariants(PRODUCT_ID.toString(), STORE_ID, {
      selections: [{ combinationKey: 'k1', optionValueIds: [VALUE_A.toString(), VALUE_B.toString()] }],
    });

    expect(result.createdCount).toBe(0);
    // The service recomputes the key from the value ids; the dto's own combinationKey is
    // advisory. Skips must report the canonical key the clash was found under.
    expect(result.skippedDuplicates).toEqual([
      service.combinationKeyFor([VALUE_A.toString(), VALUE_B.toString()]),
    ]);
    expect(variantSave).not.toHaveBeenCalled();
    expect(balanceModel.create).not.toHaveBeenCalled();
  });

  it('translates an E11000 on store+SKU into DUPLICATE_SKU with the offending sku', async () => {
    variantSave.mockRejectedValue(e11000({ storeId_1_sku_1: 1 }, { sku: 'T-SM-RED', storeId: STORE_ID }));

    await expect(
      service.createVariants(PRODUCT_ID.toString(), STORE_ID, {
        selections: [{ combinationKey: 'k1', optionValueIds: [VALUE_A.toString(), VALUE_B.toString()], sku: 'T-SM-RED' }],
      }),
    ).rejects.toMatchObject({
      errorCode: AppErrorCode.DUPLICATE_SKU,
      errorParams: { sku: 'T-SM-RED', index: 'storeId_1_sku_1' },
    });
  });

  it('translates an E11000 on product+combination into DUPLICATE_VARIANT_COMBINATION', async () => {
    variantSave.mockRejectedValue(e11000({ productId_1_combinationKey_1: 1 }));

    await expect(
      service.createVariants(PRODUCT_ID.toString(), STORE_ID, {
        selections: [{ combinationKey: 'k1', optionValueIds: [VALUE_A.toString(), VALUE_B.toString()] }],
      }),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.DUPLICATE_VARIANT_COMBINATION });
  });

  it('rethrows a non-duplicate error unchanged', async () => {
    variantSave.mockRejectedValue(new Error('disk full'));

    await expect(
      service.createVariants(PRODUCT_ID.toString(), STORE_ID, {
        selections: [{ combinationKey: 'k1', optionValueIds: [VALUE_A.toString(), VALUE_B.toString()] }],
      }),
    ).rejects.toThrow('disk full');
  });

  // ------------------------------------------------------- updateVariant SKU conflicts

  it('updateVariant writes only the submitted fields, trimmed', async () => {
    await service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), {
      sku: '  T-L-METRIC  ',
      priceOverride: 1400,
    });

    expect(variantModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: VARIANT_ID },
      { $set: { sku: 'T-L-METRIC', priceOverride: 1400 } },
      { new: true },
    );
  });

  // --------------------------------------------------- updateVariant price round-trip

  it('updateVariant clears a price override with an explicit null (revert to inherit)', async () => {
    await service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), {
      priceOverride: null,
    });

    expect(variantModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: VARIANT_ID },
      { $set: { priceOverride: null } },
      { new: true },
    );
  });

  it('updateVariant persists a zero override (0 is a real free price, not "inherit")', async () => {
    await service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), {
      priceOverride: 0,
    });

    // The write must carry 0 through — a falsy check would have dropped it and inherited instead.
    expect(variantModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: VARIANT_ID },
      { $set: { priceOverride: 0 } },
      { new: true },
    );
  });

  it('updateVariant leaves an omitted price override untouched', async () => {
    await service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), {
      sku: 'ONLY-SKU',
    });

    const set = (variantModel.findOneAndUpdate as jest.Mock).mock.calls[0][1].$set;
    expect(set).toEqual({ sku: 'ONLY-SKU' });
    expect(set).not.toHaveProperty('priceOverride');
    expect(set).not.toHaveProperty('compareAtPrice');
  });

  it('updateVariant writes and clears a compare-at price', async () => {
    await service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), {
      compareAtPrice: 1990,
    });
    expect(variantModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: VARIANT_ID },
      { $set: { compareAtPrice: 1990 } },
      { new: true },
    );

    (variantModel.findOneAndUpdate as jest.Mock).mockClear();
    await service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), {
      compareAtPrice: null,
    });
    expect(variantModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: VARIANT_ID },
      { $set: { compareAtPrice: null } },
      { new: true },
    );
  });

  // ------------------------------------------------- updateVariant price ≤ initial price

  it('updateVariant rejects a price override above the product initial price', async () => {
    productModel.findById.mockReturnValue(query(ownedProduct({ price: 1000, originalPrice: 1200 })));

    await expect(
      service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), {
        priceOverride: 1500,
      }),
    ).rejects.toMatchObject({
      errorCode: AppErrorCode.VARIANT_PRICE_EXCEEDS_INITIAL_PRICE,
      errorParams: { price: 1500, initialPrice: 1200 },
    });
    expect(variantModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('updateVariant allows a price override at or below the initial price', async () => {
    productModel.findById.mockReturnValue(query(ownedProduct({ price: 1000, originalPrice: 1200 })));

    await service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), {
      priceOverride: 1100,
    });
    expect(variantModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: VARIANT_ID },
      { $set: { priceOverride: 1100 } },
      { new: true },
    );
  });

  it('updateVariant rejects a compare-at below the variant\u2019s own price override', async () => {
    productModel.findById.mockReturnValue(query(ownedProduct({ price: 1000, originalPrice: 1200 })));
    context.variant = variantDoc({ priceOverride: 1000, compareAtPrice: 1500 });

    await expect(
      service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), {
        compareAtPrice: 900,
      }),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.VARIANT_PRICE_EXCEEDS_INITIAL_PRICE });
    expect(variantModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('updateVariant compares against the stored override when only the compare-at is patched', async () => {
    productModel.findById.mockReturnValue(query(ownedProduct({ price: 1000, originalPrice: 1200 })));
    context.variant = variantDoc({ priceOverride: 1600, compareAtPrice: null });

    await expect(
      service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), {
        compareAtPrice: 1500,
      }),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.VARIANT_PRICE_EXCEEDS_INITIAL_PRICE });
  });

  it('updateVariant leaves an unrelated edit on legacy data untouched (no price re-check)', async () => {
    // A variant that predates the rule: price 9999 with no compare-at. Editing only the SKU must
    // still succeed, even though the effective pair now violates the invariant.
    productModel.findById.mockReturnValue(query(ownedProduct({ price: 1000, originalPrice: 1200 })));
    context.variant = variantDoc({ priceOverride: 9999, compareAtPrice: null });

    await service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), {
      sku: 'LEGACY-1',
    });
    expect(variantModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: VARIANT_ID },
      { $set: { sku: 'LEGACY-1' } },
      { new: true },
    );
  });

  it('updateVariant maps a store+SKU index clash to DUPLICATE_SKU', async () => {
    (variantModel.findOneAndUpdate as jest.Mock).mockReturnValue({
      exec: () => Promise.reject(e11000({ storeId_1_sku_1: 1 }, { sku: 'TAKEN' })),
    });

    await expect(
      service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), { sku: 'TAKEN' }),
    ).rejects.toMatchObject({
      errorCode: AppErrorCode.DUPLICATE_SKU,
      errorParams: { sku: 'TAKEN', index: 'storeId_1_sku_1' },
    });
  });

  it('updateVariant rethrows anything that is not an E11000', async () => {
    (variantModel.findOneAndUpdate as jest.Mock).mockReturnValue({
      exec: () => Promise.reject(new Error('connection reset')),
    });

    await expect(
      service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), { sku: 'X' }),
    ).rejects.toThrow('connection reset');
  });

  // --------------------------------------------------- updateVariant barcode conflicts

  it('updateVariant writes and trims a valid barcode', async () => {
    await service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), {
      barcode: '  2000000000053  ',
    });

    expect(variantModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: VARIANT_ID },
      { $set: { barcode: '2000000000053' } },
      { new: true },
    );
  });

  it('updateVariant clears a barcode when an empty string is submitted', async () => {
    await service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), {
      barcode: '',
    });

    expect(variantModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: VARIANT_ID },
      { $set: { barcode: null } },
      { new: true },
    );
  });

  it('updateVariant refuses a barcode that fails the checksum, before writing', async () => {
    await expect(
      service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), {
        barcode: '2000000000054',
      }),
    ).rejects.toMatchObject({
      errorCode: AppErrorCode.BARCODE_INVALID,
      errorParams: { barcode: '2000000000054' },
    });
    expect(variantModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('updateVariant maps a store+barcode index clash to BARCODE_DUPLICATE', async () => {
    (variantModel.findOneAndUpdate as jest.Mock).mockReturnValue({
      exec: () => Promise.reject(e11000({ storeId_1_barcode_1: 1 }, { barcode: '2000000000053' })),
    });

    await expect(
      service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), {
        barcode: '2000000000053',
      }),
    ).rejects.toMatchObject({
      errorCode: AppErrorCode.BARCODE_DUPLICATE,
      errorParams: { barcode: '2000000000053', index: 'storeId_1_barcode_1' },
    });
  });

  it('updateVariant does not pre-query barcodes, so cross-store reuse is left to the index', async () => {
    await service.updateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString(), {
      barcode: '2000000000053',
    });

    // The only findOne is `requireVariant` scoping by product+store; there is no extra lookup
    // keyed on the barcode, so a barcode already used in ANOTHER store cannot be misreported.
    expect(variantModel.findOne).toHaveBeenCalledTimes(1);
    expect(variantModel.findOne).toHaveBeenCalledWith({
      _id: VARIANT_ID.toString(),
      productId: new Types.ObjectId(PRODUCT_ID.toString()),
      storeId: STORE_ID,
    });
  });

  // ------------------------------------------------------------------- state guards

  it('activateVariant refuses another vendor\'s product', async () => {
    productModel.findById.mockReturnValue(query({ _id: PRODUCT_ID, storeId: OTHER_STORE_ID }));

    await expect(
      service.activateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString()),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.PRODUCT_NOT_IN_STORE });
  });

  it('activateVariant refuses a soft-deleted variant', async () => {
    context.variant = variantDoc({ isDeleted: true });

    await expect(
      service.activateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString()),
    ).rejects.toMatchObject({
      errorCode: AppErrorCode.VARIANT_NOT_FOUND,
      errorParams: { reason: 'deleted' },
    });
  });

  it('activateVariant refuses while any unit of the variant is reserved', async () => {
    balanceModel.find.mockReturnValue(query([{ reserved: 2 }]));

    await expect(
      service.activateVariant(PRODUCT_ID.toString(), STORE_ID, VARIANT_ID.toString()),
    ).rejects.toMatchObject({
      errorCode: AppErrorCode.VARIANT_INACTIVE,
      errorParams: { reason: 'reserved_stock_exists' },
    });
    expect(variantModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
