import { Types } from 'mongoose';
import { BoxesService } from './boxes.service';
import { AppErrorCode } from '../../common/errors/error-codes.enum';

/**
 * Unit coverage for the Boxes domain. The models/services are stubbed so the tests pin the
 * service's own rules — eligibility resolution, publish validation, lifecycle guards and the
 * public filters — rather than mongoose/HTTP behaviour.
 */

const storeId = new Types.ObjectId();
const otherStoreId = new Types.ObjectId();
const productId = new Types.ObjectId();
const variantId1 = new Types.ObjectId();
const variantId2 = new Types.ObjectId();

const store = { _id: storeId, vendorEmail: 'vendor@test.com' };

const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

const snapshot = (
  variantId: Types.ObjectId,
  overrides: Record<string, unknown> = {},
) => ({
  variantId: String(variantId),
  productId: String(productId),
  storeId: String(storeId),
  sku: 'SKU-1',
  priceOverride: null,
  compareAtPrice: null,
  image: null,
  isActive: true,
  isDeleted: false,
  optionValueIds: [],
  snapshot: { options: [], label: 'Red / M' },
  ...overrides,
});

const product = (overrides: Record<string, unknown> = {}) => ({
  _id: productId,
  storeId,
  nameEn: 'Scarf',
  nameAr: 'Scarf',
  nameFr: 'Scarf',
  slug: 'scarf',
  image: 'https://cdn.test/scarf.webp',
  images: [],
  price: 400,
  originalPrice: 500,
  published: true,
  isArchived: false,
  ...overrides,
});

const boxDoc = (overrides: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  storeId,
  vendorEmail: 'vendor@test.com',
  slug: 'box-of-2',
  nameEn: 'Box of 2',
  nameAr: 'Box of 2',
  nameFr: 'Box of 2',
  descriptionEn: 'Pick two',
  descriptionAr: 'Pick two',
  descriptionFr: 'Pick two',
  image: 'https://cdn.test/box.webp',
  images: [],
  price: 1000,
  requiredQuantity: 2,
  allowDuplicates: true,
  published: true,
  isArchived: false,
  archivedAt: null,
  archivedBy: null,
  eligibleItems: [
    { productId, variantIds: [variantId1, variantId2] },
  ],
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  ...overrides,
});

const validDto = () => ({
  nameEn: 'Box of 2',
  descriptionEn: 'Pick two items',
  image: 'https://cdn.test/box.webp',
  price: 1000,
  requiredQuantity: 2,
  eligibleItems: [
    { productId: String(productId), variantIds: [String(variantId1), String(variantId2)] },
  ],
});

describe('BoxesService', () => {
  let service: BoxesService;
  let boxModel: any;
  let productModel: any;
  let orderModel: any;
  let storesService: any;
  let variantsService: any;
  let reservationsService: any;

  beforeEach(() => {
    boxModel = jest.fn().mockImplementation((data: any) => ({
      ...data,
      save: jest.fn().mockResolvedValue({ ...data, _id: new Types.ObjectId() }),
    }));
    boxModel.find = jest.fn().mockReturnValue(query([]));
    boxModel.findOne = jest.fn().mockReturnValue(query(null));
    boxModel.findById = jest.fn().mockReturnValue(query(null));
    boxModel.findOneAndUpdate = jest.fn().mockReturnValue(query(null));
    boxModel.findOneAndDelete = jest.fn().mockReturnValue(query(null));
    boxModel.countDocuments = jest.fn().mockReturnValue(query(0));

    productModel = {
      find: jest.fn().mockReturnValue(query([product()])),
    };
    orderModel = {
      countDocuments: jest.fn().mockReturnValue(query(0)),
    };
    storesService = {
      findOne: jest.fn().mockResolvedValue({ _id: storeId, storeName: 'Test', storeSlug: 'test' }),
      findByMemberIdOrThrow: jest.fn(),
    };
    variantsService = {
      snapshotsForVariants: jest.fn().mockResolvedValue(
        new Map([
          [String(variantId1), snapshot(variantId1)],
          [String(variantId2), snapshot(variantId2)],
        ]),
      ),
    };
    reservationsService = {
      getAvailabilityForVariants: jest.fn().mockResolvedValue(
        new Map([
          [String(variantId1), 5],
          [String(variantId2), 4],
        ]),
      ),
    };

    service = new BoxesService(
      boxModel,
      productModel,
      orderModel,
      storesService,
      variantsService,
      reservationsService,
    );
  });

  describe('create', () => {
    it('creates a draft with ObjectId storeId and eligible ids (casting is explicit)', async () => {
      await service.create(validDto() as any, store);

      const payload = boxModel.mock.calls[0][0];
      expect(payload.storeId).toBeInstanceOf(Types.ObjectId);
      expect(payload.vendorEmail).toBe('vendor@test.com');
      expect(payload.published).toBe(false);
      expect(payload.eligibleItems[0].productId).toBeInstanceOf(Types.ObjectId);
      expect(payload.eligibleItems[0].variantIds[0]).toBeInstanceOf(Types.ObjectId);
    });

    it('rejects a foreign product (strict eligibility)', async () => {
      productModel.find.mockReturnValue(query([product({ storeId: otherStoreId })]));
      await expect(service.create(validDto() as any, store)).rejects.toMatchObject({
        errorCode: AppErrorCode.BOX_ELIGIBLE_PRODUCT_INVALID,
      });
    });

    it('rejects an inactive variant', async () => {
      variantsService.snapshotsForVariants.mockResolvedValue(
        new Map([[String(variantId1), snapshot(variantId1, { isActive: false })]]),
      );
      await expect(service.create(validDto() as any, store)).rejects.toMatchObject({
        errorCode: AppErrorCode.BOX_ELIGIBLE_VARIANT_INVALID,
      });
    });

    it('rejects publishing with a draft eligible product', async () => {
      productModel.find.mockReturnValue(query([product({ published: false })]));
      await expect(
        service.create({ ...validDto(), published: true } as any, store),
      ).rejects.toMatchObject({
        errorCode: AppErrorCode.BOX_ELIGIBLE_PRODUCT_INVALID,
      });
    });

    it('rejects an unreachable requiredQuantity when duplicates are off', async () => {
      variantsService.snapshotsForVariants.mockResolvedValue(
        new Map([[String(variantId1), snapshot(variantId1)]]),
      );
      await expect(
        service.create(
          {
            ...validDto(),
            published: true,
            allowDuplicates: false,
            eligibleItems: [
              { productId: String(productId), variantIds: [String(variantId1)] },
            ],
          } as any,
          store,
        ),
      ).rejects.toMatchObject({
        errorCode: AppErrorCode.BOX_REQUIRED_QUANTITY_UNREACHABLE,
      });
    });

    it('suffixes a colliding slug', async () => {
      boxModel.findOne.mockReturnValue(query({ slug: 'box-of-2' }));
      await service.create(validDto() as any, store);

      const payload = boxModel.mock.calls[0][0];
      expect(payload.slug).toMatch(/^box-of-2-\d+-[a-z0-9]+$/);
    });
  });

  describe('update', () => {
    it('refuses a write on an archived Box', async () => {
      boxModel.findById.mockReturnValue(query(boxDoc({ isArchived: true })));
      await expect(
        service.update('box-id', { price: 900 } as any, store),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.BOX_ARCHIVED });
    });

    it('rejects a stale expectedUpdatedAt', async () => {
      boxModel.findById.mockReturnValue(query(boxDoc()));
      await expect(
        service.update(
          'box-id',
          { price: 900, expectedUpdatedAt: '2020-01-01T00:00:00.000Z' } as any,
          store,
        ),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.BOX_CONFLICT });
    });

    it('rejects clearing every image', async () => {
      boxModel.findById.mockReturnValue(query(boxDoc({ images: [] })));
      await expect(
        service.update('box-id', { image: '', images: [] } as any, store),
      ).rejects.toMatchObject({
        errorCode: AppErrorCode.VALIDATION_AT_LEAST_ONE_IMAGE,
      });
    });

    it('allows a name edit on a published Box even after a product drifted to archived', async () => {
      boxModel.findById.mockReturnValue(query(boxDoc({ published: true })));
      boxModel.findOneAndUpdate.mockReturnValue(
        query(boxDoc({ published: true, nameEn: 'Renamed' })),
      );

      await service.update('box-id', { nameEn: 'Renamed' } as any, store);
      expect(boxModel.findOneAndUpdate).toHaveBeenCalled();
    });

    it('re-validates publishability when eligibility changes on a published Box', async () => {
      boxModel.findById.mockReturnValue(query(boxDoc({ published: true })));
      productModel.find.mockReturnValue(query([product({ isArchived: true })]));

      await expect(
        service.update(
          'box-id',
          {
            eligibleItems: [
              { productId: String(productId), variantIds: [String(variantId1)] },
            ],
          } as any,
          store,
        ),
      ).rejects.toMatchObject({
        errorCode: AppErrorCode.BOX_ELIGIBLE_PRODUCT_INVALID,
      });
    });
  });

  describe('duplicate', () => {
    it('copies eligibility into a new unpublished draft', async () => {
      boxModel.findById.mockReturnValue(query(boxDoc()));
      await service.duplicate('box-id', store);

      const payload = boxModel.mock.calls[0][0];
      expect(payload.published).toBe(false);
      expect(payload.isArchived).toBe(false);
      expect(payload.slug).toMatch(/copy/);
      expect(payload.eligibleItems[0].variantIds).toHaveLength(2);
    });
  });

  describe('archive / restore / remove', () => {
    it('archives via a conditional claim', async () => {
      boxModel.findById.mockReturnValue(query(boxDoc()));
      boxModel.findOneAndUpdate.mockReturnValue(query(boxDoc({ isArchived: true })));
      const result = await service.archive('box-id', store, 'owner@test.com');
      expect(result.archived).toBe(true);
      boxModel.findOneAndUpdate.mock.calls[0][1].$set.isArchived = true;
      expect(boxModel.findOneAndUpdate.mock.calls[0][0].isArchived).toEqual({ $ne: true });
    });

    it('restores only an archived Box', async () => {
      boxModel.findById.mockReturnValue(query(boxDoc({ isArchived: true })));
      boxModel.findOneAndUpdate.mockReturnValue(query(boxDoc({ isArchived: false })));
      const result = await service.restore('box-id', store);
      expect(result.archived).toBe(false);
    });

    it('refuses a hard delete while an active order references the Box', async () => {
      boxModel.findById.mockReturnValue(query(boxDoc()));
      orderModel.countDocuments.mockReturnValue(query(2));

      await expect(service.remove('box-id', store)).rejects.toMatchObject({
        errorCode: AppErrorCode.BOX_CANNOT_DELETE_HAS_ORDERS,
      });
      expect(boxModel.findOneAndDelete).not.toHaveBeenCalled();
    });

    it('deletes when only archived/deleted orders remain', async () => {
      boxModel.findById.mockReturnValue(query(boxDoc()));
      orderModel.countDocuments.mockReturnValue(query(0));
      boxModel.findOneAndDelete.mockReturnValue(query(boxDoc()));

      const result = await service.remove('box-id', store);
      expect(result.deleted).toBe(true);
      expect(orderModel.countDocuments.mock.calls[0][0]).toMatchObject({
        isDeleted: { $ne: true },
        isArchived: { $ne: true },
      });
    });
  });

  describe('vendor listing', () => {
    it('scopes to the store and excludes archived boxes by default', async () => {
      boxModel.countDocuments.mockReturnValue(query(1));
      boxModel.find.mockReturnValue(query([boxDoc()]));

      const result = await service.findVendorPage(String(storeId), {});
      expect(result.total).toBe(1);
      expect(result.boxes[0].availableBoxes).toBe(4); // floor((5+4)/2)
      const filter = boxModel.find.mock.calls[0][0];
      expect(filter.storeId).toBeInstanceOf(Types.ObjectId);
      expect(filter.isArchived).toEqual({ $ne: true });
    });

    it('shows archived boxes only when the archived filter is selected', async () => {
      boxModel.find.mockReturnValue(query([]));
      await service.findVendorPage(String(storeId), { status: 'archived' });
      expect(boxModel.find.mock.calls[0][0].isArchived).toBe(true);
    });
  });

  describe('findOneForVendor', () => {
    it('reports drift instead of throwing when an eligible product is archived', async () => {
      boxModel.findById.mockReturnValue(query(boxDoc()));
      productModel.find.mockReturnValue(
        query([product({ isArchived: true })]),
      );

      const detail = await service.findOneForVendor('box-id', String(storeId));
      expect(detail.eligibleItems).toHaveLength(1);
      expect(detail.eligibleItems[0].productArchived).toBe(true);
      expect(detail.publishIssues.map((i) => i.code)).toContain(
        AppErrorCode.BOX_ELIGIBLE_PRODUCT_INVALID,
      );
    });
  });

  describe('publicList', () => {
    it('filters published/non-archived, excludes empty boxes and computes availability', async () => {
      const withItems = boxDoc();
      const withoutItems = boxDoc({
        _id: new Types.ObjectId(),
        eligibleItems: [],
      });
      boxModel.find.mockReturnValue(query([withItems, withoutItems]));

      const result = await service.publicList({
        storeId: String(storeId),
      } as any);

      const conditions = boxModel.find.mock.calls[0][0].$and;
      expect(conditions[0]).toMatchObject({
        published: true,
        isArchived: { $ne: true },
      });
      expect(result.boxes).toHaveLength(1);
      expect(result.boxes[0].availableBoxes).toBe(4);
      expect(result.boxes[0].bestReferenceTotal).toBe(800);
    });
  });

  describe('publicDetail', () => {
    it('keeps a sold-out eligible variant visible with available: 0', async () => {
      const doc = boxDoc();
      const slugId = `${doc.slug}--${String(doc._id).slice(-8)}`;
      boxModel.findOne.mockReturnValue(query(doc));
      reservationsService.getAvailabilityForVariants.mockResolvedValue(
        new Map([
          [String(variantId1), 0],
          [String(variantId2), 4],
        ]),
      );

      const detail = await service.publicDetail(slugId);
      expect(detail.eligibleItems).toHaveLength(2);
      const soldOut = detail.eligibleItems.find(
        (item) => item.variantId === String(variantId1),
      );
      expect(soldOut).toMatchObject({ available: 0, isAvailable: false });
      expect(detail.isAvailable).toBe(true);
      expect(detail.storeName).toBe('Test');
    });
  });

  describe('validateSelection', () => {
    it('validates read-only and never writes', async () => {
      const doc = boxDoc();
      const slugId = `${doc.slug}--${String(doc._id).slice(-8)}`;
      boxModel.findOne.mockReturnValue(query(doc));

      const valid = await service.validateSelection(slugId, [
        { variantId: String(variantId1), quantity: 1 },
        { variantId: String(variantId2), quantity: 1 },
      ]);
      expect(valid.valid).toBe(true);
      expect(valid.issues).toEqual([]);
      expect(valid.referenceTotal).toBe(800);
      expect(valid.savings).toBe(0);

      const invalid = await service.validateSelection(slugId, [
        { variantId: String(variantId1), quantity: 1 },
      ]);
      expect(invalid.valid).toBe(false);
      expect(invalid.issues).toContain('BOX_SELECTION_INVALID');

      expect(boxModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(boxModel.findOneAndDelete).not.toHaveBeenCalled();
      expect(boxModel).not.toHaveBeenCalled();
    });
  });
});
