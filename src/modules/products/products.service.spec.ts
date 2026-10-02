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
import { AppErrorCode } from '../../common/errors/error-codes.enum';
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

  const ownedProduct = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(PRODUCT_ID),
    storeId: VENDOR_STORE_ID,
    vendorEmail: VENDOR_EMAIL,
    nameEn: 'Owned Product',
    nameAr: 'Owned Product',
    nameFr: 'Owned Product',
    image: 'https://cdn.test/a.webp',
    images: [],
    status: 'Active',
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

    orderModel = { countDocuments: jest.fn() };
    categoryModel = { find: jest.fn() };
    subCategoryModel = { find: jest.fn() };

    storesService = {
      resolveStoreIdByEmail: jest.fn().mockResolvedValue(null),
      findByVendorId: jest.fn().mockResolvedValue(null),
      incrementProductCount: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<StoresService>;

    uploadService = {
      extractKeyFromUrl: jest.fn().mockReturnValue(null),
      deleteProductImages: jest.fn().mockResolvedValue(undefined),
      deleteFiles: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<UploadService>;

    cacheService = { clear: jest.fn() } as unknown as jest.Mocked<CacheService>;

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

    it('still creates the product when the store lookup fails, without a storeId', async () => {
      // A vendor whose email resolves to no store must not be blocked from listing products.
      storesService.resolveStoreIdByEmail.mockRejectedValue(new Error('lookup boom'));
      productModel.findOne.mockReturnValue(query(null));

      const result = await service.create(dto, 'unmapped@test.com');

      expect(result).toBeDefined();
      expect(productModel.mock.calls[0][0].storeId).toBeUndefined();
    });
  });

  describe('findAll() — storeId filtering', () => {
    it('filters by storeId when supplied', async () => {
      productModel.find.mockReturnValue(query([]));

      await service.findAll({ storeId: VENDOR_STORE_ID.toString() });

      expect(productModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ storeId: VENDOR_STORE_ID, published: true, status: 'Active' }),
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
      orderModel.countDocuments.mockReturnValue(query(3));

      await expect(service.remove(PRODUCT_ID, VENDOR_EMAIL, VENDOR_USER_ID)).rejects.toMatchObject({
        errorCode: AppErrorCode.PRODUCT_CANNOT_DELETE_HAS_ORDERS,
      });

      expect(productModel.findOneAndDelete).not.toHaveBeenCalled();
    });
  });

  describe('duplicate()', () => {
    beforeEach(() => {
      storesService.findByVendorId.mockResolvedValue({ _id: VENDOR_STORE_ID } as any);
    });

    it('copies storeId and resets status/published', async () => {
      productModel.findById.mockReturnValue(query(ownedProduct()));
      productModel.findOne.mockReturnValue(query(null));

      await service.duplicate(PRODUCT_ID, VENDOR_EMAIL, VENDOR_USER_ID);

      const copy = productModel.mock.calls[0][0];
      expect(copy.storeId).toBe(VENDOR_STORE_ID);
      expect(copy.status).toBe('Draft');
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
});
