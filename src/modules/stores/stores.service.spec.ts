import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { StoresService } from './stores.service';
import { Store } from './schemas/store.schema';
import { Product } from '../products/schemas/product.schema';
import { StoreStatus } from './schemas/store-status.enum';
import { UploadService } from '../upload/upload.service';
import { AppErrorCode } from '../../common/errors/error-codes.enum';

/**
 * Coverage for store -> vendor ownership resolution.
 *
 * This exists because of a real production-shaped bug. `Store.vendorId` is declared as
 * an ObjectId, so `findByVendorIdOrThrow()` queried with an ObjectId. Some rows had been
 * written by a raw-driver script that bypassed Mongoose casting and stored the same 24 hex
 * characters as a BSON **string**. MongoDB compares by BSON type, so the query silently
 * missed and `GET /api/tracking/config` returned 404 STORE_NOT_FOUND - a vendor locked out
 * of their own pixel settings.
 *
 * These tests pin both halves of the fix: the lookup must tolerate both shapes, and
 * `create()` must never produce a third one.
 */

const VENDOR_USER_ID = new Types.ObjectId();
const OTHER_USER_ID = new Types.ObjectId();

const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

const activeStore = (overrides: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  vendorId: VENDOR_USER_ID,
  vendorEmail: 'vendor@test.com',
  storeName: 'Vendor Store',
  status: StoreStatus.ACTIVE,
  ...overrides,
});

describe('StoresService', () => {
  let service: StoresService;
  let storeModel: any;
  let productModel: any;

  beforeEach(async () => {
    // A single jest.fn() acts as both the model constructor (`new this.storeModel(...)`)
    // and the query surface (`this.storeModel.findOne(...)`), so `create()` and the
    // finders are both drivable from one stub.
    const model: any = jest.fn();
    model.findOne = jest.fn().mockReturnValue(query(null));
    model.findById = jest.fn().mockReturnValue(query(null));
    model.find = jest.fn().mockReturnValue(query([]));
    model.prototype.save = jest.fn().mockImplementation(function (this: any) {
      this._id = this._id ?? new Types.ObjectId();
      return Promise.resolve(this);
    });

    productModel = { aggregate: jest.fn().mockReturnValue(query([])) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StoresService,
        { provide: getModelToken(Store.name), useValue: model },
        { provide: getModelToken(Product.name), useValue: productModel },
        { provide: UploadService, useValue: {} },
      ],
    }).compile();

    service = module.get<StoresService>(StoresService);
    storeModel = module.get(getModelToken(Store.name));
  });

  describe('findByVendorIdOrThrow - BSON type tolerance (the 404 bug)', () => {
    it('matches a store whose vendorId is a real ObjectId', async () => {
      const store = activeStore();
      storeModel.findOne = jest.fn().mockReturnValue(query(store));

      const found = await service.findByVendorIdOrThrow(VENDOR_USER_ID.toString());

      expect(found).toBe(store);
      const filter = storeModel.findOne.mock.calls[0][0];
      expect(filter.vendorId.$in).toContainEqual(new Types.ObjectId(VENDOR_USER_ID.toString()));
    });

    it('matches a store whose vendorId is a BSON string (the regression that shipped)', async () => {
      // The vendor that hit 404: correct hex, wrong BSON type.
      const store = activeStore({ vendorId: VENDOR_USER_ID.toString() });
      storeModel.findOne = jest.fn().mockReturnValue(query(store));

      const found = await service.findByVendorIdOrThrow(VENDOR_USER_ID.toString());

      expect(found).toBe(store);
      const filter = storeModel.findOne.mock.calls[0][0];
      expect(filter.vendorId.$in).toContain(VENDOR_USER_ID.toString());
    });

    it('never widens the filter beyond the requested vendor (the tolerance is not a wildcard)', async () => {
      // The point of the two-branch filter is type tolerance, not a second lookup. It must
      // contain exactly two entries - the same id in both BSON shapes - and nothing else.
      storeModel.findOne = jest.fn().mockReturnValue(query(null));

      await expect(service.findByVendorIdOrThrow(OTHER_USER_ID.toString())).rejects.toMatchObject({
        errorCode: AppErrorCode.STORE_NOT_FOUND,
      });

      const branches = storeModel.findOne.mock.calls[0][0].vendorId.$in;
      expect(branches).toHaveLength(2);
      expect(branches).toContainEqual(new Types.ObjectId(OTHER_USER_ID.toString()));
      expect(branches).toContain(OTHER_USER_ID.toString());
      expect(branches).toEqual(
        expect.not.arrayContaining([VENDOR_USER_ID, VENDOR_USER_ID.toString()]),
      );
    });

    it('rejects a malformed id without querying the database', async () => {
      storeModel.findOne = jest.fn();

      await expect(service.findByVendorIdOrThrow('not-an-object-id')).rejects.toMatchObject({
        errorCode: AppErrorCode.STORE_NOT_FOUND,
      });
      expect(storeModel.findOne).not.toHaveBeenCalled();
    });

    it('rejects an empty id', async () => {
      storeModel.findOne = jest.fn();

      await expect(service.findByVendorIdOrThrow('')).rejects.toMatchObject({
        errorCode: AppErrorCode.STORE_NOT_FOUND,
      });
      expect(storeModel.findOne).not.toHaveBeenCalled();
    });

    it('still enforces the status check', async () => {
      const paused = activeStore({ status: StoreStatus.PAUSED });
      storeModel.findOne = jest.fn().mockReturnValue(query(paused));

      await expect(service.findByVendorIdOrThrow(VENDOR_USER_ID.toString())).rejects.toMatchObject({
        errorCode: AppErrorCode.STORE_NOT_ACTIVE,
      });
    });

    it('skips the status check when asked', async () => {
      const paused = activeStore({ status: StoreStatus.PAUSED });
      storeModel.findOne = jest.fn().mockReturnValue(query(paused));

      await expect(
        service.findByVendorIdOrThrow(VENDOR_USER_ID.toString(), { skipStatusCheck: true }),
      ).resolves.toBe(paused);
    });
  });

  describe('findByVendorId - non-throwing variant', () => {
    it('returns null rather than throwing when there is no store', async () => {
      storeModel.findOne = jest.fn().mockReturnValue(query(null));

      await expect(service.findByVendorId(VENDOR_USER_ID.toString())).resolves.toBeNull();
    });

    it('returns null for a malformed id without querying', async () => {
      storeModel.findOne = jest.fn();

      await expect(service.findByVendorId('nope')).resolves.toBeNull();
      expect(storeModel.findOne).not.toHaveBeenCalled();
    });

    it('tolerates the BSON string form, same as the throwing variant', async () => {
      const store = activeStore({ vendorId: VENDOR_USER_ID.toString() });
      storeModel.findOne = jest.fn().mockReturnValue(query(store));

      await expect(service.findByVendorId(VENDOR_USER_ID.toString())).resolves.toBe(store);
    });
  });

  describe('create - ownership is passed in, not trusted from the body', () => {
    const dto = () => ({
      vendorEmail: 'vendor@test.com',
      storeName: 'Vendor Store',
      description: 'A store',
    }) as any;

    beforeEach(() => {
      // No existing store, by default.
      storeModel.findOne = jest.fn().mockReturnValue(query(null));
    });

    it('stores vendorId as a real ObjectId, never a string', async () => {
      await service.create(dto(), VENDOR_USER_ID.toString());

      const doc = (service['storeModel'] as any).mock.calls[0][0];
      expect(doc.vendorId).toBeInstanceOf(Types.ObjectId);
      expect(doc.vendorId.toString()).toBe(VENDOR_USER_ID.toString());
    });

    it('never copies a vendorId supplied on the DTO', async () => {
      // `vendorId` was removed from CreateStoreDto precisely so it cannot be injected.
      // If a future refactor re-adds it, this catches the escalation coming back.
      const malicious = { ...dto(), vendorId: OTHER_USER_ID.toString() };

      await service.create(malicious, VENDOR_USER_ID.toString());

      const doc = (service['storeModel'] as any).mock.calls[0][0];
      expect(doc.vendorId.toString()).toBe(VENDOR_USER_ID.toString());
      expect(doc.vendorId.toString()).not.toBe(OTHER_USER_ID.toString());
    });

    it('creates an unlinked store when no vendorId is supplied (admin route)', async () => {
      await service.create(dto());

      const doc = (service['storeModel'] as any).mock.calls[0][0];
      expect(doc.vendorId).toBeUndefined();
    });

    it('rejects a malformed vendorId instead of writing it', async () => {
      await expect(service.create(dto(), 'not-an-object-id')).rejects.toMatchObject({
        errorCode: AppErrorCode.VALIDATION_INVALID_ID,
      });
    });

    it('refuses a second store for the same vendor', async () => {
      storeModel.findOne = jest
        .fn()
        .mockReturnValueOnce(query(null)) // vendorEmail check
        .mockReturnValueOnce(query(activeStore())); // vendorId check

      await expect(service.create(dto(), VENDOR_USER_ID.toString())).rejects.toMatchObject({
        errorCode: AppErrorCode.STORE_ALREADY_EXISTS,
      });
    });

    it('refuses a duplicate vendorEmail', async () => {
      storeModel.findOne = jest.fn().mockReturnValue(query(activeStore()));

      await expect(service.create(dto(), VENDOR_USER_ID.toString())).rejects.toMatchObject({
        errorCode: AppErrorCode.STORE_ALREADY_EXISTS,
      });
    });

    it('lowercases vendorEmail', async () => {
      await service.create({ ...dto(), vendorEmail: 'Vendor@Test.COM' }, VENDOR_USER_ID.toString());

      const doc = (service['storeModel'] as any).mock.calls[0][0];
      expect(doc.vendorEmail).toBe('vendor@test.com');
    });

    it('requires a vendorEmail', async () => {
      await expect(service.create({ ...dto(), vendorEmail: '' })).rejects.toMatchObject({
        errorCode: AppErrorCode.STORE_VENDOR_EMAIL_REQUIRED,
      });
    });
  });

  describe('findAll - public product counts', () => {
    it('replaces the stale totalProducts counter with a live published count', async () => {
      const store = activeStore({ totalProducts: 5 });
      storeModel.find = jest.fn().mockReturnValue(query([store]));
      productModel.aggregate = jest
        .fn()
        .mockReturnValue(query([{ _id: store._id, count: 12 }]));

      const result = await service.findAll({ limit: 10 });

      expect(result.stores[0].totalProducts).toBe(12);
      expect(productModel.aggregate).toHaveBeenCalledWith([
        { $match: { storeId: { $in: [store._id] }, published: true } },
        { $group: { _id: '$storeId', count: { $sum: 1 } } },
      ]);
    });

    it('reports zero when the store has no published products', async () => {
      const store = activeStore({ totalProducts: 5 });
      storeModel.find = jest.fn().mockReturnValue(query([store]));
      productModel.aggregate = jest.fn().mockReturnValue(query([]));

      const result = await service.findAll({ limit: 10 });

      expect(result.stores[0].totalProducts).toBe(0);
    });
  });

  describe('incrementProductCount - the HI-2 counter primitive', () => {
    beforeEach(() => {
      storeModel.updateOne = jest.fn().mockReturnValue(query({ matchedCount: 1, modifiedCount: 1 }));
    });

    it('applies a +1 $inc keyed on the lowercased vendorEmail', async () => {
      await service.incrementProductCount('Vendor@Test.COM', 1);

      expect(storeModel.updateOne).toHaveBeenCalledWith(
        { vendorEmail: 'vendor@test.com' },
        { $inc: { totalProducts: 1 } },
      );
    });

    it('accepts the negative delta the product-create rollback uses', async () => {
      // products.service.create() compensates a failed default-variant factory with -1;
      // the two calls must address the same document or the count drifts.
      await service.incrementProductCount('vendor@test.com', -1);

      expect(storeModel.updateOne).toHaveBeenCalledWith(
        { vendorEmail: 'vendor@test.com' },
        { $inc: { totalProducts: -1 } },
      );
    });

    it('defaults to +1 when no delta is given', async () => {
      await service.incrementProductCount('vendor@test.com');

      expect(storeModel.updateOne).toHaveBeenCalledWith(
        { vendorEmail: 'vendor@test.com' },
        { $inc: { totalProducts: 1 } },
      );
    });

    it('never touches the order counter', async () => {
      await service.incrementProductCount('vendor@test.com', 1);

      const update = storeModel.updateOne.mock.calls[0][1];
      expect(update.$inc).not.toHaveProperty('totalOrders');
    });
  });
});
