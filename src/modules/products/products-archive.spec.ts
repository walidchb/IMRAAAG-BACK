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

const VENDOR_STORE_ID = new Types.ObjectId();
const OTHER_STORE_ID = new Types.ObjectId();
const PRODUCT_ID = new Types.ObjectId().toString();
const VENDOR_EMAIL = 'vendor@test.com';

const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

const productDoc = (overrides: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(PRODUCT_ID),
  storeId: VENDOR_STORE_ID,
  vendorEmail: VENDOR_EMAIL,
  nameEn: 'Product',
  nameAr: 'Product',
  nameFr: 'Product',
  published: true,
  isArchived: false,
  archivedAt: null,
  archivedBy: null,
  ...overrides,
});

describe('ProductsService — archiving', () => {
  let service: ProductsService;
  let productModel: any;
  let orderModel: any;
  let storesService: any;
  let variantsService: any;
  let auditService: any;

  beforeEach(async () => {
    productModel = {
      findById: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn(),
      countDocuments: jest.fn(),
    };

    orderModel = { countDocuments: jest.fn() };

    storesService = {
      findByMemberId: jest.fn().mockResolvedValue({ _id: VENDOR_STORE_ID, vendorEmail: VENDOR_EMAIL }),
      resolveStoreIdByEmail: jest.fn().mockResolvedValue(VENDOR_STORE_ID),
    };

    variantsService = {
      listVariantIdsForProduct: jest.fn().mockResolvedValue([]),
      getProductSummaries: jest.fn().mockResolvedValue(new Map()),
    };

    auditService = { record: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: getModelToken(Product.name), useValue: productModel },
        { provide: getModelToken(Category.name), useValue: { find: jest.fn() } },
        { provide: getModelToken(SubCategory.name), useValue: { find: jest.fn() } },
        { provide: getModelToken(Order.name), useValue: orderModel },
        { provide: CacheService, useValue: { clear: jest.fn() } },
        { provide: StoresService, useValue: storesService },
        {
          provide: UploadService,
          useValue: {
            extractKeyFromUrl: jest.fn().mockReturnValue(null),
            deleteProductImages: jest.fn(),
            deleteFiles: jest.fn(),
          },
        },
        { provide: VariantsService, useValue: variantsService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
  });

  describe('archive()', () => {
    it('refuses while a non-archived, non-deleted order references the product', async () => {
      productModel.findById.mockReturnValue(query(productDoc()));
      orderModel.countDocuments.mockReturnValue(query(2));

      await expect(service.archive(PRODUCT_ID, VENDOR_EMAIL)).rejects.toMatchObject({
        errorCode: AppErrorCode.PRODUCT_ARCHIVE_HAS_ACTIVE_ORDERS,
        errorParams: expect.objectContaining({ id: PRODUCT_ID, count: 2 }),
      });
      expect(orderModel.countDocuments).toHaveBeenCalledWith(
        expect.objectContaining({
          isDeleted: { $ne: true },
          isArchived: { $ne: true },
        }),
      );
      expect(productModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('counts a variant-only order line through the product variant ids', async () => {
      const variantId = new Types.ObjectId().toString();
      productModel.findById.mockReturnValue(query(productDoc()));
      variantsService.listVariantIdsForProduct.mockResolvedValue([variantId]);
      orderModel.countDocuments.mockReturnValue(query(1));

      await expect(service.archive(PRODUCT_ID, VENDOR_EMAIL)).rejects.toMatchObject({
        errorCode: AppErrorCode.PRODUCT_ARCHIVE_HAS_ACTIVE_ORDERS,
      });
      expect(orderModel.countDocuments).toHaveBeenCalledWith(
        expect.objectContaining({
          $or: expect.arrayContaining([{ 'items.variantId': { $in: [variantId] } }]),
        }),
      );
    });

    it('archives when only archived or soft-deleted orders remain', async () => {
      productModel.findById.mockReturnValue(query(productDoc()));
      orderModel.countDocuments.mockReturnValue(query(0));
      productModel.findOneAndUpdate.mockReturnValue(
        query(productDoc({ isArchived: true })),
      );

      const result = await service.archive(PRODUCT_ID, VENDOR_EMAIL);

      expect(result).toEqual({ id: expect.any(String), archived: true, archivedAt: expect.any(Date) });
      // The timestamp returned to the caller is the one written by the claim, not the mocked read.
      expect(productModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        { $set: expect.objectContaining({ isArchived: true, archivedAt: result.archivedAt }) },
        expect.anything(),
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ details: expect.objectContaining({ operation: 'archive' }) }),
      );
    });

    it('denies a foreign store before counting or writing', async () => {
      storesService.findByMemberId.mockResolvedValue({ _id: OTHER_STORE_ID });
      productModel.findById.mockReturnValue(query(productDoc()));

      await expect(
        service.archive(PRODUCT_ID, 'employee@test.com', 'user-1'),
      ).rejects.toMatchObject({
        errorCode: AppErrorCode.PRODUCT_ACCESS_DENIED,
      });
      expect(orderModel.countDocuments).not.toHaveBeenCalled();
      expect(productModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('is idempotent for an already archived product', async () => {
      const archivedAt = new Date('2026-01-01T00:00:00Z');
      productModel.findById.mockReturnValue(query(productDoc({ isArchived: true, archivedAt })));

      const result = await service.archive(PRODUCT_ID, VENDOR_EMAIL);

      expect(result).toEqual({ id: PRODUCT_ID, archived: true, archivedAt });
      expect(productModel.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('restore()', () => {
    it('is a no-op for an active product', async () => {
      productModel.findById.mockReturnValue(query(productDoc()));

      await expect(service.restore(PRODUCT_ID, VENDOR_EMAIL)).resolves.toEqual({
        id: PRODUCT_ID,
        archived: false,
      });
      expect(productModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('clears the three archive fields without touching publication', async () => {
      productModel.findById.mockReturnValue(query(productDoc({ isArchived: true })));
      productModel.findOneAndUpdate.mockReturnValue(query(productDoc()));

      await service.restore(PRODUCT_ID, VENDOR_EMAIL);

      const [, update] = productModel.findOneAndUpdate.mock.calls[0];
      expect(update).toEqual({
        $set: { isArchived: false, archivedAt: null, archivedBy: null },
      });
      expect(update.$set.published).toBeUndefined();
    });
  });

  describe('read separation', () => {
    it('excludes archived products from the public list', async () => {
      productModel.find.mockReturnValue(query([]));

      await service.findAll({} as any);

      expect(productModel.find.mock.calls[0][0]).toMatchObject({
        published: true,
        isArchived: { $ne: true },
      });
    });

    it('lists only active products by default and only archived ones on request', async () => {
      productModel.countDocuments.mockReturnValue(query(0));
      productModel.find.mockReturnValue(query([]));

      await service.findVendorProducts(VENDOR_EMAIL, {} as any);
      expect(productModel.find.mock.calls[0][0]).toMatchObject({ isArchived: { $ne: true } });

      await service.findVendorProducts(VENDOR_EMAIL, { archived: 'true' } as any);
      expect(productModel.find.mock.calls[1][0]).toMatchObject({ isArchived: true });
    });
  });

  describe('update()', () => {
    it('refuses to edit an archived product', async () => {
      productModel.findById.mockReturnValue(query(productDoc({ isArchived: true })));

      await expect(
        service.update(PRODUCT_ID, { nameEn: 'x' } as any, VENDOR_EMAIL),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.PRODUCT_ARCHIVED });
      expect(productModel.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });
});
