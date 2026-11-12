import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './services/inventory.service';
import { InventoryReadService } from './services/inventory-read.service';
import { MovementsService } from './services/movements.service';
import { StoresService } from '../stores/stores.service';
import { ListInventoryQueryDto } from './dto/inventory-list.dto';

/**
 * Authorization contract for the vendor inventory routes (spec §6).
 *
 * Every route resolves the store from the authenticated session via
 * `StoresService.findByMemberIdOrThrow(user.id)`. A store id in the query string is never
 * part of that path — `ListInventoryQueryDto` does not even carry the field — so Vendor A
 * cannot address Vendor B's inventory by appending `?storeId=...`.
 */

const STORE_ID = new Types.ObjectId();
const OTHER_STORE_ID = new Types.ObjectId();
const VENDOR_ID = new Types.ObjectId().toString();
const VENDOR = { id: VENDOR_ID, email: 'vendor@test.com', role: 'VENDOR' };

describe('InventoryController', () => {
  let controller: InventoryController;

  let storesService: { findByMemberIdOrThrow: jest.Mock };
  let readService: {
    listStoreInventory: jest.Mock;
    getStoreStats: jest.Mock;
    getBalance: jest.Mock;
    variantIdsForProduct: jest.Mock;
  };

  beforeEach(async () => {
    storesService = {
      findByMemberIdOrThrow: jest.fn().mockResolvedValue({ _id: STORE_ID }),
    };
    readService = {
      listStoreInventory: jest.fn().mockResolvedValue({ data: [], total: 0 }),
      getStoreStats: jest.fn().mockResolvedValue({ variantCount: 0 }),
      getBalance: jest.fn(),
      variantIdsForProduct: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InventoryController],
      providers: [
        { provide: InventoryService, useValue: {} },
        { provide: InventoryReadService, useValue: readService },
        { provide: MovementsService, useValue: {} },
        { provide: StoresService, useValue: storesService },
      ],
    }).compile();

    controller = module.get(InventoryController);
  });

  it('scopes the list to the session store', async () => {
    const query: ListInventoryQueryDto = { search: 'shirt', page: 2, limit: 25 };
    await controller.listInventory(query, { user: VENDOR });

    expect(storesService.findByMemberIdOrThrow).toHaveBeenCalledWith(VENDOR_ID);
    expect(readService.listStoreInventory).toHaveBeenCalledWith(STORE_ID, query);
  });

  it('scopes statistics to the session store', async () => {
    await controller.getInventoryStats({ user: VENDOR });

    expect(storesService.findByMemberIdOrThrow).toHaveBeenCalledWith(VENDOR_ID);
    expect(readService.getStoreStats).toHaveBeenCalledWith(STORE_ID);
  });

  it('ignores any store id a client might smuggle into the query', async () => {
    const query = {
      search: '',
      page: 1,
      limit: 25,
      // Not a DTO field (rejected by the whitelist, see inventory-list.dto.spec.ts) — and
      // even if it survived, the service is still handed the session's store.
      storeId: OTHER_STORE_ID.toString(),
    } as ListInventoryQueryDto;

    await controller.listInventory(query, { user: VENDOR });

    expect(readService.listStoreInventory.mock.calls[0][0]).toEqual(STORE_ID);
    expect(readService.listStoreInventory.mock.calls[0][0]).not.toEqual(OTHER_STORE_ID);
  });

  it('propagates the failure when the caller has no store', async () => {
    storesService.findByMemberIdOrThrow.mockRejectedValue(new Error('STORE_NOT_FOUND'));

    await expect(controller.getInventoryStats({ user: VENDOR })).rejects.toThrow(
      'STORE_NOT_FOUND',
    );
    expect(readService.getStoreStats).not.toHaveBeenCalled();
  });
});
