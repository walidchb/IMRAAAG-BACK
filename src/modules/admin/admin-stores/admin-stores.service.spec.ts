import { Types } from 'mongoose';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminStoresService } from './admin-stores.service';
import { UpdateAdminStoreStatusDto } from './dto/update-admin-store-status.dto';
import {
  StoreAdminStatus,
  StoreOwnerStatus,
  StoreStatus,
} from '../../stores/schemas/store-status.enum';

const STORE_ID = '507f1f77bcf86cd799439011';
const VENDOR_ID = '607f1f77bcf86cd799439012';

function execQuery(result: unknown) {
  const q: any = { exec: jest.fn(async () => result) };
  return q;
}

function findQuery(result: unknown) {
  const q: any = {
    sort: jest.fn(() => q),
    skip: jest.fn(() => q),
    limit: jest.fn(() => q),
    lean: jest.fn(() => q),
    select: jest.fn(() => q),
    exec: jest.fn(async () => result),
  };
  return q;
}

function storeDoc(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-01-01T10:00:00.000Z');
  return {
    _id: STORE_ID,
    vendorId: new Types.ObjectId(VENDOR_ID),
    vendorEmail: 'vendor@imraaah.com',
    storeName: 'Atelier',
    storeSlug: 'atelier',
    subdomain: 'atelier',
    wilaya: 'Alger',
    commune: 'Alger Centre',
    status: StoreStatus.ACTIVE,
    contactPhones: [],
    categories: [],
    socialMedia: {},
    inventoryEnabled: true,
    totalProducts: 3,
    totalOrders: 4,
    barcodeSeq: 42,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function ownerDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: VENDOR_ID,
    fullName: 'Walid Owner',
    email: 'owner@imraaah.com',
    phoneNumber: '0550000000',
    role: 'VENDOR',
    isActive: true,
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    lastLogin: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

describe('AdminStoresService', () => {
  let storeModel: any;
  let userModel: any;
  let storesService: any;
  let service: AdminStoresService;

  beforeEach(() => {
    storeModel = {
      find: jest.fn(),
      countDocuments: jest.fn(),
      distinct: jest.fn(),
    };
    userModel = { find: jest.fn() };
    storesService = { findOne: jest.fn(), update: jest.fn(), setAdminStatus: jest.fn() };
    service = new AdminStoresService(storeModel, userModel, storesService);
  });

  it('applies default pagination and createdAt desc sorting', async () => {
    const pageQuery = findQuery([storeDoc()]);
    storeModel.find.mockReturnValue(pageQuery);
    storeModel.countDocuments.mockReturnValue(execQuery(1));
    userModel.find.mockImplementation(() => findQuery([]));

    const result = await service.list({} as any);

    expect(pageQuery.sort).toHaveBeenCalledWith({ createdAt: -1, _id: 1 });
    expect(pageQuery.skip).toHaveBeenCalledWith(0);
    expect(pageQuery.limit).toHaveBeenCalledWith(20);
    expect(result).toMatchObject({ total: 1, page: 1, limit: 20, totalPages: 1 });
    expect(result.items).toHaveLength(1);
  });

  it('combines admin/owner status, wilaya and search through $and', async () => {
    const pageQuery = findQuery([]);
    storeModel.find.mockReturnValue(pageQuery);
    storeModel.countDocuments.mockReturnValue(execQuery(0));
    userModel.find.mockImplementation(() => findQuery([]));

    await service.list({
      adminStatus: StoreAdminStatus.SUSPENDED,
      ownerStatus: StoreOwnerStatus.DISABLED,
      wilaya: 'Oran',
      search: 'abc',
    } as any);

    const filter = storeModel.find.mock.calls[0][0];
    expect(filter.adminStatus).toBe(StoreAdminStatus.SUSPENDED);
    expect(filter.ownerStatus).toBe(StoreOwnerStatus.DISABLED);
    expect(filter.wilaya).toBe('Oran');
    expect(Array.isArray(filter.$and)).toBe(true);
    expect(filter.$and[0].$or[0].storeName.test('abc')).toBe(true);
  });

  it('escapes regex metacharacters in the search term', async () => {
    const pageQuery = findQuery([]);
    storeModel.find.mockReturnValue(pageQuery);
    storeModel.countDocuments.mockReturnValue(execQuery(0));
    userModel.find.mockImplementation(() => findQuery([]));

    await service.list({ search: 'C++ (main) [1]' } as any);

    const filter = storeModel.find.mock.calls[0][0];
    const regex: RegExp = filter.$and[0].$or[0].storeName;
    expect(regex.test('C++ (main) [1]')).toBe(true);
    expect(regex.test('C main 1')).toBe(false);
  });

  it('matches store fields and owner name/email/phone in one search', async () => {
    const pageQuery = findQuery([]);
    storeModel.find.mockReturnValue(pageQuery);
    storeModel.countDocuments.mockReturnValue(execQuery(0));
    userModel.find
      .mockImplementationOnce(() => findQuery([{ _id: VENDOR_ID, email: 'owner@x.com' }]))
      .mockImplementation(() => findQuery([]));

    await service.list({ search: 'owner' } as any);

    const ownerSearch = userModel.find.mock.calls[0][0];
    expect(ownerSearch.$or.map((clause: any) => Object.keys(clause)[0])).toEqual([
      'fullName',
      'email',
      'phoneNumber',
    ]);

    const conditions = storeModel.find.mock.calls[0][0].$and[0].$or;
    expect(conditions.some((clause: any) => clause.storeName)).toBe(true);
    const vendorCond = conditions.find((clause: any) => clause.vendorId);
    expect(vendorCond.vendorId.$in.map(String)).toContain(VENDOR_ID);
    expect(
      conditions.some(
        (clause: any) =>
          Array.isArray(clause.vendorEmail?.$in) && clause.vendorEmail.$in.includes('owner@x.com'),
      ),
    ).toBe(true);
  });

  it('resolves owners for ObjectId and BSON-string vendorId and keeps unlinked rows', async () => {
    const missingStoreId = '507f1f77bcf86cd799439013';
    const docs = [
      storeDoc({ _id: STORE_ID }),
      storeDoc({ _id: new Types.ObjectId(missingStoreId).toHexString(), vendorId: VENDOR_ID }),
      storeDoc({ _id: '507f1f77bcf86cd799439014', vendorId: undefined, vendorEmail: 'ghost@x.com' }),
    ];
    storeModel.find.mockReturnValue(findQuery(docs));
    storeModel.countDocuments.mockReturnValue(execQuery(3));
    userModel.find.mockImplementation((filter: any) => {
      if (filter._id) return findQuery([ownerDoc()]);
      return findQuery([]);
    });

    const result = await service.list({} as any);

    expect(result.items).toHaveLength(3);
    expect(result.items[0].owner?.email).toBe('owner@imraaah.com');
    expect(result.items[1].owner?.email).toBe('owner@imraaah.com');
    expect(result.items[2].owner).toBeNull();
  });

  it('reads Paused/Closed details through skipStatusCheck and never leaks private fields', async () => {
    userModel.find.mockImplementation((filter: any) =>
      filter._id ? findQuery([ownerDoc()]) : findQuery([]),
    );

    for (const status of [StoreStatus.PAUSED, StoreStatus.CLOSED]) {
      storesService.findOne.mockResolvedValue(storeDoc({ status }));
      const result = await service.get(STORE_ID);

      expect(storesService.findOne).toHaveBeenCalledWith(STORE_ID, { skipStatusCheck: true });
      expect(result.store.status).toBe(status);
      expect(result.owner?.email).toBe('owner@imraaah.com');
      expect((result.store as any).barcodeSeq).toBeUndefined();
      expect((result.store as any).vendorId).toBeUndefined();
      expect((result.owner as any)?.password).toBeUndefined();
      expect((result.owner as any)?.refreshToken).toBeUndefined();
    }
  });

  it('delegates the admin status write with the acting admin and reason', async () => {
    const suspended = storeDoc({
      status: StoreStatus.CLOSED,
      ownerStatus: StoreOwnerStatus.ENABLED,
      adminStatus: StoreAdminStatus.SUSPENDED,
      adminStatusReason: 'Policy review',
      adminStatusChangedByEmail: 'admin@imraaah.com',
    });
    storesService.setAdminStatus.mockResolvedValue(suspended);

    const result = await service.updateStatus(
      STORE_ID,
      StoreAdminStatus.SUSPENDED,
      { id: 'admin-1', email: 'admin@imraaah.com' },
      'Policy review',
    );

    expect(storesService.setAdminStatus).toHaveBeenCalledWith(STORE_ID, {
      adminStatus: StoreAdminStatus.SUSPENDED,
      actor: { id: 'admin-1', email: 'admin@imraaah.com' },
      reason: 'Policy review',
    });
    expect(result.store.adminStatus).toBe(StoreAdminStatus.SUSPENDED);
    expect(result.store.adminStatusReason).toBe('Policy review');
    expect(result.store.isAvailable).toBe(false);
  });

  it('clears the reason when reactivating', async () => {
    const active = storeDoc({
      status: StoreStatus.ACTIVE,
      ownerStatus: StoreOwnerStatus.ENABLED,
      adminStatus: StoreAdminStatus.ACTIVE,
    });
    storesService.setAdminStatus.mockResolvedValue(active);

    await service.updateStatus(
      STORE_ID,
      StoreAdminStatus.ACTIVE,
      { id: 'admin-1', email: 'admin@imraaah.com' },
      'stale reason',
    );

    expect(storesService.setAdminStatus).toHaveBeenCalledWith(STORE_ID, {
      adminStatus: StoreAdminStatus.ACTIVE,
      actor: { id: 'admin-1', email: 'admin@imraaah.com' },
      reason: null,
    });
  });

  it('rejects the legacy status values in the admin DTO', async () => {
    const closed = plainToInstance(UpdateAdminStoreStatusDto, { adminStatus: 'Closed' });
    const closedErrors = await validate(closed);
    expect(closedErrors.some((error) => error.property === 'adminStatus')).toBe(true);

    const suspended = plainToInstance(UpdateAdminStoreStatusDto, {
      adminStatus: StoreAdminStatus.SUSPENDED,
      reason: 'Policy review',
    });
    const suspendedErrors = await validate(suspended);
    expect(suspendedErrors).toHaveLength(0);
  });
});
