import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { BarcodeService } from './services/barcode.service';
import { VariantsController } from './variants.controller';
import { VariantsService } from './services/variants.service';
import { StoresService } from '../stores/stores.service';
import { ProductOption } from './schemas/product-option.schema';
import { ProductOptionValue } from './schemas/product-option-value.schema';
import { ProductVariant } from './schemas/product-variant.schema';
import { VariantOptionValue } from './schemas/variant-option-value.schema';
import { InventoryBalance } from './schemas/inventory-balance.schema';
import { InventoryMovement } from './schemas/inventory-movement.schema';
import { Product } from '../products/schemas/product.schema';
import { Store } from '../stores/schemas/store.schema';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';

/**
 * Barcode/SKU tenancy isolation (Barcode/SKU/Label plan, Phase 9).
 *
 * Codes are minted into a store's own namespace, so every read and write on the generation
 * path must be scoped by the store resolved from the session (`req.user.id`) — never by a
 * client-supplied id. This file pins the whole matrix in one place:
 *
 *   surface                 | guard                                            | also pinned in
 *   ------------------------|--------------------------------------------------|--------------------
 *   generate-codes route    | controller store-from-session                    | barcode.service.spec
 *   variant read            | `{ productId, storeId }` query                    | this file
 *   code write              | `{ _id, storeId }` update filter (defence in depth)| this file
 *   foreign product         | PRODUCT_NOT_IN_STORE before any read              | barcode.service.spec
 *   smuggled variant id     | dropped — never in the store's variant set        | this file
 *   hand-edit barcode route | requireVariant store-scoped → VARIANT_NOT_FOUND   | variants-ownership.spec
 *
 * A controller or service that trusted a client-supplied store id would let one vendor mint
 * codes into — or overwrite them in — another vendor's barcode series. The controller is
 * exercised directly (Nest guards are an HTTP concern and do not run on a plain method call).
 */

const STORE_A = new Types.ObjectId();
const STORE_B = new Types.ObjectId();
const PRODUCT_A = new Types.ObjectId();
const VARIANT_A = new Types.ObjectId();
const VARIANT_B = new Types.ObjectId();
const OPTION_SIZE = new Types.ObjectId();
const OPTION_COLOR = new Types.ObjectId();
const VALUE_SMALL = new Types.ObjectId();
const VALUE_RED = new Types.ObjectId();

const VENDOR_A = { id: new Types.ObjectId().toString(), email: 'vendor-a@store.test', role: 'VENDOR' };

/** Query-chain stub: every mongoose builder returns itself, `.exec()` resolves `result`. */
const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate', 'session']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

describe('Variant codes tenancy — barcodes/SKUs are minted per store', () => {
  // --------------------------------------------------------------------- controller

  describe('generate-codes route — the store comes from the session, never the body', () => {
    let controller: VariantsController;
    let barcodeService: any;
    let storesService: any;

    beforeEach(async () => {
      barcodeService = {
        generateCodes: jest.fn().mockResolvedValue({ productId: PRODUCT_A.toString(), updated: 0, skipped: 0, variants: [] }),
      };
      storesService = { findByVendorIdOrThrow: jest.fn().mockResolvedValue({ _id: STORE_A }) };

      const module: TestingModule = await Test.createTestingModule({
        controllers: [VariantsController],
        providers: [
          { provide: VariantsService, useValue: {} },
          { provide: BarcodeService, useValue: barcodeService },
          { provide: StoresService, useValue: storesService },
        ],
      }).compile();

      controller = module.get(VariantsController);
    });

    it('resolves the store from the session and ignores a smuggled store id', async () => {
      const dto = { variantIds: [VARIANT_A.toString()], storeId: STORE_B.toString() } as any;

      await controller.generateCodes(PRODUCT_A.toString(), dto, { user: VENDOR_A });

      expect(storesService.findByVendorIdOrThrow).toHaveBeenCalledWith(VENDOR_A.id);
      expect(barcodeService.generateCodes).toHaveBeenCalledWith(PRODUCT_A.toString(), STORE_A, dto);
      // The session store — not the storeId the caller put in the body — is what was used.
      expect(barcodeService.generateCodes.mock.calls[0][1]).not.toBe(STORE_B);
    });

    it('surfaces a store-resolution failure without generating anything', async () => {
      storesService.findByVendorIdOrThrow.mockRejectedValue(
        new AppException(AppErrorCode.STORE_NOT_FOUND),
      );

      await expect(
        controller.generateCodes(PRODUCT_A.toString(), {} as any, { user: {} }),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.STORE_NOT_FOUND });
      expect(barcodeService.generateCodes).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------------ service

  describe('BarcodeService — reads and writes are double-scoped by the store', () => {
    let service: BarcodeService;
    let productModel: any;
    let storeModel: any;
    let optionModel: any;
    let valueModel: any;
    let variantModel: any;
    let joinModel: any;
    let seq: number;

    const inStoreVariant = () => ({
      _id: VARIANT_A,
      productId: PRODUCT_A,
      storeId: STORE_A,
      barcode: null as string | null,
      sku: null as string | null,
      position: 0,
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
        query({ _id: PRODUCT_A, storeId: STORE_A, nameEn: 'Abaya', slug: 'abaya' }),
      );
      storeModel.findByIdAndUpdate.mockImplementation(() => {
        seq += 1;
        return query({ barcodeSeq: seq });
      });
      optionModel.find.mockReturnValue(
        query([
          { _id: OPTION_SIZE, position: 0 },
          { _id: OPTION_COLOR, position: 1 },
        ]),
      );
      valueModel.find.mockReturnValue(
        query([
          { _id: VALUE_SMALL, optionId: OPTION_SIZE, value: 'small', valueEn: 'Small' },
          { _id: VALUE_RED, optionId: OPTION_COLOR, value: 'red', valueEn: 'Red' },
        ]),
      );
      joinModel.find.mockReturnValue(query([]));
      // The store-scoped read never returns another store's variants.
      variantModel.find.mockReturnValue(query([inStoreVariant()]));
      variantModel.exists.mockResolvedValue(null);
      variantModel.findOneAndUpdate.mockImplementation((_f: any, update: any) =>
        query({ ...update.$set }),
      );
    });

    it('reads only the session store’s variants and drops a smuggled foreign variant id', async () => {
      const result = await service.generateCodes(PRODUCT_A.toString(), STORE_A, {
        variantIds: [VARIANT_A.toString(), VARIANT_B.toString()],
      });

      // The variant read carries the store; a foreign id never appears in its result set...
      expect(variantModel.find).toHaveBeenCalledWith({
        productId: new Types.ObjectId(PRODUCT_A),
        storeId: STORE_A,
        isDeleted: { $ne: true },
      });
      // ...so only the in-store variant is written, and the write filter re-checks the store.
      expect(result.updated).toBe(1);
      expect(result.variants[0].variantId).toBe(VARIANT_A.toString());
      expect(variantModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(variantModel.findOneAndUpdate.mock.calls[0][0]).toMatchObject({
        _id: VARIANT_A,
        storeId: STORE_A,
      });
    });

    it('refuses a product owned by another store before reading or writing variants', async () => {
      productModel.findById.mockImplementation(() =>
        query({ _id: PRODUCT_A, storeId: STORE_B, nameEn: 'NotMine', slug: 'not-mine' }),
      );

      await expect(
        service.generateCodes(PRODUCT_A.toString(), STORE_A, {}),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.PRODUCT_NOT_IN_STORE });

      expect(variantModel.find).not.toHaveBeenCalled();
      expect(variantModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(storeModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------ hand-edited barcode

  describe('VariantsService.updateVariant — a foreign variant is not found', () => {
    let service: VariantsService;
    let productModel: any;
    let variantModel: any;

    beforeEach(async () => {
      productModel = { findById: jest.fn().mockReturnValue(query({ _id: PRODUCT_A, storeId: STORE_A })) };
      variantModel = { findOne: jest.fn().mockReturnValue(query(null)), findOneAndUpdate: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          VariantsService,
          { provide: getModelToken(ProductOption.name), useValue: {} },
          { provide: getModelToken(ProductOptionValue.name), useValue: {} },
          { provide: getModelToken(ProductVariant.name), useValue: variantModel },
          { provide: getModelToken(VariantOptionValue.name), useValue: {} },
          { provide: getModelToken(InventoryBalance.name), useValue: {} },
          { provide: getModelToken(InventoryMovement.name), useValue: {} },
          { provide: getModelToken(Product.name), useValue: productModel },
        ],
      }).compile();

      service = module.get(VariantsService);
    });

    it('reports a variant owned by another store as not found and never writes', async () => {
      await expect(
        service.updateVariant(PRODUCT_A.toString(), STORE_A, VARIANT_B.toString(), {
          barcode: '2000000000053',
        }),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.VARIANT_NOT_FOUND });

      // The lookup is store-scoped, so store B's variant can never resolve for store A.
      expect(variantModel.findOne).toHaveBeenCalledWith({
        _id: VARIANT_B.toString(),
        productId: new Types.ObjectId(PRODUCT_A.toString()),
        storeId: STORE_A,
      });
      expect(variantModel.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });
});
