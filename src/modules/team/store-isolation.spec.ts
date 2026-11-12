import { Types } from 'mongoose';
import { StoresService } from '../stores/stores.service';
import { StoreAccessService } from './store-access.service';
import { StoreRole, StoreMemberStatus } from '../../common/constants/store-roles.enum';
import { PosController } from '../pos/pos.controller';

function q<T>(result: T): any {
  const chain: any = {
    select: () => chain,
    lean: () => chain,
    exec: async () => result,
  };
  return chain;
}

describe('Store isolation', () => {
  const storeA = new Types.ObjectId();
  const storeB = new Types.ObjectId();
  const userId = new Types.ObjectId();

  function makeStoresService() {
    const storeModel = {
      findById: jest.fn((id: any) =>
        String(id) === String(storeA)
          ? { exec: async () => ({ _id: storeA, vendorEmail: 'a@store.test', status: 'Active' }) }
          : { exec: async () => null },
      ),
      findOne: jest.fn(() => q(null)),
    };
    const memberModel = {
      findOne: jest.fn(() =>
        q({ storeId: storeA, role: StoreRole.ORDER_CONFIRMER, permissionOverrides: [] }),
      ),
    };
    const service = new StoresService(
      storeModel as any,
      {} as any,
      {} as any,
      {} as any,
      memberModel as any,
      {} as any,
    );
    return { service, memberModel };
  }

  it('resolves the employee membership store and never a client-named store', async () => {
    const { service } = makeStoresService();
    const found = await service.findByMemberId(String(userId));
    expect(String(found?._id)).toBe(String(storeA));
    expect(String(found?._id)).not.toBe(String(storeB));
  });

  it('does not resolve a store after the membership is deactivated', async () => {
    const { service, memberModel } = makeStoresService();
    memberModel.findOne.mockReturnValue(q(null)); // no active membership
    const found = await service.findByMemberId(String(userId));
    expect(found).toBeNull();
  });

  it('StoreAccessService scopes an active employee to store A only', async () => {
    const memberModel = {
      findOne: jest.fn((filter: any) =>
        q(
          filter?.status === StoreMemberStatus.DEACTIVATED
            ? null
            : { _id: new Types.ObjectId(), storeId: storeA, role: StoreRole.CASHIER, permissionOverrides: [] },
        ),
      ),
    };
    const storesService = {
      findOne: jest.fn(async (id: string) =>
        String(id) === String(storeA) ? { _id: storeA } : null,
      ),
      findByVendorId: jest.fn().mockResolvedValue(null),
    };
    const accessService = new StoreAccessService(memberModel as any, storesService as any);

    const access = await accessService.resolveForUserOrThrow({ id: String(userId), role: 'VENDOR' });
    expect(String(access.storeId)).toBe(String(storeA));
    expect(access.permissions).toContain('pos.access');
    expect(access.permissions).not.toContain('orders.confirm');
  });

  it('POS resolves the store from the session and ignores a body storeId', async () => {
    const storesService = {
      findByMemberIdOrThrow: jest.fn().mockResolvedValue({ _id: storeA }),
    };
    const posService = { searchProducts: jest.fn().mockResolvedValue({ products: [] }) };
    const ordersService = {};
    const controller = new PosController(
      posService as any,
      storesService as any,
      ordersService as any,
    );

    const req: any = {
      user: { id: String(userId), role: 'VENDOR' },
      body: { storeId: String(storeB) },
      query: {},
    };

    await controller.search({} as any, req);

    expect(storesService.findByMemberIdOrThrow).toHaveBeenCalledWith(String(userId));
    expect(posService.searchProducts).toHaveBeenCalledWith(storeA, expect.anything());
    expect(posService.searchProducts.mock.calls[0][0]).not.toBe(storeB);
  });
});
