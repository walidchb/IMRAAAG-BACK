import { Types } from 'mongoose';
import { StoreAccessService } from './store-access.service';
import {
  StoreMemberStatus,
  StoreRole,
} from '../../common/constants/store-roles.enum';
import { StorePermission } from '../../common/constants/store-permissions.const';

function chain(result: unknown) {
  return {
    select: () => ({ lean: () => ({ exec: async () => result }) }),
    lean: () => ({ exec: async () => result }),
    exec: async () => result,
  };
}

describe('StoreAccessService', () => {
  const userId = new Types.ObjectId().toHexString();
  const storeId = new Types.ObjectId();
  const store = { _id: storeId, vendorEmail: 'owner@store.test', status: 'Active' };

  let memberModel: { findOne: jest.Mock };
  let storesService: { findByVendorId: jest.Mock; findOne: jest.Mock };
  let service: StoreAccessService;

  beforeEach(() => {
    memberModel = { findOne: jest.fn() };
    storesService = {
      findByVendorId: jest.fn().mockResolvedValue(null),
      findOne: jest.fn().mockResolvedValue(store),
    };
    service = new StoreAccessService(memberModel as any, storesService as any);
  });

  it('resolves a legacy owner from Store.vendorId when no membership row exists', async () => {
    memberModel.findOne.mockReturnValue(chain(null));
    storesService.findByVendorId.mockResolvedValue(store);

    const access = await service.resolveForUser(userId, 'VENDOR');

    expect(access).toMatchObject({
      isOwner: true,
      storeRole: StoreRole.OWNER,
      memberId: null,
      storeId,
    });
    expect(access?.permissions).toEqual(['*']);
  });

  it('resolves an active employee membership and its role permissions', async () => {
    memberModel.findOne.mockReturnValue(
      chain({
        _id: new Types.ObjectId(),
        storeId,
        role: StoreRole.ORDER_CONFIRMER,
        permissionOverrides: [],
      }),
    );

    const access = await service.resolveForUser(userId, 'VENDOR');

    expect(access?.isOwner).toBe(false);
    expect(access?.storeRole).toBe(StoreRole.ORDER_CONFIRMER);
    expect(access?.permissions).toContain(StorePermission.ORDERS_CONFIRM);
    expect(access?.permissions).not.toContain(StorePermission.ORDERS_DELETE);
    expect(storesService.findByVendorId).not.toHaveBeenCalled();
  });

  it('replaces the role map when permissionOverrides is non-empty', async () => {
    memberModel.findOne.mockReturnValue(
      chain({
        _id: new Types.ObjectId(),
        storeId,
        role: StoreRole.CASHIER,
        permissionOverrides: ['orders.view'],
      }),
    );

    const access = await service.resolveForUser(userId, 'VENDOR');
    expect(access?.permissions).toEqual(['orders.view']);
  });

  it('does not resolve a deactivated membership and reports revoked access', async () => {
    memberModel.findOne.mockImplementation((filter: any) =>
      chain(filter?.status === StoreMemberStatus.DEACTIVATED ? { _id: new Types.ObjectId() } : null),
    );

    const access = await service.resolveForUser(userId, 'VENDOR');
    expect(access).toBeNull();

    await expect(
      service.resolveForUserOrThrow({ id: userId, role: 'VENDOR' }),
    ).rejects.toMatchObject({ errorCode: 'AUTH_STORE_ACCESS_REVOKED' });
  });

  it('reports STORE_NOT_FOUND when the user was never a member', async () => {
    memberModel.findOne.mockReturnValue(chain(null));

    await expect(
      service.resolveForUserOrThrow({ id: userId, role: 'VENDOR' }),
    ).rejects.toMatchObject({ errorCode: 'STORE_NOT_FOUND' });
  });

  it('gives a platform ADMIN every permission and no tenant by default', async () => {
    const access = await service.resolveForUser(userId, 'ADMIN');

    expect(access?.permissions).toEqual(['*']);
    expect(access?.store).toBeNull();
    expect(access?.isOwner).toBe(false);
  });

  it('honours wildcard and missing permissions', async () => {
    expect(service.hasPermission({ permissions: ['*'] } as any, 'anything')).toBe(true);
    expect(service.hasPermission({ permissions: ['orders.view'] } as any, 'orders.view')).toBe(true);
    expect(service.hasPermission({ permissions: ['orders.view'] } as any, 'orders.delete')).toBe(false);
    expect(service.hasPermission(null, 'orders.view')).toBe(false);
  });

  it('assertPermission denies a missing permission with the permission name', async () => {
    memberModel.findOne.mockReturnValue(
      chain({
        _id: new Types.ObjectId(),
        storeId,
        role: StoreRole.ORDER_CONFIRMER,
        permissionOverrides: [],
      }),
    );

    await expect(
      service.assertPermission({ id: userId, role: 'VENDOR' }, 'orders.delete'),
    ).rejects.toMatchObject({
      errorCode: 'AUTH_INSUFFICIENT_PERMISSIONS',
      errorParams: { permission: 'orders.delete' },
    });
  });
});
