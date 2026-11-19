import { Types } from 'mongoose';
import { BoxesService } from './boxes.service';
import { BoxesController } from './boxes.controller';
import { AppErrorCode } from '../../common/errors/error-codes.enum';

/**
 * Tenant-isolation coverage for the Boxes feature.
 *
 * Two independent boundaries are proven:
 *  1. The controller resolves the store from the session and never from a client field.
 *  2. The service refuses any foreign Box/product/variant before reading or writing it.
 */

const storeA = new Types.ObjectId();
const storeB = new Types.ObjectId();
const productId = new Types.ObjectId();
const variantId = new Types.ObjectId();

const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

const foreignBox = () => ({
  _id: new Types.ObjectId(),
  storeId: storeB,
  vendorEmail: 'other@test.com',
  slug: 'foreign-box',
  nameEn: 'Foreign',
  nameAr: 'Foreign',
  nameFr: 'Foreign',
  image: 'https://cdn.test/x.webp',
  images: [],
  price: 1000,
  requiredQuantity: 2,
  allowDuplicates: true,
  published: true,
  isArchived: false,
  eligibleItems: [{ productId, variantIds: [variantId] }],
  createdAt: new Date(),
  updatedAt: new Date(),
});

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  variantId: String(variantId),
  productId: String(productId),
  storeId: String(storeB),
  sku: null,
  priceOverride: null,
  compareAtPrice: null,
  image: null,
  isActive: true,
  isDeleted: false,
  optionValueIds: [],
  snapshot: { options: [], label: 'M' },
  ...overrides,
});

describe('Boxes tenancy', () => {
  let service: BoxesService;
  let boxModel: any;
  let productModel: any;
  let orderModel: any;
  let storesService: any;
let variantsService: any;
let reservationsService: any;
let uploadService: any;

  beforeEach(() => {
    boxModel = jest.fn().mockImplementation((data: any) => ({
      ...data,
      save: jest.fn().mockResolvedValue({ ...data, _id: new Types.ObjectId() }),
    }));
    boxModel.find = jest.fn().mockReturnValue(query([]));
    boxModel.findOne = jest.fn().mockReturnValue(query(null));
    boxModel.findById = jest.fn().mockReturnValue(query(foreignBox()));
    boxModel.findOneAndUpdate = jest.fn().mockReturnValue(query(null));
    boxModel.findOneAndDelete = jest.fn().mockReturnValue(query(null));
    boxModel.countDocuments = jest.fn().mockReturnValue(query(0));

    boxModel.exists = jest.fn().mockResolvedValue(null);
    productModel = {
      find: jest.fn().mockReturnValue(query([])),
      exists: jest.fn().mockResolvedValue(null),
    };
    orderModel = { countDocuments: jest.fn().mockReturnValue(query(0)) };
    storesService = { findByMemberIdOrThrow: jest.fn() };
    variantsService = {
      snapshotsForVariants: jest.fn().mockResolvedValue(new Map()),
    };
    reservationsService = {
      getAvailabilityForVariants: jest.fn().mockResolvedValue(new Map()),
    };
    uploadService = {
      extractKeyFromUrl: jest.fn().mockReturnValue(null),
      deleteFiles: jest.fn().mockResolvedValue(undefined),
    };

    service = new BoxesService(
      boxModel,
      productModel,
      orderModel,
      storesService,
      variantsService,
      reservationsService,
      uploadService,
    );
  });

  describe('controller store resolution', () => {
    it('uses the session store and ignores a smuggled storeId', async () => {
      storesService.findByMemberIdOrThrow.mockResolvedValue({
        _id: storeA,
        vendorEmail: 'a@test.com',
      });
      const boxesService = {
        findVendorPage: jest.fn().mockResolvedValue({ boxes: [] }),
        create: jest.fn().mockResolvedValue({}),
      };
      const controller = new BoxesController(
        boxesService as any,
        storesService as any,
      );
      const req = { user: { id: 'user-1' } };

      await controller.findVendorPage(
        { storeId: String(storeB) } as any,
        req,
      );
      expect(boxesService.findVendorPage).toHaveBeenCalledWith(
        String(storeA),
        expect.objectContaining({ storeId: String(storeB) }),
      );

      await controller.create(
        { storeId: String(storeB), nameEn: 'Box' } as any,
        req,
      );
      expect(boxesService.create).toHaveBeenCalledWith(
        expect.objectContaining({ storeId: String(storeB) }),
        expect.objectContaining({ _id: storeA }),
      );
      expect(storesService.findByMemberIdOrThrow).toHaveBeenCalledWith('user-1');
    });
  });

  describe('service ownership guard', () => {
    it('refuses to read a Box owned by another store', async () => {
      await expect(
        service.findOneForVendor('foreign-id', String(storeA)),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.BOX_NOT_FOUND });
    });

    it('refuses to archive a foreign Box and never writes it', async () => {
      await expect(
        service.archive('foreign-id', { _id: storeA, vendorEmail: 'a@test.com' }, 'a@test.com'),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.BOX_NOT_FOUND });
      expect(boxModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('refuses to delete a foreign Box', async () => {
      await expect(
        service.remove('foreign-id', { _id: storeA, vendorEmail: 'a@test.com' }),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.BOX_NOT_FOUND });
      expect(boxModel.findOneAndDelete).not.toHaveBeenCalled();
    });
  });

  describe('eligibility store boundary', () => {
    const dto = {
      nameEn: 'Box',
      descriptionEn: 'Pick',
      image: 'https://cdn.test/b.webp',
      price: 1000,
      requiredQuantity: 1,
      eligibleItems: [
        { productId: String(productId), variantIds: [String(variantId)] },
      ],
    };

    it('rejects a product owned by another store', async () => {
      productModel.find.mockReturnValue(
        query([
          {
            _id: productId,
            storeId: storeB,
            nameEn: 'P',
            nameAr: 'P',
            nameFr: 'P',
            slug: 'p',
            image: null,
            images: [],
            price: 100,
            originalPrice: null,
            published: true,
            isArchived: false,
          },
        ]),
      );

      await expect(
        service.create(dto as any, { _id: storeA, vendorEmail: 'a@test.com' }),
      ).rejects.toMatchObject({
        errorCode: AppErrorCode.BOX_ELIGIBLE_PRODUCT_INVALID,
      });
    });

    it('rejects a variant owned by another store', async () => {
      productModel.find.mockReturnValue(
        query([
          {
            _id: productId,
            storeId: storeA,
            nameEn: 'P',
            nameAr: 'P',
            nameFr: 'P',
            slug: 'p',
            image: null,
            images: [],
            price: 100,
            originalPrice: null,
            published: true,
            isArchived: false,
          },
        ]),
      );
      variantsService.snapshotsForVariants.mockResolvedValue(
        new Map([[String(variantId), snapshot()]]),
      );

      await expect(
        service.create(dto as any, { _id: storeA, vendorEmail: 'a@test.com' }),
      ).rejects.toMatchObject({
        errorCode: AppErrorCode.BOX_ELIGIBLE_VARIANT_INVALID,
      });
    });
  });
});
