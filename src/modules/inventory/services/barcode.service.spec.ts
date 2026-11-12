import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { BarcodeService } from './barcode.service';
import { VariantsController } from '../variants.controller';
import { ProductOption } from '../schemas/product-option.schema';
import { ProductOptionValue } from '../schemas/product-option-value.schema';
import { ProductVariant } from '../schemas/product-variant.schema';
import { VariantOptionValue } from '../schemas/variant-option-value.schema';
import { Product } from '../../products/schemas/product.schema';
import { Store } from '../../stores/schemas/store.schema';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { isValidEan13 } from '../../../common/barcode/ean13';

/**
 * Phase 3 — barcode/SKU generation.
 *
 * The rules pinned here are the ones a mis-implementation would silently get wrong:
 *
 *  1. Barcodes are valid EAN-13, prefixed `20`, and their body comes from the store's atomic
 *     counter (so two stores, and two runs, cannot share a number).
 *  2. Generation is non-destructive: a variant that already has a code keeps it unless the
 *     caller explicitly asks to overwrite.
 *  3. The unique indexes still win: a SKU clash is retried with a numeric suffix, a barcode
 *     clash is reallocated, and the write loop is bounded.
 *  4. A product outside the caller's store is PRODUCT_NOT_IN_STORE, never a partial write.
 */

const PRODUCT_ID = new Types.ObjectId();
const STORE_ID = new Types.ObjectId();
const OTHER_STORE_ID = new Types.ObjectId();
const OPTION_SIZE = new Types.ObjectId();
const OPTION_COLOR = new Types.ObjectId();
const VALUE_SMALL = new Types.ObjectId();
const VALUE_RED = new Types.ObjectId();

/** A query-chain stub: every builder method returns itself, `.exec()` resolves `result`. */
const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate', 'session']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

const e11000 = (keyPattern: Record<string, number>, keyValue: Record<string, unknown> = {}) => {
  const err: any = new Error('E11000 duplicate key error collection: imraaah');
  err.code = 11000;
  err.keyPattern = keyPattern;
  err.keyValue = keyValue;
  return err;
};

/** Same builder chain as `query`, but `.exec()` rejects — used to simulate a duplicate-key write. */
const queryRejecting = (err: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate', 'session']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockRejectedValue(err);
  return q;
};

describe('BarcodeService — EAN-13 + SKU generation', () => {
  let service: BarcodeService;

  let productModel: any;
  let storeModel: any;
  let optionModel: any;
  let valueModel: any;
  let variantModel: any;
  let joinModel: any;

  let seq: number;

  const baseVariant = (over: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    productId: PRODUCT_ID,
    storeId: STORE_ID,
    barcode: null as string | null,
    sku: null as string | null,
    position: 0,
    ...over,
  });

  beforeAll(async () => {
    productModel = { findById: jest.fn() };
    storeModel = { findByIdAndUpdate: jest.fn() };
    optionModel = { find: jest.fn() };
    valueModel = { find: jest.fn() };
    variantModel = { find: jest.fn(), exists: jest.fn(), findOneAndUpdate: jest.fn() };
    joinModel = { find: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BarcodeService,
        { provide: getModelToken(Product.name), useValue: productModel },
        { provide: getModelToken(Store.name), useValue: storeModel },
        { provide: getModelToken(ProductOption.name), useValue: optionModel },
        { provide: getModelToken(ProductOptionValue.name), useValue: valueModel },
        { provide: getModelToken(ProductVariant.name), useValue: variantModel },
        { provide: getModelToken(VariantOptionValue.name), useValue: joinModel },
      ],
    }).compile();

    service = module.get(BarcodeService);
  });

  beforeEach(() => {
    jest.resetAllMocks();
    seq = 0;

    productModel.findById.mockImplementation(() =>
      query({ _id: PRODUCT_ID, storeId: STORE_ID, nameEn: 'Abaya', slug: 'abaya' }),
    );
    storeModel.findByIdAndUpdate.mockImplementation(() => {
      seq += 1;
      return query({ barcodeSeq: seq });
    });
    optionModel.find.mockImplementation(() =>
      query([
        { _id: OPTION_SIZE, position: 0 },
        { _id: OPTION_COLOR, position: 1 },
      ]),
    );
    valueModel.find.mockImplementation(() =>
      query([
        { _id: VALUE_SMALL, optionId: OPTION_SIZE, value: 'small', valueEn: 'Small' },
        { _id: VALUE_RED, optionId: OPTION_COLOR, value: 'red', valueEn: 'Red' },
      ]),
    );
    joinModel.find.mockReturnValue(query([]));
    variantModel.find.mockReturnValue(query([]));
    variantModel.exists.mockResolvedValue(null);
    variantModel.findOneAndUpdate.mockImplementation((_f: any, update: any) =>
      query({ ...update.$set }),
    );
  });

  it('generates a valid prefix-20 EAN-13 and a derived SKU', async () => {
    const variant = baseVariant();
    variantModel.find.mockReturnValue(query([variant]));
    joinModel.find.mockReturnValue(
      query([
        { variantId: variant._id, optionValueId: VALUE_SMALL },
        { variantId: variant._id, optionValueId: VALUE_RED },
      ]),
    );

    const result = await service.generateCodes(PRODUCT_ID.toHexString(), STORE_ID, {});

    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(isValidEan13(result.variants[0].barcode)).toBe(true);
    expect(result.variants[0].barcode!.startsWith('20')).toBe(true);
    expect(result.variants[0].sku).toBe('IMR-ABAYA-SMA-RED');
    expect(storeModel.findByIdAndUpdate).toHaveBeenCalledWith(
      STORE_ID,
      { $inc: { barcodeSeq: 1 } },
      expect.objectContaining({ new: true }),
    );
  });

  it('is non-destructive: a variant with both codes is skipped', async () => {
    const variant = baseVariant({ barcode: '2000000000015', sku: 'KEEP-ME' });
    variantModel.find.mockReturnValue(query([variant]));

    const result = await service.generateCodes(PRODUCT_ID.toHexString(), STORE_ID, {});

    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(variantModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(storeModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('overwrites existing codes only when asked', async () => {
    const variant = baseVariant({ barcode: '2000000000015', sku: 'KEEP-ME' });
    variantModel.find.mockReturnValue(query([variant]));

    const result = await service.generateCodes(PRODUCT_ID.toHexString(), STORE_ID, {
      overwrite: true,
    });

    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(variantModel.findOneAndUpdate).toHaveBeenCalled();
    const set = variantModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set.sku).not.toBe('KEEP-ME');
  });

  it('honours includeSku:false independently of the barcode', async () => {
    const variant = baseVariant();
    variantModel.find.mockReturnValue(query([variant]));

    const result = await service.generateCodes(PRODUCT_ID.toHexString(), STORE_ID, {
      includeSku: false,
    });

    expect(isValidEan13(result.variants[0].barcode)).toBe(true);
    expect(result.variants[0].sku).toBeNull();
    expect(variantModel.findOneAndUpdate.mock.calls[0][1].$set).not.toHaveProperty('sku');
  });

  it('only touches the variants listed in variantIds', async () => {
    const a = baseVariant();
    const b = baseVariant();
    variantModel.find.mockReturnValue(query([a, b]));

    const result = await service.generateCodes(PRODUCT_ID.toHexString(), STORE_ID, {
      variantIds: [String(a._id)],
    });

    expect(result.updated).toBe(1);
    expect(result.variants[0].variantId).toBe(String(a._id));
    expect(variantModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(String(variantModel.findOneAndUpdate.mock.calls[0][0]._id)).toBe(String(a._id));
  });

  it('refuses a product that is not in the caller’s store', async () => {
    productModel.findById.mockImplementation(() =>
      query({ _id: PRODUCT_ID, storeId: OTHER_STORE_ID, nameEn: 'NotMine' }),
    );

    await expect(
      service.generateCodes(PRODUCT_ID.toHexString(), STORE_ID, {}),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.PRODUCT_NOT_IN_STORE });
    expect(variantModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('skips a barcode the store already holds and takes the next one', async () => {
    const variant = baseVariant();
    variantModel.find.mockReturnValue(query([variant]));
    variantModel.exists.mockResolvedValueOnce({ _id: 'taken' }).mockResolvedValue(null);

    const result = await service.generateCodes(PRODUCT_ID.toHexString(), STORE_ID, {
      includeSku: false,
    });

    expect(isValidEan13(result.variants[0].barcode)).toBe(true);
    expect(variantModel.exists).toHaveBeenCalled();
  });

  it('retries a SKU clash with a numeric suffix', async () => {
    const variant = baseVariant();
    variantModel.find.mockReturnValue(query([variant]));
    variantModel.findOneAndUpdate
      .mockImplementationOnce(() => queryRejecting(e11000({ storeId: 1, sku: 1 })))
      .mockImplementation((_f: any, update: any) => query({ ...variant, ...update.$set }));

    const result = await service.generateCodes(PRODUCT_ID.toHexString(), STORE_ID, {});

    expect(result.variants[0].sku).toBe('IMR-ABAYA-2');
    expect(variantModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('reallocates the barcode when the write clashes on the barcode index', async () => {
    const variant = baseVariant();
    variantModel.find.mockReturnValue(query([variant]));
    variantModel.findOneAndUpdate
      .mockImplementationOnce(() => queryRejecting(e11000({ storeId: 1, barcode: 1 })))
      .mockImplementation((_f: any, update: any) => query({ ...variant, ...update.$set }));

    const result = await service.generateCodes(PRODUCT_ID.toHexString(), STORE_ID, {
      includeSku: false,
    });

    expect(isValidEan13(result.variants[0].barcode)).toBe(true);
    expect(variantModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(storeModel.findByIdAndUpdate).toHaveBeenCalledTimes(2);
  });
});

describe('VariantsController — generate-codes tenancy', () => {
  it('resolves the store from the session and ignores any smuggled store id', async () => {
    const barcodeService = { generateCodes: jest.fn().mockResolvedValue({ updated: 0, skipped: 0, variants: [] }) };
    const storesService = { findByMemberIdOrThrow: jest.fn().mockResolvedValue({ _id: STORE_ID }) };
    const controller = new VariantsController(
      {} as any,
      barcodeService as any,
      storesService as any,
    );

    const dto = { variantIds: [String(new Types.ObjectId())], storeId: 'evil-store' } as any;
    await controller.generateCodes(PRODUCT_ID.toHexString(), dto, { user: { id: 'vendor-1' } });

    expect(storesService.findByMemberIdOrThrow).toHaveBeenCalledWith('vendor-1');
    expect(barcodeService.generateCodes).toHaveBeenCalledWith(
      PRODUCT_ID.toHexString(),
      STORE_ID,
      dto,
    );
  });
});
