import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { OrdersController } from './orders.controller';
import { OrdersService, RequestUser } from './orders.service';
import { UpdateVendorOrderDto } from './dto/update-vendor-order.dto';

/**
 * Vendor order-update contract.
 *
 * The dashboard echoes the whole order back on edit, so `UpdateVendorOrderDto` whitelists the
 * immutable, server-owned fields (`storeId`, `id`, `orderNo`, `_id`, `deliveryParcelId`,
 * `deliveryError`, `updatedAt`, `source`) purely so validation does not 400 on them. The
 * controller must strip every one before delegating — otherwise a client could relabel an
 * order's channel (`source`) or re-point its store. This pins that strip (a regression here
 * previously surfaced as `property source should not exist` on every edit).
 */
describe('OrdersController — updateVendor strips server-owned fields', () => {
  let controller: OrdersController;
  let ordersService: { update: jest.Mock };

  const vendor: RequestUser = {
    id: new Types.ObjectId().toString(),
    email: 'vendor@store.test',
    role: 'VENDOR',
    fullName: 'Vendor',
  };

  beforeEach(async () => {
    ordersService = { update: jest.fn().mockResolvedValue({ _id: 'order-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [{ provide: OrdersService, useValue: ordersService }],
    }).compile();

    controller = module.get(OrdersController);
  });

  it('removes source and every other echoed read-only field before calling update', async () => {
    const dto: UpdateVendorOrderDto = {
      source: 'POS',
      storeId: 'store-b',
      id: 'order-1',
      orderNo: 'ORD-1',
      _id: 'order-1',
      deliveryParcelId: 'parcel-9',
      deliveryError: 'boom',
      updatedAt: '2026-10-15T00:00:00.000Z',
      status: 'confirmed',
      expectedUpdatedAt: '2026-10-15T00:00:00.000Z',
    } as any;

    await controller.updateVendor('order-1', dto, { user: vendor });

    expect(ordersService.update).toHaveBeenCalledTimes(1);
    const [id, cleanDto, user] = ordersService.update.mock.calls[0];
    expect(id).toBe('order-1');
    expect(user).toBe(vendor);

    // Every server-owned field is gone…
    for (const key of ['source', 'storeId', 'id', 'orderNo', '_id', 'deliveryParcelId', 'deliveryError', 'updatedAt']) {
      expect(cleanDto).not.toHaveProperty(key);
    }
    // …while genuine edit fields survive.
    expect(cleanDto).toMatchObject({ status: 'confirmed', expectedUpdatedAt: '2026-10-15T00:00:00.000Z' });
  });

  it('leaves a normal edit untouched (no accidental over-stripping)', async () => {
    const dto: UpdateVendorOrderDto = {
      status: 'dispatched',
      customer: { name: 'Ali', phone: '0550000000', wilaya: '16', commune: 'Bab El Oued' },
      total: 2500,
    } as any;

    await controller.updateVendor('order-1', dto, { user: vendor });

    expect(ordersService.update).toHaveBeenCalledWith(
      'order-1',
      { status: 'dispatched', customer: dto.customer, total: 2500 },
      vendor,
    );
  });
});
