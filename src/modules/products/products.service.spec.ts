import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { ProductsService } from './products.service';
import { Product } from './schemas/product.schema';
import { Category } from '../categories/schemas/category.schema';
import { SubCategory } from '../categories/schemas/sub-category.schema';
import { Order } from '../orders/schemas/order.schema';
import { CacheService } from '../../common/cache.service';
import { StoresService } from '../stores/stores.service';
import { UploadService } from '../upload/upload.service';
import { VariantsService } from '../inventory/services/variants.service';
import { AuditService } from '../audit/audit.service';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { AppException } from '../../common/errors/app-exception';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

/**
 * Authorization coverage for the storeId migration (PLAN_STORE_ID_MIGRATION.md §8).
 *
 * These tests pin the behaviour that actually shipped: ownership is decided by the stable
 * `storeId`, with the legacy `vendorEmail` comparison kept only for documents written before
 * the backfill. They are deliberately written against the real code paths rather than
 * restating the plan, so a future removal of the fallback shows up here as a failure.
 */

const VENDOR_STORE_ID = new Types.ObjectId();
const OTHER_STORE_ID = new Types.ObjectId();
const VENDOR_USER_ID = new Types.ObjectId().toString();
const OTHER_USER_ID = new Types.ObjectId().toString();
const VENDOR_EMAIL = 'vendor@test.com';
const OTHER_EMAIL = 'other@test.com';

const PRODUCT_ID = new Types.ObjectId().toString();
const VARIANT_ID = new Types.ObjectId().toString();

/** A query-chain stub: every mongoose builder method returns itself, `.exec()` resolves. */
const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

describe('ProductsService', () => {
  let service: ProductsService;

  let productModel: any;
  let orderModel: any;
  let categoryModel: any;
  let subCategoryModel: any;
  let storesService: jest.Mocked<StoresService>;
  let uploadService: jest.Mocked<UploadService>;
  let cacheService: jest.Mocked<CacheService>;
  let variantsService: jest.Mocked<
    Pick<
      VariantsService,
      | 'getMatrix'
      | 'getProductSummaries'
      | 'createDefaultVariant'
      | 'duplicateMatrix'
      | 'cascadeSoftDeleteForProduct'
      | 'listVariantIdsForProduct'
      | 'clearImageAssignments'
    >
  >;

  const ownedProduct = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(PRODUCT_ID),
    storeId: VENDOR_STORE_ID,
    vendorEmail: VENDOR_EMAIL,
    nameEn: 'Owned Product',
    nameAr: 'Owned Product',
    nameFr: 'Owned Product',
    image: 'https://cdn.test/a.webp',
    images: [],
    published: true,
    ...overrides,
  });

  beforeEach(async () => {
    // `productModel` doubles as a mongoose Model and as a constructor (`new this.productModel(...)`).
    productModel = jest.fn().mockImplementation((data: any) => ({
      ...data,
      save: jest.fn().mockResolvedValue({ ...data, _id: new Types.ObjectId() }),
    }));
    productModel.find = jest.fn();
    productModel.findOne = jest.fn();
    productModel.findById = jest.fn();
    productModel.findByIdAndUpdate = jest.fn();
    productModel.findOneAndDelete = jest.fn();
    productModel.deleteOne = jest.fn().mockReturnValue(query({ deletedCount: 1 }));

    orderModel = { countDocuments: jest.fn() };
    categoryModel = { find: jest.fn() };
    subCategoryModel = { find: jest.fn() };

    storesService = {
      resolveStoreIdByEmail: jest.fn().mockResolvedValue(null),
      findByVendorId: jest.fn().mockResolvedValue(null),
      findByVendorIdOrThrow: jest.fn(),
      incrementProductCount: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<StoresService>;

    uploadService = {
      extractKeyFromUrl: jest.fn().mockReturnValue(null),
      deleteProductImages: jest.fn().mockResolvedValue(undefined),
      deleteFiles: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<UploadService>;

    cacheService = { clear: jest.fn() } as unknown as jest.Mocked<CacheService>;

    // Added with the universal-variant work. Defaults keep existing product tests on their
    // previous behaviour (no store resolves -> no factory runs; summaries return nothing).
    variantsService = {
      getMatrix: jest.fn().mockResolvedValue(null),
      getProductSummaries: jest.fn().mockResolvedValue(new Map()),
      createDefaultVariant: jest.fn().mockResolvedValue({ productId: '', variantsCreated: 1 }),
      duplicateMatrix: jest.fn().mockResolvedValue({ variantsCreated: 0 }),
      cascadeSoftDeleteForProduct: jest.fn().mockResolvedValue({ variants: 0, values: 0, joins: 0 }),
      listVariantIdsForProduct: jest.fn().mockResolvedValue([]),
      clearImageAssignments: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<typeof variantsService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: getModelToken(Product.name), useValue: productModel },
        { provide: getModelToken(Category.name), useValue: categoryModel },
        { provide: getModelToken(SubCategory.name), useValue: subCategoryModel },
        { provide: getModelToken(Order.name), useValue: orderModel },
        { provide: CacheService, useValue: cacheService },
        { provide: StoresService, useValue: storesService },
        { provide: UploadService, useValue: uploadService },
        { provide: VariantsService, useValue: variantsService },
        { provide: AuditService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
  });

  describe('create() — storeId dual-write', () => {
    const dto = {
      nameEn: 'New Product',
      nameAr: 'New Product',
      nameFr: 'New Product',
      image: 'https://cdn.test/new.webp',
      price: 100,
    } as unknown as CreateProductDto;

    it('writes storeId alongside vendorEmail and counts the product on that store', async () => {
      storesService.resolveStoreIdByEmail.mockResolvedValue(VENDOR_STORE_ID);
      productModel.findOne.mockReturnValue(query(null));

      await service.create(dto, VENDOR_EMAIL);

      expect(storesService.resolveStoreIdByEmail).toHaveBeenCalledWith(VENDOR_EMAIL);
      expect(storesService.incrementProductCount).toHaveBeenCalledWith(VENDOR_EMAIL, 1);
      const created = productModel.mock.calls[0][0];
      expect(created.storeId).toBe(VENDOR_STORE_ID);
      expect(created.vendorEmail).toBe(VENDOR_EMAIL);
    });

    it('bootstraps the default "One Size" variant on the fresh product', async () => {
      // Every product is a variant product: create must hand the new product a matrix.
      storesService.resolveStoreIdByEmail.mockResolvedValue(VENDOR_STORE_ID);
      productModel.findOne.mockReturnValue(query(null));

      const saved = (await service.create(dto, VENDOR_EMAIL)) as unknown as { _id: Types.ObjectId };

      expect(variantsService.createDefaultVariant).toHaveBeenCalledWith(
        String(saved._id),
        VENDOR_STORE_ID,
        0,
      );
    });

    it('still creates the product when the store lookup fails, without a storeId', async () => {
      // A vendor whose email resolves to no store must not be blocked from listing products.
      storesService.resolveStoreIdByEmail.mockRejectedValue(new Error('lookup boom'));
      productModel.findOne.mockReturnValue(query(null));

      const result = await service.create(dto, 'unmapped@test.com');

      expect(result).toBeDefined();
      expect(productModel.mock.calls[0][0].storeId).toBeUndefined();
      expect(variantsService.createDefaultVariant).not.toHaveBeenCalled();
    });
  });

  describe('create() — HI-2 store product counter stays net-zero', () => {
    const dto = {
      nameEn: 'New Product',
      nameAr: 'New Product',
      nameFr: 'New Product',
      image: 'https://cdn.test/new.webp',
      price: 100,
    } as unknown as CreateProductDto;

    beforeEach(() => {
      storesService.resolveStoreIdByEmail.mockResolvedValue(VENDOR_STORE_ID);
      productModel.findOne.mockReturnValue(query(null));
      storesService.incrementProductCount.mockClear();
      productModel.deleteOne.mockClear();
    });

    it('increments exactly once on the success path', async () => {
      await service.create(dto, VENDOR_EMAIL);

      expect(storesService.incrementProductCount).toHaveBeenCalledTimes(1);
      expect(storesService.incrementProductCount).toHaveBeenCalledWith(VENDOR_EMAIL, 1);
      expect(productModel.deleteOne).not.toHaveBeenCalled();
    });

    it('increments before the variant factory runs, so a factory failure can compensate', async () => {
      // Ordering is the whole fix: if the +1 landed after the factory, a thrown factory
      // would never be compensated and the count would drift down by one on every retry.
      await service.create(dto, VENDOR_EMAIL);

      expect(
        storesService.incrementProductCount.mock.invocationCallOrder[0],
      ).toBeLessThan(variantsService.createDefaultVariant.mock.invocationCallOrder[0]);
    });

    it('rolls the product back and decrements on factory failure, netting zero', async () => {
      variantsService.createDefaultVariant.mockRejectedValue(new Error('factory boom'));

      await expect(service.create(dto, VENDOR_EMAIL)).rejects.toThrow('factory boom');

      expect(storesService.incrementProductCount.mock.calls).toEqual([
        [VENDOR_EMAIL, 1],
        [VENDOR_EMAIL, -1],
      ]);
      expect(productModel.deleteOne).toHaveBeenCalledWith({ _id: expect.any(Types.ObjectId) });
    });
  });

  describe('create() — discount price must not exceed the original price', () => {
    const base = {
      nameEn: 'Priced Product',
      image: 'https://cdn.test/new.webp',
      weight: 1,
    };

    beforeEach(() => {
      storesService.resolveStoreIdByEmail.mockResolvedValue(VENDOR_STORE_ID);
      productModel.findOne.mockReturnValue(query(null));
    });

    it('rejects a discount price above the original price with a dedicated code', async () => {
      const dto = { ...base, originalPrice: 1000, price: 1500 } as unknown as CreateProductDto;

      await expect(service.create(dto, VENDOR_EMAIL)).rejects.toMatchObject({
        errorCode: AppErrorCode.PRODUCT_PRICE_EXCEEDS_ORIGINAL_PRICE,
        errorParams: { price: 1500, originalPrice: 1000 },
      });
      expect(productModel).not.toHaveBeenCalled();
    });

    it('accepts a discount price below the original price', async () => {
      const dto = { ...base, originalPrice: 1800, price: 1500 } as unknown as CreateProductDto;

      await service.create(dto, VENDOR_EMAIL);

      expect(productModel).toHaveBeenCalled();
    });

    it('accepts an omitted price (it defaults to the original price)', async () => {
      const dto = { ...base, originalPrice: 1200 } as unknown as CreateProductDto;

      await service.create(dto, VENDOR_EMAIL);

      expect(productModel).toHaveBeenCalled();
    });
  });

  describe('update() — discount price must not exceed the original price', () => {
    beforeEach(() => {
      productModel.findById.mockReturnValue(
        query(ownedProduct({ originalPrice: 1000, price: 900 })),
      );
      productModel.findByIdAndUpdate.mockReturnValue(
        query(ownedProduct({ originalPrice: 1000, price: 950 })),
      );
    });

    it('rejects a price-only PATCH that exceeds the stored original price', async () => {
      await expect(
        service.update(PRODUCT_ID, { price: 1500 } as UpdateProductDto, VENDOR_EMAIL, VENDOR_USER_ID),
      ).rejects.toMatchObject({
        errorCode: AppErrorCode.PRODUCT_PRICE_EXCEEDS_ORIGINAL_PRICE,
        errorParams: { price: 1500, originalPrice: 1000 },
      });
      expect(productModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('rejects a payload where both fields make the price exceed the original', async () => {
      await expect(
        service.update(
          PRODUCT_ID,
          { originalPrice: 800, price: 900 } as UpdateProductDto,
          VENDOR_EMAIL,
          VENDOR_USER_ID,
        ),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.PRODUCT_PRICE_EXCEEDS_ORIGINAL_PRICE });
      expect(productModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('allows a price-only PATCH below the stored original price', async () => {
      await service.update(
        PRODUCT_ID,
        { price: 950 } as UpdateProductDto,
        VENDOR_EMAIL,
        VENDOR_USER_ID,
      );

      expect(productModel.findByIdAndUpdate).toHaveBeenCalled();
    });

    it('allows lowering the original price, which pulls the omitted price down with it', async () => {
      // No `price` in the payload: the service mirrors `originalPrice` into `price`, so the
      // effective pair is equal and valid — the guard must not read the stored price here.
      await service.update(
        PRODUCT_ID,
        { originalPrice: 500 } as UpdateProductDto,
        VENDOR_EMAIL,
        VENDOR_USER_ID,
      );

      const updateArg = productModel.findByIdAndUpdate.mock.calls[0][1];
      expect(updateArg.price).toBe(500);
      expect(updateArg.originalPrice).toBe(500);
    });
  });

  describe('findAll() — storeId filtering', () => {
    it('filters by storeId when supplied', async () => {
      productModel.find.mockReturnValue(query([]));

      await service.findAll({ storeId: VENDOR_STORE_ID.toString() });

      expect(productModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ storeId: VENDOR_STORE_ID, published: true }),
      );
    });

    it('prefers storeId when both storeId and vendorEmail are supplied', async () => {
      productModel.find.mockReturnValue(query([]));

      await service.findAll({
        storeId: VENDOR_STORE_ID.toString(),
        vendorEmail: OTHER_EMAIL,
      } as any);

      const filter = productModel.find.mock.calls[0][0];
      expect(filter.storeId).toEqual(VENDOR_STORE_ID);
      expect(filter.vendorEmail).toBeUndefined();
    });

    it('falls back to vendorEmail when no storeId is given (pre-Phase-3 clients)', async () => {
      productModel.find.mockReturnValue(query([]));

      await service.findAll({ vendorEmail: VENDOR_EMAIL } as any);

      expect(productModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ vendorEmail: VENDOR_EMAIL }),
      );
    });
  });

  describe('findAll() — variantSummary price range', () => {
    const summaryWith = (over: Record<string, unknown> = {}) => ({
      variantCount: 2,
      activeVariantCount: 2,
      availableTotal: 5,
      inStock: true,
      hasPriceOverride: true,
      overrideMin: 800,
      overrideMax: 1500,
      ...over,
    });

    const findOne = () => {
      productModel.find.mockReturnValue(query([ownedProduct({ price: 1000 })]));
    };

    it('pairs priceRange.compareAtPrice with the variant that owns the minimum', async () => {
      productModel.find.mockReturnValue(query([ownedProduct({ price: 1000 })]));
      variantsService.getProductSummaries.mockResolvedValue(
        new Map([
          [
            PRODUCT_ID,
            summaryWith({
              variantPrices: [
                { priceOverride: 800, compareAtPrice: 1200 },
                { priceOverride: 1500, compareAtPrice: null },
              ],
            }),
          ],
        ]) as any,
      );

      const result = await service.findAll({});
      const summary = (result.products[0] as any).variantSummary;

      expect(result.products[0].price).toBe(1000);
      expect((result.products[0] as any).variantSummary.priceRange).toEqual({
        min: 800,
        max: 1500,
        compareAtPrice: 1200,
      });
      // The internal pair list must never leak to the public payload.
      expect(summary.variantPrices).toBeUndefined();
    });

    it('pairs the compare-at of the inheriting variant when the base price is the minimum', async () => {
      productModel.find.mockReturnValue(query([ownedProduct({ price: 500 })]));
      variantsService.getProductSummaries.mockResolvedValue(
        new Map([
          [
            PRODUCT_ID,
            {
              variantCount: 2,
              activeVariantCount: 2,
              availableTotal: 5,
              inStock: true,
              hasPriceOverride: true,
              overrideMin: 800,
              overrideMax: 1500,
              variantPrices: [
                { priceOverride: 800, compareAtPrice: 1200 },
                { priceOverride: null, compareAtPrice: 900 },
              ],
            },
          ],
        ]) as any,
      );

      const { products } = await service.findAll({});

      expect(products[0].variantSummary?.priceRange).toEqual({
        min: 500,
        max: 1500,
        compareAtPrice: 900,
      });
    });

    it('reports a null compare-at when none of the variants carry one', async () => {
      productModel.find.mockReturnValue(query([ownedProduct({ price: 1000 })]));
      variantsService.getProductSummaries.mockResolvedValue(
        new Map([
          [
            PRODUCT_ID,
            {
              variantCount: 1,
              activeVariantCount: 1,
              availableTotal: 3,
              inStock: true,
              hasPriceOverride: false,
              overrideMin: null,
              overrideMax: null,
            },
          ],
        ]) as any,
      );

      const { products } = await service.findAll({});

      expect(products[0].variantSummary?.priceRange).toEqual({
        min: 1000,
        max: 1000,
        compareAtPrice: null,
      });
    });
  });

  describe('update() — D3 ownership', () => {
    beforeEach(() => {
      storesService.findByVendorId.mockResolvedValue({ _id: VENDOR_STORE_ID } as any);
    });

    it('rejects a vendor editing another vendor\'s product', async () => {
      productModel.findById.mockReturnValue(query(ownedProduct({ storeId: OTHER_STORE_ID })));

      await expect(
        service.update(PRODUCT_ID, { price: 1 } as UpdateProductDto, VENDOR_EMAIL, VENDOR_USER_ID),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.PRODUCT_ACCESS_DENIED });

      expect(productModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('rejects a legacy product owned by another vendor email, even though it has no storeId', async () => {
      // The email fallback must not become a bypass: a storeId mismatch is still fatal,
      // and here the store is known so there is no reason to consult email at all.
      productModel.findById.mockReturnValue(query(ownedProduct({ storeId: null, vendorEmail: OTHER_EMAIL })));

      await expect(
        service.update(PRODUCT_ID, { price: 1 } as UpdateProductDto, VENDOR_EMAIL, VENDOR_USER_ID),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.PRODUCT_ACCESS_DENIED });
    });

    it('allows the owning vendor to update, matching on storeId not email', async () => {
      // Deliberately mismatched email: ownership must come from storeId.
      productModel.findById.mockReturnValue(query(ownedProduct({ vendorEmail: 'stale@test.com' })));
      productModel.findByIdAndUpdate.mockReturnValue(query(ownedProduct()));

      await service.update(PRODUCT_ID, { price: 1 } as UpdateProductDto, VENDOR_EMAIL, VENDOR_USER_ID);

      expect(productModel.findByIdAndUpdate).toHaveBeenCalled();
    });

    it('allows a pre-migration product (no storeId) when the vendor email matches', async () => {
      productModel.findById.mockReturnValue(query(ownedProduct({ storeId: null })));
      productModel.findByIdAndUpdate.mockReturnValue(query(ownedProduct()));

      await expect(
        service.update(PRODUCT_ID, { price: 1 } as UpdateProductDto, VENDOR_EMAIL, VENDOR_USER_ID),
      ).resolves.toBeDefined();
    });

    it('falls back to the vendor email when the vendor has no store at all', async () => {
      // §8 expected STORE_NOT_FOUND here. The shipped code does not do that: it uses the
      // non-throwing `findByVendorId`, and when there is no store ownership is decided by
      // the legacy email comparison alone. Pinned so the divergence is deliberate and
      // visible — it is the one path where a mismatched `storeId` is NOT fatal.
      storesService.findByVendorId.mockResolvedValue(null);
      productModel.findById.mockReturnValue(query(ownedProduct({ storeId: OTHER_STORE_ID })));
      productModel.findByIdAndUpdate.mockReturnValue(query(ownedProduct()));

      await expect(
        service.update(PRODUCT_ID, { price: 1 } as UpdateProductDto, VENDOR_EMAIL, VENDOR_USER_ID),
      ).resolves.toBeDefined();
    });

    it('still denies a storeless vendor whose email does not match the product', async () => {
      storesService.findByVendorId.mockResolvedValue(null);
      productModel.findById.mockReturnValue(query(ownedProduct({ vendorEmail: OTHER_EMAIL })));

      await expect(
        service.update(PRODUCT_ID, { price: 1 } as UpdateProductDto, VENDOR_EMAIL, VENDOR_USER_ID),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.PRODUCT_ACCESS_DENIED });

      expect(productModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('survives a throwing store lookup without a 500', async () => {
      // The `.catch(() => null)` shim means a database blip degrades to the email path
      // rather than surfacing as an unhandled error to the vendor.
      storesService.findByVendorId.mockRejectedValue(new Error('db down'));
      productModel.findById.mockReturnValue(query(ownedProduct()));
      productModel.findByIdAndUpdate.mockReturnValue(query(ownedProduct()));

      await expect(
        service.update(PRODUCT_ID, { price: 1 } as UpdateProductDto, VENDOR_EMAIL, VENDOR_USER_ID),
      ).resolves.toBeDefined();
    });
  });

  describe('remove() — D3 ownership', () => {
    beforeEach(() => {
      storesService.findByVendorId.mockResolvedValue({ _id: VENDOR_STORE_ID } as any);
      orderModel.countDocuments.mockReturnValue(query(0));
    });

    it('rejects a vendor deleting another vendor\'s product', async () => {
      productModel.findById.mockReturnValue(query(ownedProduct({ storeId: OTHER_STORE_ID })));

      await expect(service.remove(PRODUCT_ID, VENDOR_EMAIL, VENDOR_USER_ID)).rejects.toMatchObject({
        errorCode: AppErrorCode.PRODUCT_ACCESS_DENIED,
      });

      expect(productModel.findOneAndDelete).not.toHaveBeenCalled();
    });

    it('scopes the delete by storeId, not just _id', async () => {
      // Guards against a concurrent write reassigning ownership between read and delete.
      productModel.findById.mockReturnValue(query(ownedProduct()));
      productModel.findOneAndDelete.mockReturnValue(query(ownedProduct()));

      await service.remove(PRODUCT_ID, VENDOR_EMAIL, VENDOR_USER_ID);

      expect(productModel.findOneAndDelete).toHaveBeenCalledWith({
        _id: PRODUCT_ID,
        storeId: VENDOR_STORE_ID,
      });
    });

    it('refuses to delete a product that appears in orders', async () => {
      // `remove()` loads the product first (ownership, then the Phase 4 cascade needs the
      // store scope), so the order-count guard can only be reached with a loadable document.
      productModel.findById.mockReturnValue(query(ownedProduct()));
      orderModel.countDocuments.mockReturnValue(query(3));

      await expect(service.remove(PRODUCT_ID, VENDOR_EMAIL, VENDOR_USER_ID)).rejects.toMatchObject({
        errorCode: AppErrorCode.PRODUCT_CANNOT_DELETE_HAS_ORDERS,
      });

      expect(productModel.findOneAndDelete).not.toHaveBeenCalled();
    });

    it('refuses to delete a product whose order history only mentions a variant (HI-3)', async () => {
      productModel.findById.mockReturnValue(query(ownedProduct()));
      variantsService.listVariantIdsForProduct.mockResolvedValue([VARIANT_ID]);
      orderModel.countDocuments.mockReturnValue(query(2));

      await expect(service.remove(PRODUCT_ID, VENDOR_EMAIL, VENDOR_USER_ID)).rejects.toMatchObject({
        errorCode: AppErrorCode.PRODUCT_CANNOT_DELETE_HAS_ORDERS,
      });

      expect(orderModel.countDocuments).toHaveBeenCalledWith({
        $or: [{ 'items.productId': PRODUCT_ID }, { 'items.variantId': { $in: [VARIANT_ID] } }],
      });
      expect(variantsService.listVariantIdsForProduct).toHaveBeenCalledWith(PRODUCT_ID, String(VENDOR_STORE_ID));
      expect(productModel.findOneAndDelete).not.toHaveBeenCalled();
    });

    it('deletes a product when no order line references it or its variants (HI-3)', async () => {
      productModel.findById.mockReturnValue(query(ownedProduct()));
      productModel.findOneAndDelete.mockReturnValue(query(ownedProduct()));
      variantsService.listVariantIdsForProduct.mockResolvedValue([VARIANT_ID]);
      orderModel.countDocuments.mockReturnValue(query(0));

      await service.remove(PRODUCT_ID, VENDOR_EMAIL, VENDOR_USER_ID);

      expect(orderModel.countDocuments).toHaveBeenCalledWith({
        $or: [{ 'items.productId': PRODUCT_ID }, { 'items.variantId': { $in: [VARIANT_ID] } }],
      });
      expect(productModel.findOneAndDelete).toHaveBeenCalled();
    });
  });

  describe('duplicate()', () => {
    beforeEach(() => {
      storesService.findByVendorId.mockResolvedValue({ _id: VENDOR_STORE_ID } as any);
    });

    it('copies storeId and resets published', async () => {
      productModel.findById.mockReturnValue(query(ownedProduct()));
      productModel.findOne.mockReturnValue(query(null));

      await service.duplicate(PRODUCT_ID, VENDOR_EMAIL, VENDOR_USER_ID);

      const copy = productModel.mock.calls[0][0];
      expect(copy.storeId).toBe(VENDOR_STORE_ID);
      expect(copy.published).toBe(false);
    });

    it('rejects duplicating another vendor\'s product', async () => {
      productModel.findById.mockReturnValue(query(ownedProduct({ storeId: OTHER_STORE_ID })));

      await expect(service.duplicate(PRODUCT_ID, VENDOR_EMAIL, VENDOR_USER_ID)).rejects.toMatchObject({
        errorCode: AppErrorCode.PRODUCT_ACCESS_DENIED,
      });

      expect(productModel).not.toHaveBeenCalled();
    });
  });

  describe('searchSuggestions() — inventory autocomplete', () => {
    beforeEach(() => {
      storesService.findByVendorIdOrThrow.mockResolvedValue({
        _id: VENDOR_STORE_ID,
        vendorEmail: VENDOR_EMAIL,
      } as any);
      productModel.find.mockReturnValue(query([]));
    });

    it('resolves the store from the session vendor id, never from the query', async () => {
      await service.searchSuggestions(VENDOR_USER_ID, { q: 'VB' });

      expect(storesService.findByVendorIdOrThrow).toHaveBeenCalledWith(VENDOR_USER_ID);
    });

    it('refuses when the caller has no store, instead of falling back to a wider scope', async () => {
      storesService.findByVendorIdOrThrow.mockRejectedValue(
        new AppException(AppErrorCode.STORE_NOT_FOUND, {}),
      );

      await expect(service.searchSuggestions(VENDOR_USER_ID, { q: 'VB' })).rejects.toMatchObject({
        errorCode: AppErrorCode.STORE_NOT_FOUND,
      });
      expect(productModel.find).not.toHaveBeenCalled();
    });

    it('scopes ownership to the storeId, keeping vendorEmail only as the pre-migration fallback', async () => {
      await service.searchSuggestions(VENDOR_USER_ID, { q: 'VB' });

      const filter = productModel.find.mock.calls[0][0];
      expect(filter.$and[0].$or).toEqual([
        { storeId: VENDOR_STORE_ID },
        { vendorEmail: VENDOR_EMAIL },
      ]);
    });

    it('drops the vendorEmail branch when the store carries none, so it cannot widen the match', async () => {
      storesService.findByVendorIdOrThrow.mockResolvedValue({
        _id: VENDOR_STORE_ID,
      } as any);

      await service.searchSuggestions(VENDOR_USER_ID, { q: 'VB' });

      expect(productModel.find.mock.calls[0][0].$and[0].$or).toEqual([{ storeId: VENDOR_STORE_ID }]);
    });

    it('matches product names in all three languages plus the slug', async () => {
      await service.searchSuggestions(VENDOR_USER_ID, { q: 'VB' });

      const matchBranch = productModel.find.mock.calls[0][0].$and[1].$or;
      expect(matchBranch.map((c: Record<string, unknown>) => Object.keys(c)[0])).toEqual([
        'nameEn',
        'nameAr',
        'nameFr',
        'slug',
      ]);
    });

    it('escapes regex metacharacters before they reach the query', async () => {
      await service.searchSuggestions(VENDOR_USER_ID, { q: 'C++ (test)' });

      const matchBranch = productModel.find.mock.calls[0][0].$and[1].$or;
      expect(matchBranch[0]).toEqual({
        nameEn: { $regex: 'C\\+\\+ \\(test\\)', $options: 'i' },
      });
    });

    it('projects only the dropdown fields, sorts and applies the limit', async () => {
      await service.searchSuggestions(VENDOR_USER_ID, { q: 'VB', limit: 5 });

      const chain = productModel.find.mock.results[0].value;
      expect(chain.select).toHaveBeenCalledWith(
        '_id nameEn nameAr nameFr slug image',
      );
      expect(chain.sort).toHaveBeenCalledWith({ nameEn: 1, _id: 1 });
      expect(chain.limit).toHaveBeenCalledWith(5);
    });

    it('clamps an out-of-range limit rather than trusting it', async () => {
      await service.searchSuggestions(VENDOR_USER_ID, { q: 'VB', limit: 999 });

      expect(productModel.find.mock.results[0].value.limit).toHaveBeenCalledWith(20);
    });

    it('answers a blank query with an empty list and issues no find at all', async () => {
      await expect(service.searchSuggestions(VENDOR_USER_ID, { q: '   ' })).resolves.toEqual([]);
      expect(productModel.find).not.toHaveBeenCalled();
    });

    it('maps documents to the suggestion shape the dropdown renders', async () => {
      productModel.find.mockReturnValue(
        query([
          {
            _id: new Types.ObjectId(PRODUCT_ID),
            nameEn: 'Vêtement Bébé',
            nameAr: 'بيبي',
            nameFr: 'Vêtement Bébé',
            slug: 'vetement-bebe',
            image: 'https://cdn.test/vb.webp',
          },
          {
            _id: new Types.ObjectId(),
            nameEn: 'Legacy',
            slug: 'legacy',
            image: null,
          },
        ]),
      );

      const suggestions = await service.searchSuggestions(VENDOR_USER_ID, { q: 'VB' });

      expect(suggestions[0]).toEqual({
        id: PRODUCT_ID,
        name: { en: 'Vêtement Bébé', ar: 'بيبي', fr: 'Vêtement Bébé' },
        image: 'https://cdn.test/vb.webp',
        slug: 'vetement-bebe',
      });
      expect(suggestions[1].name).toEqual({ en: 'Legacy', ar: '', fr: '' });
      expect(suggestions[1].image).toBeNull();
    });
  });
});
