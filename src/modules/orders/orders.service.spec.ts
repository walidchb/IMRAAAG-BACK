import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { OrdersService, RequestUser } from './orders.service';
import { Order } from './schemas/order.schema';
import { Counter } from './schemas/counter.schema';
import { PosHold } from './schemas/pos-hold.schema';
import { Product } from '../products/schemas/product.schema';
import { DeliveryService } from '../delivery/delivery.service';
import { DeliveryFeesService } from '../delivery-fees/delivery-fees.service';
import { AuditService } from '../audit/audit.service';
import { OrderStatusesService } from './order-statuses.service';
import { StoresService } from '../stores/stores.service';
import { ReservationsService } from '../inventory/services/reservations.service';
import { VariantsService } from '../inventory/services/variants.service';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { AppException } from '../../common/errors/app-exception';
import { UpdateOrderDto } from './dto/update-order.dto';
import { ORDER_STATUS_TRANSITIONS, OrderStatus, StatusConfig } from '../../common/constants/order-statuses.const';

/**
 * Order-mutation correctness (D-1 through D-5 of the inventory roadmap).
 *
 * The tests are written against the claims the code makes in its own comments, because each
 * one is a concurrency or data-integrity defect that a happy-path test cannot see:
 *
 *  - D-1: a status transition is a *conditional* write on the status it moves from, so two
 *    concurrent saves cannot both win; the loser gets ORDER_CONFLICT, not a silent overwrite.
 *  - D-2: bulk actions claim per order rather than bulk-writing an unconditional filter.
 *  - D-3: ownership keys on `storeId`, with `vendorEmail` only as the pre-migration fallback.
 *  - D-4: `expectedUpdatedAt` is a real optimistic-concurrency guard, not advisory.
 *  - D-5: `items` are immutable once the order leaves the editable window (`placed`, then
 *    `confirmed` — whose edit reconciles the reservation rather than being refused).
 *
 * The transaction session is faked with the same shape the driver exposes, so "the status
 * claim and its inventory effect commit together" is assertable: one session object is
 * handed to both the claim and `onStatusChange`, and a failed reservation aborts and
 * surfaces instead of leaving the order marked confirmed with nothing reserved.
 */

const ORDER_ID = new Types.ObjectId();
const STORE_ID = new Types.ObjectId();
const OTHER_STORE_ID = new Types.ObjectId();
const VARIANT_ID = new Types.ObjectId();

const VENDOR_USER: RequestUser = {
  id: new Types.ObjectId().toString(),
  email: 'vendor@test.com',
  role: 'VENDOR',
  fullName: 'Vendor',
};

const ADMIN_USER: RequestUser = {
  id: new Types.ObjectId().toString(),
  email: 'admin@test.com',
  role: 'ADMIN',
  fullName: 'Admin',
};

/** A query-chain stub: every mongoose builder method returns itself, `.exec()` resolves. */
const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate', 'session', 'updateOne']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

/** A fake driver session: `withTransaction` commits on success, aborts and rethrows on failure. */
const makeSession = () => {
  const s: any = {};
  s.startTransaction = jest.fn().mockResolvedValue(undefined);
  s.abortTransaction = jest.fn().mockResolvedValue(undefined);
  s.endSession = jest.fn().mockResolvedValue(undefined);
  s.withTransaction = jest.fn(async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      await s.abortTransaction();
      throw err;
    }
  });
  return s;
};

const statusConfig = (slug: string): StatusConfig => ({
  _id: new Types.ObjectId().toString(),
  slug,
  displayName: slug,
  nameEn: slug,
  nameFr: slug,
  nameAr: slug,
  color: '#000000',
  sortOrder: 1,
});

const makeOrder = (over: Record<string, any> = {}) => ({
  _id: ORDER_ID,
  orderNo: 'ORD-2026-000001',
  vendorEmail: VENDOR_USER.email,
  storeId: STORE_ID,
  status: statusConfig(OrderStatus.PLACED),
  items: [{ productId: 'p-1', productName: 'Product', quantity: 2, price: 50, variantId: VARIANT_ID.toString() }],
  customer: { name: 'Customer', phone: '0550000000', wilaya: '16', commune: 'Alger', address: 'Somewhere' },
  shippingMethod: 'stopdesk',
  shippingFee: 400,
  total: 500,
  isDeleted: false,
  history: [],
  ...over,
});

describe('OrdersService', () => {
  let service: OrdersService;

  let orderModel: any;
  let counterModel: any;
  let posHoldModel: any;
  let productModel: any;
  let deliveryService: any;
  let deliveryFeesService: any;
  let statusesService: any;
  let storesService: any;
  let reservationsService: any;
  let variantsService: any;
  let sessions: any[];

  beforeEach(async () => {
    sessions = [];

    orderModel = {
      find: jest.fn(),
      findOne: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn(),
      updateMany: jest.fn(),
      startSession: jest.fn(() => {
        const s = makeSession();
        sessions.push(s);
        return s;
      }),
    };

    counterModel = { findOneAndUpdate: jest.fn(), find: jest.fn() };
    posHoldModel = {
      findOne: jest.fn().mockReturnValue(query(undefined)),
      findOneAndUpdate: jest.fn(),
      findOneAndDelete: jest.fn(),
      find: jest.fn(),
      startSession: jest.fn(() => {
        const s = makeSession();
        sessions.push(s);
        return s;
      }),
    };
    productModel = { find: jest.fn(), findById: jest.fn() };

    deliveryService = {
      resolveCompanyForWilaya: jest.fn().mockResolvedValue('company-1'),
      resolveDefaultStopDesk: jest.fn().mockResolvedValue(null),
      assertCanCreateDelivery: jest.fn(),
      createDeliveryForOrder: jest.fn().mockResolvedValue({ parcelId: 'PARCEL-1' }),
      createBulkDeliveriesForOrders: jest.fn().mockResolvedValue([]),
    };

    deliveryFeesService = {
      getFeeByStoreId: jest.fn().mockResolvedValue({
        wilayaCode: '16',
        homeDeliveryFee: 600,
        stopDeskDeliveryFee: 400,
      }),
    };

    statusesService = {
      // The real table, so the legality of each transition is exercised rather than assumed.
      validateTransition: jest.fn((current: string, next: string) => {
        const allowed = ORDER_STATUS_TRANSITIONS[current];
        if (!allowed || !allowed.includes(next)) {
          throw new AppException(AppErrorCode.ORDER_CANNOT_TRANSITION, { current, next });
        }
      }),
      getBySlug: jest.fn(async (slug: string) => statusConfig(slug)),
      getTransitions: jest.fn(() => ORDER_STATUS_TRANSITIONS),
    };

    storesService = {
      findByVendorId: jest.fn().mockResolvedValue(null),
      findByVendorIdOrThrow: jest.fn(),
      resolveStoreIdByEmail: jest.fn().mockResolvedValue(null),
    };

    reservationsService = {
      onStatusChange: jest.fn().mockResolvedValue(undefined),
      reserve: jest.fn(),
      release: jest.fn(),
      consume: jest.fn(),
      describeOrder: jest.fn(),
      checkAdvisoryAvailability: jest.fn().mockResolvedValue([]),
      assertLinesInStock: jest.fn().mockResolvedValue(undefined),
      reconcileEditedLines: jest.fn().mockResolvedValue(undefined),
    };

    variantsService = {} as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: getModelToken(Order.name), useValue: orderModel },
        { provide: getModelToken(Counter.name), useValue: counterModel },
        { provide: getModelToken(PosHold.name), useValue: posHoldModel },
        { provide: getModelToken(Product.name), useValue: productModel },
        { provide: DeliveryService, useValue: deliveryService },
        { provide: DeliveryFeesService, useValue: deliveryFeesService },
        { provide: OrderStatusesService, useValue: statusesService },
        { provide: StoresService, useValue: storesService },
        { provide: ReservationsService, useValue: reservationsService },
        { provide: VariantsService, useValue: variantsService },
        { provide: AuditService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  describe('update() — D-1 atomic status claim', () => {
    it('ignores ownership and audit fields supplied by the client (H11)', async () => {
      const existing = makeOrder();
      const updated = makeOrder();
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findByIdAndUpdate.mockReturnValue(query(updated));

      await service.update(ORDER_ID.toString(), {
        vendorEmail: 'attacker@store.test',
        createdAt: '2001-01-01T00:00:00.000Z',
        confirmedAt: '2001-01-02T00:00:00.000Z',
        createdBy: 'Someone Else',
        statusConfirmation: 'forged',
        customer: { name: 'Real Customer' },
      } as UpdateOrderDto);

      const write = orderModel.findByIdAndUpdate.mock.calls[0][1];
      // Server-owned columns never reach the update document…
      expect(write.vendorEmail).toBeUndefined();
      expect(write.createdAt).toBeUndefined();
      expect(write.confirmedAt).toBeUndefined();
      expect(write.createdBy).toBeUndefined();
      expect(write.statusConfirmation).toBeUndefined();
      // …while a legitimate editable field still does.
      expect(write.customer).toEqual({ name: 'Real Customer' });
      expect(write.updatedAt).toBeInstanceOf(Date);
    });

    it('claims a transition with a predicate on the status it moves from', async () => {
      const existing = makeOrder();
      const claimed = makeOrder({ status: statusConfig(OrderStatus.CONFIRMED) });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findOneAndUpdate.mockReturnValue(query(claimed));

      await service.update(ORDER_ID.toString(), { status: OrderStatus.CONFIRMED } as UpdateOrderDto);

      expect(orderModel.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: ORDER_ID.toString(),
          $or: [{ 'status.slug': OrderStatus.PLACED }, { status: OrderStatus.PLACED }],
        },
        expect.any(Object),
        expect.objectContaining({ new: true, session: sessions[1] }),
      );
      expect(orderModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('runs the claim and its inventory effect inside one shared session', async () => {
      const existing = makeOrder();
      const claimed = makeOrder({ status: statusConfig(OrderStatus.CONFIRMED) });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findOneAndUpdate.mockReturnValue(query(claimed));

      await service.update(ORDER_ID.toString(), { status: OrderStatus.CONFIRMED } as UpdateOrderDto);

      const session = sessions[1];
      expect(session.withTransaction).toHaveBeenCalledTimes(1);
      expect(reservationsService.onStatusChange).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: ORDER_ID,
          orderNo: existing.orderNo,
          storeId: STORE_ID,
          items: [expect.objectContaining({ quantity: 2, variantId: VARIANT_ID.toString() })],
        }),
        OrderStatus.PLACED,
        OrderStatus.CONFIRMED,
        null,
        session,
      );
      // The probe session and the real session are both cleaned up.
      expect(sessions[0].endSession).toHaveBeenCalled();
      expect(session.endSession).toHaveBeenCalled();
    });

    it('reports a lost claim as ORDER_CONFLICT instead of overwriting', async () => {
      const existing = makeOrder();
      const movedOn = makeOrder({ status: statusConfig(OrderStatus.CANCELLED) });
      orderModel.findById.mockReturnValue(query(existing));
      // First findById is the pre-read; second is the post-loss re-read.
      orderModel.findById
        .mockReturnValueOnce(query(existing))
        .mockReturnValueOnce(query(movedOn));
      orderModel.findOneAndUpdate.mockReturnValue(query(null));

      await expect(
        service.update(ORDER_ID.toString(), { status: OrderStatus.CONFIRMED } as UpdateOrderDto),
      ).rejects.toMatchObject({
        errorCode: AppErrorCode.ORDER_CONFLICT,
        errorParams: expect.objectContaining({
          expectedStatus: OrderStatus.PLACED,
          actualStatus: OrderStatus.CANCELLED,
        }),
      });
    });

    it('aborts the whole claim when the reservation fails, and never leaks the session', async () => {
      const existing = makeOrder();
      const claimed = makeOrder({ status: statusConfig(OrderStatus.CONFIRMED) });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findOneAndUpdate.mockReturnValue(query(claimed));
      reservationsService.onStatusChange.mockRejectedValue(
        new AppException(AppErrorCode.INSUFFICIENT_STOCK, { requested: 2, available: 0 }),
      );

      // The order must surface as still-placed: the caller gets a 409 and can retry,
      // rather than a confirmed order whose stock was never reserved.
      await expect(
        service.update(ORDER_ID.toString(), { status: OrderStatus.CONFIRMED } as UpdateOrderDto),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.INSUFFICIENT_STOCK });

      const session = sessions[1];
      expect(session.abortTransaction).toHaveBeenCalled();
      expect(session.endSession).toHaveBeenCalled();
      expect(reservationsService.onStatusChange).toHaveBeenCalled();
    });

    it('claims a non-inventory status without opening a transaction', async () => {
      const existing = makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) });
      const claimed = makeOrder({ status: statusConfig(OrderStatus.IN_TRANSIT) });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findOneAndUpdate.mockReturnValue(query(claimed));

      await service.update(ORDER_ID.toString(), { status: OrderStatus.IN_TRANSIT } as UpdateOrderDto);

      expect(orderModel.startSession).not.toHaveBeenCalled();
      expect(reservationsService.onStatusChange).not.toHaveBeenCalled();
      expect(orderModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ $or: [{ 'status.slug': OrderStatus.DISPATCHED }, { status: OrderStatus.DISPATCHED }] }),
        expect.any(Object),
        expect.objectContaining({ new: true, session: undefined }),
      );
    });

    it('rejects an illegal transition from the real transition table', async () => {
      const existing = makeOrder();
      orderModel.findById.mockReturnValue(query(existing));

      await expect(
        service.update(ORDER_ID.toString(), { status: OrderStatus.DISPATCHED } as UpdateOrderDto),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.ORDER_CANNOT_TRANSITION });

      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(orderModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('refuses to move a cancelled order again', async () => {
      const existing = makeOrder({ status: statusConfig(OrderStatus.CANCELLED) });
      orderModel.findById.mockReturnValue(query(existing));

      await expect(
        service.update(ORDER_ID.toString(), { status: OrderStatus.CONFIRMED } as UpdateOrderDto),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.ORDER_ALREADY_CANCELLED });
    });

    it('refuses to move a delivered order again', async () => {
      const existing = makeOrder({ status: statusConfig(OrderStatus.DELIVERED) });
      orderModel.findById.mockReturnValue(query(existing));

      await expect(
        service.update(ORDER_ID.toString(), { status: OrderStatus.RETURNED } as UpdateOrderDto),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.ORDER_ALREADY_DELIVERED });
    });
  });

  describe('update() — guard rails around a save', () => {
    it('D-5: locks items once the order leaves the editable window', async () => {
      const existing = makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) });
      orderModel.findById.mockReturnValue(query(existing));

      await expect(
        service.update(
          ORDER_ID.toString(),
          { items: [{ productId: 'p-1', productName: 'Product', quantity: 99, price: 1 }] } as UpdateOrderDto,
        ),
      ).rejects.toMatchObject({
        errorCode: AppErrorCode.INVALID_ORDER_TRANSITION,
        errorParams: expect.objectContaining({ reason: 'items_locked_after_placed' }),
      });

      expect(orderModel.findByIdAndUpdate).not.toHaveBeenCalled();
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('refuses an item edit naming a variant with nothing left to ship', async () => {
      orderModel.findById.mockReturnValue(query(makeOrder()));
      reservationsService.assertLinesInStock.mockRejectedValueOnce(
        new AppException(AppErrorCode.ORDER_ITEM_OUT_OF_STOCK, {
          variantId: VARIANT_ID.toString(),
          requested: 1,
          available: 0,
        }),
      );

      await expect(
        service.update(ORDER_ID.toString(), {
          items: [
            { productId: 'p-1', productName: 'Product', quantity: 1, price: 50, variantId: VARIANT_ID.toString() },
          ],
        } as UpdateOrderDto),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.ORDER_ITEM_OUT_OF_STOCK });

      expect(orderModel.findByIdAndUpdate).not.toHaveBeenCalled();
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('hands every item edit to the stock gate before it writes', async () => {
      orderModel.findById.mockReturnValue(query(makeOrder()));
      orderModel.findByIdAndUpdate.mockReturnValue(query(makeOrder()));

      const items = [
        { productId: 'p-1', productName: 'Product', quantity: 2, price: 50, variantId: VARIANT_ID.toString() },
      ];
      await service.update(ORDER_ID.toString(), { items } as UpdateOrderDto);

      expect(reservationsService.assertLinesInStock).toHaveBeenCalledWith(items);
      // A confirmed order never runs the placed-side gate: its own reservation is already
      // netted out of `available`, so the same check would refuse lines it is simply keeping.
      expect(reservationsService.reconcileEditedLines).not.toHaveBeenCalled();
    });

    it('D-4: rejects a save whose expectedUpdatedAt has drifted', async () => {
      const existing = makeOrder({ updatedAt: new Date('2026-01-01T00:00:00.000Z') });
      orderModel.findById.mockReturnValue(query(existing));

      await expect(
        service.update(
          ORDER_ID.toString(),
          { expectedUpdatedAt: '2026-06-01T00:00:00.000Z' } as UpdateOrderDto,
        ),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.ORDER_CONFLICT });

      expect(orderModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('accepts a save whose expectedUpdatedAt matches', async () => {
      const existing = makeOrder({ updatedAt: new Date('2026-01-01T00:00:00.000Z') });
      const updated = makeOrder({ updatedAt: new Date('2026-01-01T00:00:00.000Z') });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findByIdAndUpdate.mockReturnValue(query(updated));

      await service.update(
        ORDER_ID.toString(),
        { expectedUpdatedAt: '2026-01-01T00:00:00.000Z', total: 500 } as UpdateOrderDto,
      );

      expect(orderModel.findByIdAndUpdate).toHaveBeenCalled();
    });

    it('requires wilaya and commune for home delivery', async () => {
      const existing = makeOrder({
        shippingMethod: undefined,
        customer: { name: 'C', phone: '0550000000', address: '' },
      });
      orderModel.findById.mockReturnValue(query(existing));

      await expect(
        service.update(
          ORDER_ID.toString(),
          { shippingMethod: 'home', customer: { wilaya: '', commune: '' } } as UpdateOrderDto,
        ),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.ORDER_WILAYA_COMMUNE_REQUIRED });

      expect(orderModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('rejects a total below items plus shipping', async () => {
      const existing = makeOrder();
      orderModel.findById.mockReturnValue(query(existing));

      await expect(
        service.update(ORDER_ID.toString(), { total: 50 } as UpdateOrderDto),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.ORDER_TOTAL_MISMATCH });

      expect(orderModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('writes a plain save without a status change through findByIdAndUpdate', async () => {
      const existing = makeOrder();
      const updated = makeOrder({ total: 500 });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findByIdAndUpdate.mockReturnValue(query(updated));

      const result = await service.update(ORDER_ID.toString(), { total: 500 } as UpdateOrderDto);

      expect(result).toBe(updated);
      expect(orderModel.findByIdAndUpdate).toHaveBeenCalledWith(
        ORDER_ID.toString(),
        expect.objectContaining({ total: 500, updatedAt: expect.any(Date) }),
        { new: true },
      );
      expect(orderModel.startSession).not.toHaveBeenCalled();
      expect(reservationsService.onStatusChange).not.toHaveBeenCalled();
    });

    it('rejects a missing order with ORDER_NOT_FOUND', async () => {
      orderModel.findById.mockReturnValue(query(null));

      await expect(service.update(ORDER_ID.toString(), {} as UpdateOrderDto)).rejects.toMatchObject({
        errorCode: AppErrorCode.ORDER_NOT_FOUND,
      });
    });
  });

  describe('update() — DHD commune mapping', () => {
    const selection = {
      name: '  Alger Centre  ',
      wilayaId: '16',
      postalCode: ' 16000 ',
      hasStopDesk: true,
    };

    it('stamps a normalized selection with the acting user', async () => {
      const existing = makeOrder({ deliveryCompanyId: 'dhd' });
      const claimed = makeOrder({ deliveryCompanyId: 'dhd', dhdCommune: selection });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findByIdAndUpdate.mockReturnValue(query(claimed));

      await service.update(
        ORDER_ID.toString(),
        { dhdCommune: selection } as unknown as UpdateOrderDto,
        VENDOR_USER,
      );

      const [, updateData] = orderModel.findByIdAndUpdate.mock.calls[0];
      expect(updateData.dhdCommune).toEqual({
        name: 'Alger Centre',
        wilayaId: '16',
        postalCode: '16000',
        hasStopDesk: true,
        selectedAt: expect.any(Date),
        selectedBy: VENDOR_USER.id,
      });
    });

    it('refuses a selection from another wilaya', async () => {
      orderModel.findById.mockReturnValue(query(makeOrder({ deliveryCompanyId: 'dhd' })));

      await expect(
        service.update(ORDER_ID.toString(), {
          dhdCommune: { name: 'Oran', wilayaId: '31' },
        } as unknown as UpdateOrderDto),
      ).rejects.toMatchObject({
        errorCode: AppErrorCode.DELIVERY_COMMUNE_INVALID,
        errorParams: expect.objectContaining({ wilaya: '16', selectedWilaya: '31' }),
      });

      expect(orderModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('refuses an empty commune name', async () => {
      orderModel.findById.mockReturnValue(query(makeOrder({ deliveryCompanyId: 'dhd' })));

      await expect(
        service.update(ORDER_ID.toString(), {
          dhdCommune: { name: '   ', wilayaId: '16' },
        } as unknown as UpdateOrderDto),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.DELIVERY_COMMUNE_INVALID });
    });

    it('clears the mapping when the client sends null', async () => {
      const existing = makeOrder({
        deliveryCompanyId: 'dhd',
        dhdCommune: { name: 'Alger Centre', wilayaId: '16', hasStopDesk: true },
      });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findByIdAndUpdate.mockReturnValue(query(makeOrder({ dhdCommune: null })));

      await service.update(ORDER_ID.toString(), { dhdCommune: null } as unknown as UpdateOrderDto);

      const [, updateData] = orderModel.findByIdAndUpdate.mock.calls[0];
      expect(updateData).toHaveProperty('dhdCommune', null);
    });

    it('clears a stale mapping when the wilaya changes without a new selection', async () => {
      const existing = makeOrder({
        deliveryCompanyId: 'dhd',
        customer: { name: 'Customer', phone: '0550000000', wilaya: '16', commune: 'Alger', address: 'Somewhere' },
        dhdCommune: { name: 'Alger Centre', wilayaId: '16', hasStopDesk: true },
      });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findByIdAndUpdate.mockReturnValue(query(makeOrder()));

      await service.update(ORDER_ID.toString(), {
        customer: { wilaya: '31', commune: 'Oran' },
      } as UpdateOrderDto);

      const [, updateData] = orderModel.findByIdAndUpdate.mock.calls[0];
      expect(updateData).toHaveProperty('dhdCommune', null);
    });

    it('keeps the mapping when the wilaya is unchanged', async () => {
      const existing = makeOrder({
        deliveryCompanyId: 'dhd',
        dhdCommune: { name: 'Alger Centre', wilayaId: '16', hasStopDesk: true },
      });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findByIdAndUpdate.mockReturnValue(query(existing));

      await service.update(ORDER_ID.toString(), {
        customer: { wilaya: '16', commune: 'Alger Centre', name: 'Customer' },
      } as UpdateOrderDto);

      const [, updateData] = orderModel.findByIdAndUpdate.mock.calls[0];
      expect(updateData).not.toHaveProperty('dhdCommune');
    });
  });

  describe('update() — Noest commune mapping', () => {
    const noestSelection = {
      name: '  Alger Centre  ',
      wilayaId: '16',
      postalCode: ' 16000 ',
    };

    it('stamps a normalized selection with the acting user', async () => {
      const existing = makeOrder({ deliveryCompanyId: 'noest' });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findByIdAndUpdate.mockReturnValue(query(makeOrder({ deliveryCompanyId: 'noest' })));

      await service.update(
        ORDER_ID.toString(),
        { noestCommune: noestSelection } as unknown as UpdateOrderDto,
        VENDOR_USER,
      );

      const [, updateData] = orderModel.findByIdAndUpdate.mock.calls[0];
      expect(updateData.noestCommune).toEqual({
        name: 'Alger Centre',
        wilayaId: '16',
        postalCode: '16000',
        selectedAt: expect.any(Date),
        selectedBy: VENDOR_USER.id,
      });
    });

    it('refuses a selection from another wilaya', async () => {
      orderModel.findById.mockReturnValue(query(makeOrder({ deliveryCompanyId: 'noest' })));

      await expect(
        service.update(ORDER_ID.toString(), {
          noestCommune: { name: 'Oran', wilayaId: '31' },
        } as unknown as UpdateOrderDto),
      ).rejects.toMatchObject({
        errorCode: AppErrorCode.DELIVERY_COMMUNE_INVALID,
        errorParams: expect.objectContaining({ wilaya: '16', selectedWilaya: '31' }),
      });

      expect(orderModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('clears the mapping when the client sends null', async () => {
      const existing = makeOrder({
        deliveryCompanyId: 'noest',
        noestCommune: { name: 'Alger Centre', wilayaId: '16' },
      });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findByIdAndUpdate.mockReturnValue(query(makeOrder({ noestCommune: null })));

      await service.update(ORDER_ID.toString(), { noestCommune: null } as unknown as UpdateOrderDto);

      const [, updateData] = orderModel.findByIdAndUpdate.mock.calls[0];
      expect(updateData).toHaveProperty('noestCommune', null);
    });

    it('clears a stale mapping when the wilaya changes without a new selection', async () => {
      const existing = makeOrder({
        deliveryCompanyId: 'noest',
        customer: { name: 'Customer', phone: '0550000000', wilaya: '16', commune: 'Alger', address: 'Somewhere' },
        noestCommune: { name: 'Alger Centre', wilayaId: '16' },
      });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findByIdAndUpdate.mockReturnValue(query(makeOrder()));

      await service.update(ORDER_ID.toString(), {
        customer: { wilaya: '31', commune: 'Oran' },
      } as UpdateOrderDto);

      const [, updateData] = orderModel.findByIdAndUpdate.mock.calls[0];
      expect(updateData).toHaveProperty('noestCommune', null);
    });

    it('keeps the mapping when the wilaya is unchanged', async () => {
      const existing = makeOrder({
        deliveryCompanyId: 'noest',
        noestCommune: { name: 'Alger Centre', wilayaId: '16' },
      });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findByIdAndUpdate.mockReturnValue(query(existing));

      await service.update(ORDER_ID.toString(), {
        customer: { wilaya: '16', commune: 'Alger Centre', name: 'Customer' },
      } as UpdateOrderDto);

      const [, updateData] = orderModel.findByIdAndUpdate.mock.calls[0];
      expect(updateData).not.toHaveProperty('noestCommune');
    });

    it('does not touch a Noest selection when a DHD selection is saved', async () => {
      const existing = makeOrder({
        deliveryCompanyId: 'dhd',
        customer: { name: 'Customer', phone: '0550000000', wilaya: '16', commune: 'Alger', address: 'Somewhere' },
        noestCommune: { name: 'Alger Centre', wilayaId: '16' },
      });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findByIdAndUpdate.mockReturnValue(query(existing));

      await service.update(ORDER_ID.toString(), {
        dhdCommune: { name: 'Alger Centre', wilayaId: '16', hasStopDesk: true },
      } as unknown as UpdateOrderDto);

      const [, updateData] = orderModel.findByIdAndUpdate.mock.calls[0];
      expect(updateData).not.toHaveProperty('noestCommune');
      expect(updateData.dhdCommune).toEqual(
        expect.objectContaining({ name: 'Alger Centre', wilayaId: '16' }),
      );
    });
  });

  describe('update() — editing the lines of a confirmed order', () => {
    const OTHER_VARIANT_ID = new Types.ObjectId();
    const swappedItems = () => [
      {
        productId: 'p-1',
        productName: 'Product',
        quantity: 1,
        price: 80,
        variantId: OTHER_VARIANT_ID.toString(),
      },
    ];

    it('claims the edit conditionally on the order still being confirmed and reconciles in the same session', async () => {
      const existing = makeOrder({ status: statusConfig(OrderStatus.CONFIRMED) });
      const claimed = makeOrder({
        status: statusConfig(OrderStatus.CONFIRMED),
        items: swappedItems(),
      });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findOneAndUpdate.mockReturnValue(query(claimed));

      await service.update(ORDER_ID.toString(), { items: swappedItems() } as UpdateOrderDto);

      expect(orderModel.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: ORDER_ID.toString(),
          $or: [{ 'status.slug': OrderStatus.CONFIRMED }, { status: OrderStatus.CONFIRMED }],
        },
        expect.objectContaining({ items: swappedItems() }),
        expect.objectContaining({ new: true, session: sessions[1] }),
      );

      // The reconcile sees the POST-CLAIM document, so it reconciles against the lines the
      // order will actually hold, and runs inside the claim's own transaction.
      expect(reservationsService.reconcileEditedLines).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: ORDER_ID,
          orderNo: existing.orderNo,
          storeId: STORE_ID,
          items: [expect.objectContaining({ variantId: OTHER_VARIANT_ID.toString(), quantity: 1 })],
        }),
        null,
        sessions[1],
      );

      // A reservation-carrying edit is not a plain write and never runs the placed-side gate
      // (the order's own reservation is already netted out of `available`).
      expect(orderModel.findByIdAndUpdate).not.toHaveBeenCalled();
      expect(reservationsService.assertLinesInStock).not.toHaveBeenCalled();
      // No status moved, so no transition side effect fires.
      expect(reservationsService.onStatusChange).not.toHaveBeenCalled();
    });

    it('surfaces a failed reconciliation and leaves the order on its stored lines', async () => {
      const existing = makeOrder({ status: statusConfig(OrderStatus.CONFIRMED) });
      const claimed = makeOrder({ status: statusConfig(OrderStatus.CONFIRMED) });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findOneAndUpdate.mockReturnValue(query(claimed));
      reservationsService.reconcileEditedLines.mockRejectedValueOnce(
        new AppException(AppErrorCode.INSUFFICIENT_STOCK, {
          variantId: OTHER_VARIANT_ID.toString(),
          available: 0,
          requested: 1,
        }),
      );

      await expect(
        service.update(ORDER_ID.toString(), { items: swappedItems() } as UpdateOrderDto),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.INSUFFICIENT_STOCK });

      // The session aborted: the claim is rolled back with the reservation work, so the order
      // keeps its previous lines and the stock it already promised.
      expect(sessions[1].abortTransaction).toHaveBeenCalled();
      expect(orderModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('refuses a save that rewrites the lines and moves the status at once', async () => {
      const existing = makeOrder({ status: statusConfig(OrderStatus.CONFIRMED) });
      orderModel.findById.mockReturnValue(query(existing));

      await expect(
        service.update(ORDER_ID.toString(), {
          items: swappedItems(),
          status: OrderStatus.DISPATCHED,
        } as UpdateOrderDto),
      ).rejects.toMatchObject({
        errorCode: AppErrorCode.INVALID_ORDER_TRANSITION,
        errorParams: expect.objectContaining({ reason: 'items_and_status_in_one_save' }),
      });

      expect(reservationsService.reconcileEditedLines).not.toHaveBeenCalled();
      expect(reservationsService.onStatusChange).not.toHaveBeenCalled();
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('keeps a dispatched order fully locked (no reconcile, no plain write)', async () => {
      const existing = makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) });
      orderModel.findById.mockReturnValue(query(existing));

      await expect(
        service.update(ORDER_ID.toString(), { items: swappedItems() } as UpdateOrderDto),
      ).rejects.toMatchObject({
        errorCode: AppErrorCode.INVALID_ORDER_TRANSITION,
        errorParams: expect.objectContaining({ reason: 'items_locked_after_placed' }),
      });

      expect(reservationsService.reconcileEditedLines).not.toHaveBeenCalled();
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(orderModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('lets a pure status change on a confirmed order through without touching items', async () => {
      const existing = makeOrder({ status: statusConfig(OrderStatus.CONFIRMED) });
      const claimed = makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findOneAndUpdate.mockReturnValue(query(claimed));

      await service.update(ORDER_ID.toString(), {
        status: OrderStatus.DISPATCHED,
      } as UpdateOrderDto);

      expect(reservationsService.onStatusChange).toHaveBeenCalledWith(
        expect.anything(),
        OrderStatus.CONFIRMED,
        OrderStatus.DISPATCHED,
        null,
        sessions[1],
      );
      expect(reservationsService.reconcileEditedLines).not.toHaveBeenCalled();
    });
  });

  describe('update() — dispatch books the parcel before claiming', () => {
    const confirmed = () =>
      makeOrder({ status: statusConfig(OrderStatus.CONFIRMED), deliveryCompanyId: 'company-1' });

    it('books the parcel first and attaches it in the same claim that moves the status', async () => {
      const existing = confirmed();
      const claimed = makeOrder({
        status: statusConfig(OrderStatus.DISPATCHED),
        deliveryParcelId: 'PARCEL-1',
      });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findOneAndUpdate.mockReturnValue(query(claimed));
      deliveryService.createDeliveryForOrder.mockResolvedValue({ parcelId: 'PARCEL-1' });

      const result = await service.update(ORDER_ID.toString(), {
        status: OrderStatus.DISPATCHED,
      } as UpdateOrderDto);

      // Handed to the courier while the order was still `confirmed` (before the claim).
      expect(deliveryService.createDeliveryForOrder).toHaveBeenCalledWith(
        expect.objectContaining({ orderNo: existing.orderNo, deliveryCompanyId: 'company-1' }),
      );
      // The parcel id rides on the atomic claim write.
      const claimUpdate = orderModel.findOneAndUpdate.mock.calls[0][1];
      expect(claimUpdate).toEqual(
        expect.objectContaining({ deliveryParcelId: 'PARCEL-1', deliveryError: null }),
      );
      expect(result).toBe(claimed);
      expect(orderModel.updateOne).not.toHaveBeenCalled();
    });

    it('fills a missing stopdesk code before booking and persists it with the claim', async () => {
      const existing = confirmed();
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findOneAndUpdate.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) })),
      );
      deliveryService.resolveDefaultStopDesk.mockResolvedValue('16-001');

      await service.update(ORDER_ID.toString(), { status: OrderStatus.DISPATCHED } as UpdateOrderDto);

      expect(deliveryService.resolveDefaultStopDesk).toHaveBeenCalledWith('company-1', '16');
      expect(deliveryService.createDeliveryForOrder).toHaveBeenCalledWith(
        expect.objectContaining({ stopDeskCode: '16-001' }),
      );
      const claimUpdate = orderModel.findOneAndUpdate.mock.calls[0][1];
      expect(claimUpdate.stopDeskCode).toBe('16-001');
    });

    it('does not replace a stopdesk code the order already carries', async () => {
      const existing = makeOrder({
        status: statusConfig(OrderStatus.CONFIRMED),
        deliveryCompanyId: 'company-1',
        stopDeskCode: '16-EXISTING',
      });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findOneAndUpdate.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) })),
      );

      await service.update(ORDER_ID.toString(), { status: OrderStatus.DISPATCHED } as UpdateOrderDto);

      expect(deliveryService.resolveDefaultStopDesk).not.toHaveBeenCalled();
      expect(deliveryService.createDeliveryForOrder).toHaveBeenCalledWith(
        expect.objectContaining({ stopDeskCode: '16-EXISTING' }),
      );
    });

    it('fails the dispatch and leaves the order confirmed when the booking fails', async () => {
      const existing = confirmed();
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.updateOne.mockReturnValue(query({}));
      deliveryService.createDeliveryForOrder.mockRejectedValue(
        new AppException(AppErrorCode.DELIVERY_API_ERROR, { company: 'noest' }),
      );

      await expect(
        service.update(ORDER_ID.toString(), { status: OrderStatus.DISPATCHED } as UpdateOrderDto),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.DELIVERY_API_ERROR });

      // Nothing moved: no status claim, no inventory effect, order stays `confirmed`.
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(reservationsService.onStatusChange).not.toHaveBeenCalled();
      // The failure is still recorded for the order card.
      expect(orderModel.updateOne).toHaveBeenCalledWith(
        { _id: ORDER_ID.toString() },
        { $set: { deliveryError: expect.any(String) } },
      );
    });

    it('does not re-book when the order already carries a parcel id', async () => {
      const existing = makeOrder({
        status: statusConfig(OrderStatus.CONFIRMED),
        deliveryCompanyId: 'company-1',
        deliveryParcelId: 'PARCEL-OLD',
      });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findOneAndUpdate.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) })),
      );

      await service.update(ORDER_ID.toString(), { status: OrderStatus.DISPATCHED } as UpdateOrderDto);

      expect(deliveryService.createDeliveryForOrder).not.toHaveBeenCalled();
      const claimUpdate = orderModel.findOneAndUpdate.mock.calls[0][1];
      expect(claimUpdate.deliveryParcelId).toBeUndefined();
    });

    it('fails before the claim when no delivery company is assigned', async () => {
      const existing = makeOrder({
        status: statusConfig(OrderStatus.CONFIRMED),
        deliveryCompanyId: undefined,
      });
      orderModel.findById.mockReturnValue(query(existing));
      deliveryService.assertCanCreateDelivery.mockImplementation(() => {
        throw new AppException(AppErrorCode.DELIVERY_COMPANY_NOT_ASSIGNED, { orderNo: existing.orderNo });
      });

      await expect(
        service.update(ORDER_ID.toString(), { status: OrderStatus.DISPATCHED } as UpdateOrderDto),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.DELIVERY_COMPANY_NOT_ASSIGNED });

      expect(deliveryService.createDeliveryForOrder).not.toHaveBeenCalled();
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('update() — D-3 ownership', () => {
    it('allows the owning vendor through to the write', async () => {
      const existing = makeOrder();
      const updated = makeOrder({ total: 500 });
      storesService.findByVendorId.mockResolvedValue({ _id: STORE_ID });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findByIdAndUpdate.mockReturnValue(query(updated));

      await service.update(ORDER_ID.toString(), { total: 500 } as UpdateOrderDto, VENDOR_USER);

      expect(storesService.findByVendorId).toHaveBeenCalledWith(VENDOR_USER.id);
      expect(orderModel.findByIdAndUpdate).toHaveBeenCalled();
    });

    it("refuses a vendor touching another store's order", async () => {
      const existing = makeOrder();
      storesService.findByVendorId.mockResolvedValue({ _id: OTHER_STORE_ID });
      orderModel.findById.mockReturnValue(query(existing));

      await expect(
        service.update(ORDER_ID.toString(), { total: 480 } as UpdateOrderDto, VENDOR_USER),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.AUTH_ORDER_OWNER_ONLY });

      expect(orderModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('falls back to the legacy vendorEmail for an un-migrated order', async () => {
      const existing = makeOrder({ storeId: undefined, vendorEmail: VENDOR_USER.email });
      const updated = makeOrder({ total: 500 });
      storesService.findByVendorId.mockResolvedValue({ _id: STORE_ID });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findByIdAndUpdate.mockReturnValue(query(updated));

      await service.update(ORDER_ID.toString(), { total: 500 } as UpdateOrderDto, VENDOR_USER);

      expect(orderModel.findByIdAndUpdate).toHaveBeenCalled();
    });

    it("refuses the email fallback when the emails don't match either", async () => {
      const existing = makeOrder({ storeId: undefined, vendorEmail: 'someone-else@test.com' });
      storesService.findByVendorId.mockResolvedValue(null);
      orderModel.findById.mockReturnValue(query(existing));

      await expect(
        service.update(ORDER_ID.toString(), { total: 1 } as UpdateOrderDto, VENDOR_USER),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.AUTH_ORDER_OWNER_ONLY });
    });

    it('lets an admin edit any order', async () => {
      const existing = makeOrder({ storeId: OTHER_STORE_ID, vendorEmail: 'other@test.com' });
      const updated = makeOrder({ total: 500 });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findByIdAndUpdate.mockReturnValue(query(updated));

      await service.update(ORDER_ID.toString(), { total: 500 } as UpdateOrderDto, ADMIN_USER);

      expect(storesService.findByVendorId).not.toHaveBeenCalled();
      expect(orderModel.findByIdAndUpdate).toHaveBeenCalled();
    });

    it('rejects a non-vendor caller with AUTH_VENDOR_ONLY', async () => {
      orderModel.findById.mockReturnValue(query(makeOrder()));

      await expect(
        service.update(
          ORDER_ID.toString(),
          { total: 500 } as UpdateOrderDto,
          { ...VENDOR_USER, role: 'CUSTOMER' },
        ),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.AUTH_VENDOR_ONLY });
    });
  });

  describe('bulkShip() — books the parcel before claiming (D-2/D-3)', () => {
    const confirmedOrder = (orderNo: string, id = new Types.ObjectId()) =>
      makeOrder({ _id: id, orderNo, status: statusConfig(OrderStatus.CONFIRMED) });

    it('skips non-confirmed orders and still ships the confirmed neighbours (ME-13)', async () => {
      orderModel.find.mockReturnValue(
        query([confirmedOrder('ORD-1'), makeOrder({ orderNo: 'ORD-2', status: statusConfig(OrderStatus.PLACED) })]),
      );
      jest
        .spyOn(service as any, 'claimStatusWithInventory')
        .mockResolvedValue(makeOrder({ orderNo: 'ORD-1' }));
      deliveryService.createBulkDeliveriesForOrders.mockResolvedValue([
        { orderNo: 'ORD-1', success: true, parcelId: 'PX-1' },
      ]);
      orderModel.updateOne.mockReturnValue(query({}));

      const results = await service.bulkShip({ ids: ['a', 'b'] });

      // Only the confirmed order is handed to the courier; the placed one never is.
      expect(deliveryService.createBulkDeliveriesForOrders).toHaveBeenCalledWith([
        expect.objectContaining({ orderNo: 'ORD-1' }),
      ]);
      expect((service as any).claimStatusWithInventory).toHaveBeenCalledTimes(1);
      expect(results).toContainEqual({
        orderNo: 'ORD-2',
        success: false,
        error: 'Only confirmed orders can be shipped',
      });
      expect(results).toContainEqual({ orderNo: 'ORD-1', success: true, parcelId: 'PX-1' });
    });

    it('claims only the orders whose parcel was booked, and the parcel rides the claim', async () => {
      const first = confirmedOrder('ORD-1');
      const second = confirmedOrder('ORD-2');
      orderModel.find.mockReturnValue(query([first, second]));
      const claimSpy = jest
        .spyOn(service as any, 'claimStatusWithInventory')
        .mockImplementation(async (id: string) =>
          makeOrder({ _id: new Types.ObjectId(id), orderNo: id === String(first._id) ? 'ORD-1' : 'ORD-2' }),
        );
      deliveryService.createBulkDeliveriesForOrders.mockResolvedValue([
        { orderNo: 'ORD-1', success: true, parcelId: 'PX-1' },
        { orderNo: 'ORD-2', success: false, error: 'courier down' },
      ]);
      orderModel.updateOne.mockReturnValue(query({}));

      const results = await service.bulkShip({ ids: [String(first._id), String(second._id)] });

      // Only the successfully-booked order is claimed; the refused one stays confirmed.
      expect(claimSpy).toHaveBeenCalledTimes(1);
      expect(claimSpy.mock.calls[0][0]).toBe(String(first._id));
      const claimUpdate = claimSpy.mock.calls[0][3] as { $set: Record<string, unknown> };
      expect(claimUpdate.$set).toEqual(expect.objectContaining({ deliveryParcelId: 'PX-1' }));
      // The failed booking is recorded and reported, never claimed.
      expect(orderModel.updateOne).toHaveBeenCalledWith(
        { _id: second._id },
        { $set: { deliveryError: 'courier down' } },
      );
      expect(results).toContainEqual({ orderNo: 'ORD-1', success: true, parcelId: 'PX-1' });
      expect(results).toContainEqual({ orderNo: 'ORD-2', success: false, error: 'courier down' });
    });

    it('resolves and persists a missing stopdesk code before bulk booking', async () => {
      const order: any = confirmedOrder('ORD-1');
      order.deliveryCompanyId = 'company-1';
      orderModel.find.mockReturnValue(query([order]));
      const claimSpy = jest
        .spyOn(service as any, 'claimStatusWithInventory')
        .mockResolvedValue(makeOrder({ orderNo: 'ORD-1' }));
      deliveryService.resolveDefaultStopDesk.mockResolvedValue('16-001');
      deliveryService.createBulkDeliveriesForOrders.mockResolvedValue([
        { orderNo: 'ORD-1', success: true, parcelId: 'PX-1' },
      ]);

      await service.bulkShip({ ids: [String(order._id)] });

      expect(deliveryService.resolveDefaultStopDesk).toHaveBeenCalledWith('company-1', '16');
      expect(deliveryService.createBulkDeliveriesForOrders).toHaveBeenCalledWith([
        expect.objectContaining({ orderNo: 'ORD-1', stopDeskCode: '16-001' }),
      ]);
      const claimUpdate = claimSpy.mock.calls[0][3] as { $set: Record<string, unknown> };
      expect(claimUpdate.$set.stopDeskCode).toBe('16-001');
    });

    it('reports an order whose stock deduction failed and keeps its neighbours going', async () => {
      const first = confirmedOrder('ORD-1');
      const second = confirmedOrder('ORD-2');
      orderModel.find.mockReturnValue(query([first, second]));
      jest
        .spyOn(service as any, 'claimStatusWithInventory')
        .mockRejectedValueOnce(new AppException(AppErrorCode.INSUFFICIENT_STOCK, { requested: 2, available: 0 }))
        .mockResolvedValueOnce(makeOrder({ orderNo: 'ORD-2' }));
      deliveryService.createBulkDeliveriesForOrders.mockResolvedValue([
        { orderNo: 'ORD-1', success: true, parcelId: 'PX-1' },
        { orderNo: 'ORD-2', success: true, parcelId: 'PX-2' },
      ]);
      orderModel.updateOne.mockReturnValue(query({}));

      const results = await service.bulkShip({ ids: [String(first._id), String(second._id)] });

      expect(deliveryService.createBulkDeliveriesForOrders).toHaveBeenCalledWith([
        expect.objectContaining({ orderNo: 'ORD-1' }),
        expect.objectContaining({ orderNo: 'ORD-2' }),
      ]);
      const failure = results.find((r) => r.orderNo === 'ORD-1');
      expect(failure).toMatchObject({ success: false });
      expect(failure?.error).toContain('INSUFFICIENT_STOCK');
      expect(results).toContainEqual({ orderNo: 'ORD-2', success: true, parcelId: 'PX-2' });
    });

    it('skips an order that moved underneath the claim and reports it', async () => {
      const order = confirmedOrder('ORD-1');
      orderModel.find.mockReturnValue(query([order]));
      jest.spyOn(service as any, 'claimStatusWithInventory').mockResolvedValue(null);
      deliveryService.createBulkDeliveriesForOrders.mockResolvedValue([
        { orderNo: 'ORD-1', success: true, parcelId: 'PX-1' },
      ]);
      orderModel.updateOne.mockReturnValue(query({}));

      const results = await service.bulkShip({ ids: [String(order._id)] });

      expect(results).toEqual([
        { orderNo: 'ORD-1', success: false, error: 'Status changed while processing, skipped' },
      ]);
      expect(deliveryService.createBulkDeliveriesForOrders).toHaveBeenCalledTimes(1);
    });

    it('returns an empty list when nothing matches the filter', async () => {
      orderModel.find.mockReturnValue(query([]));

      await expect(service.bulkShip({ ids: [] })).resolves.toEqual([]);

      expect(deliveryService.createBulkDeliveriesForOrders).not.toHaveBeenCalled();
    });
  });

  describe('bulkAction() — D-2 per-order claim', () => {
    it('claims each order individually instead of bulk-writing over races', async () => {
      const good = makeOrder({ orderNo: 'ORD-1', _id: new Types.ObjectId() });
      const alreadyCancelled = makeOrder({ orderNo: 'ORD-2', _id: new Types.ObjectId(), status: statusConfig(OrderStatus.CANCELLED) });
      orderModel.find.mockReturnValue(query([good, alreadyCancelled]));
      jest
        .spyOn(service as any, 'claimStatusWithInventory')
        .mockResolvedValue(makeOrder({ orderNo: 'ORD-1' }));

      const result = await service.bulkAction({ ids: ['a', 'b'], action: 'confirm' } as any, VENDOR_USER);

      expect((service as any).claimStatusWithInventory).toHaveBeenCalledTimes(1);
      expect(result.modifiedCount).toBe(1);
      expect(result.errors).toEqual([
        'Order ORD-2: This order has already been cancelled',
      ]);
      expect(orderModel.updateMany).not.toHaveBeenCalled();
    });

    it('records a per-order inventory failure without rolling back the batch', async () => {
      const first = makeOrder({ orderNo: 'ORD-1', _id: new Types.ObjectId() });
      const second = makeOrder({ orderNo: 'ORD-2', _id: new Types.ObjectId() });
      orderModel.find.mockReturnValue(query([first, second]));
      jest
        .spyOn(service as any, 'claimStatusWithInventory')
        .mockRejectedValueOnce(new AppException(AppErrorCode.INSUFFICIENT_STOCK, {}))
        .mockResolvedValueOnce(makeOrder({ orderNo: 'ORD-2' }));

      const result = await service.bulkAction({ ids: ['a', 'b'], action: 'confirm' } as any, VENDOR_USER);

      expect(result.modifiedCount).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors?.[0]).toContain('ORD-1');
    });

    it('settles each order individually when the action is delete', async () => {
      const first = makeOrder({ orderNo: 'ORD-1', _id: new Types.ObjectId() });
      const second = makeOrder({ orderNo: 'ORD-2', _id: new Types.ObjectId() });
      orderModel.find.mockReturnValue(query([first, second]));
      jest
        .spyOn(service as any, 'claimDeleteWithInventory')
        .mockResolvedValueOnce(makeOrder({ orderNo: 'ORD-1' }))
        .mockResolvedValueOnce(null);

      const result = await service.bulkAction({ ids: ['a', 'b'], action: 'delete' } as any, VENDOR_USER);

      expect((service as any).claimDeleteWithInventory).toHaveBeenCalledTimes(2);
      expect(result.modifiedCount).toBe(1);
      expect(result.errors).toEqual(['Order ORD-2: already deleted, skipped']);
      // The bulk write could neither release reservations nor report a per-order failure.
      expect(orderModel.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('remove() — deleting settles the stock the order was holding', () => {
    it('releases the order reservations in the same transaction as the soft-delete', async () => {
      orderModel.findById.mockReturnValue(query(makeOrder({ status: statusConfig(OrderStatus.CONFIRMED) })));
      orderModel.findOneAndUpdate.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.CONFIRMED), isDeleted: true })),
      );

      await service.remove(String(ORDER_ID), VENDOR_USER);

      // Conditional claim: only an order that is not already deleted may be settled.
      expect(orderModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: String(ORDER_ID), isDeleted: { $ne: true } },
        { $set: expect.objectContaining({ isDeleted: true }) },
        expect.objectContaining({ new: true, session: sessions[1] }),
      );
      expect(sessions[1].withTransaction).toHaveBeenCalledTimes(1);
      expect(reservationsService.release).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: ORDER_ID }),
        expect.any(Types.ObjectId),
        sessions[1],
      );
      // The old unconditional write is gone - it left the reservations behind.
      expect(orderModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('throws ORDER_ALREADY_DELETED and settles nothing when the claim loses the race', async () => {
      orderModel.findById.mockReturnValue(query(makeOrder()));
      orderModel.findOneAndUpdate.mockReturnValue(query(null));

      await expect(service.remove(String(ORDER_ID), VENDOR_USER)).rejects.toMatchObject({
        errorCode: AppErrorCode.ORDER_ALREADY_DELETED,
      });
      expect(reservationsService.release).not.toHaveBeenCalled();
    });

    it('refuses an already-deleted order before opening a transaction', async () => {
      orderModel.findById.mockReturnValue(query(makeOrder({ isDeleted: true })));

      await expect(service.remove(String(ORDER_ID), VENDOR_USER)).rejects.toMatchObject({
        errorCode: AppErrorCode.ORDER_ALREADY_DELETED,
      });
      expect(orderModel.startSession).not.toHaveBeenCalled();
    });
  });

  describe('create() — advisory availability surfacing (HI-7 b)', () => {
    // `create()` instantiates `new orderModel(doc)`, which the shared plain-object mock cannot
    // do, so this describe builds its own module with a callable model. Placement logic is the
    // real `OrdersService.create`; only the persistence stubs differ.
    let reservations: { checkAdvisoryAvailability: jest.Mock; assertLinesInStock: jest.Mock };
    let variantsService: { snapshotsForVariants: jest.Mock };
    let delivery: { resolveCompanyForWilaya: jest.Mock; resolveDefaultStopDesk: jest.Mock };
    let productModel: { find: jest.Mock };
    let deliveryFees: { getFeeByStoreId: jest.Mock };
    const PRODUCT_ID = new Types.ObjectId();

    beforeEach(async () => {
      const callableOrderModel: any = jest.fn().mockImplementation((doc: any) => ({
        ...doc,
        save: jest.fn().mockResolvedValue({ ...doc, toObject: () => ({ ...doc, _id: 'order-1' }) }),
      }));
      callableOrderModel.findOne = jest.fn().mockReturnValue(query(undefined));

      reservations = {
        checkAdvisoryAvailability: jest.fn().mockResolvedValue([]),
        assertLinesInStock: jest.fn().mockResolvedValue(undefined),
      };
      variantsService = {
        snapshotsForVariants: jest.fn().mockResolvedValue(
          new Map([
            [
              VARIANT_ID.toString(),
              {
                variantId: VARIANT_ID.toString(),
                productId: PRODUCT_ID.toString(),
                storeId: null,
                sku: null,
                snapshot: null,
                image: null,
                priceOverride: null,
              },
            ],
          ]),
        ),
      };

      delivery = {
        resolveCompanyForWilaya: jest.fn().mockResolvedValue('company-1'),
        resolveDefaultStopDesk: jest.fn().mockResolvedValue(null),
      };

      productModel = {
        find: jest.fn().mockReturnValue(
          query([{ _id: PRODUCT_ID, price: 100, weight: 1, originalPrice: null }]),
        ),
      };

      deliveryFees = {
        getFeeByStoreId: jest.fn().mockResolvedValue({
          wilayaCode: '16',
          homeDeliveryFee: 600,
          stopDeskDeliveryFee: 4,
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          OrdersService,
          { provide: getModelToken(Order.name), useValue: callableOrderModel },
          {
            provide: getModelToken(Counter.name),
            useValue: { findOneAndUpdate: jest.fn().mockReturnValue(query({ seq: 42 })) },
          },
          {
            provide: getModelToken(PosHold.name),
            useValue: { findOne: jest.fn().mockReturnValue(query(undefined)) },
          },
          { provide: getModelToken(Product.name), useValue: productModel },
          {
            provide: DeliveryService,
            useValue: delivery,
          },
          { provide: DeliveryFeesService, useValue: deliveryFees },
          {
            provide: OrderStatusesService,
            useValue: { getBySlug: jest.fn(async (slug: string) => statusConfig(slug)) },
          },
          {
            provide: StoresService,
            useValue: {
              findOne: jest.fn().mockResolvedValue({ _id: STORE_ID, vendorEmail: 'store@imraaah.com' }),
              incrementOrderCount: jest.fn().mockResolvedValue(undefined),
              resolveStoreIdByEmail: jest.fn().mockResolvedValue(null),
            },
          },
          { provide: ReservationsService, useValue: reservations },
          { provide: VariantsService, useValue: variantsService },
          { provide: AuditService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
        ],
      }).compile();

      service = module.get<OrdersService>(OrdersService);
    });

    const dto = () =>
      ({
        storeId: STORE_ID.toString(),
        items: [
          {
            productId: '',
            productName: 'Product',
            price: 100,
            quantity: 2,
            variantId: VARIANT_ID.toString(),
          },
        ],
        customer: { name: 'Customer', phone: '0550000000', wilaya: '16', commune: 'Alger', address: '' },
        total: 204,
        shippingMethod: 'stopdesk',
        shippingFee: 4,
        paymentMethod: 'COD',
      }) as any;

    it('rides short lines back on the response without blocking the placement', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([
        { orderItemIndex: 0, variantId: VARIANT_ID.toString(), sku: null, requested: 2, available: 1, isShort: true },
        { orderItemIndex: 0, variantId: VARIANT_ID.toString(), sku: null, requested: 2, available: 5, isShort: false },
      ]);

      const order: any = await service.create(dto());

      // The order was placed (advisory never blocks).
      expect(order.orderNo).toBe('000042');
      expect(order.total).toBe(204);
      // Only the short lines are surfaced, so the buyer's client can warn.
      expect(order.availability).toEqual([
        { orderItemIndex: 0, variantId: VARIANT_ID.toString(), sku: null, requested: 2, available: 1, isShort: true },
      ]);
    });

    it('omits the availability field when every line has enough stock', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([
        { orderItemIndex: 0, variantId: VARIANT_ID.toString(), sku: null, requested: 2, available: 9, isShort: false },
      ]);

      const order: any = await service.create(dto());

      expect(order.orderNo).toBe('000042');
      expect(order.availability).toBeUndefined();
    });

    it('still places the order when the advisory check itself fails', async () => {
      reservations.checkAdvisoryAvailability.mockRejectedValue(new Error('db down'));

      await expect(service.create(dto())).resolves.toBeDefined();
      const order: any = await service.create(dto());
      expect(order.orderNo).toBe('000042');
      expect(order.availability).toBeUndefined();
    });

    it('stamps an unauthenticated storefront checkout as ONLINE', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);

      const order: any = await service.create(dto());

      expect(order.source).toBe('ONLINE');
    });

    it('fills a missing stopdesk code with the first desk for the wilaya', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);
      delivery.resolveDefaultStopDesk.mockResolvedValue('16-001');

      const order: any = await service.create(dto());

      expect(delivery.resolveDefaultStopDesk).toHaveBeenCalledWith('company-1', '16');
      expect(order.stopDeskCode).toBe('16-001');
    });

    it('keeps a stopdesk code supplied by the caller', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);
      const payload: any = dto();
      payload.stopDeskCode = '16-EXISTING';

      const order: any = await service.create(payload);

      expect(delivery.resolveDefaultStopDesk).not.toHaveBeenCalled();
      expect(order.stopDeskCode).toBe('16-EXISTING');
    });

    it('stamps a vendor-entered order as MANUAL', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);

      const order: any = await service.create(dto(), {
        id: new Types.ObjectId().toString(),
        email: 'store@imraaah.com',
        role: 'VENDOR',
        fullName: 'Vendor',
      });

      expect(order.source).toBe('MANUAL');
    });

    it('refuses a vendor-entered order naming a variant with nothing left to ship', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);
      reservations.assertLinesInStock.mockRejectedValueOnce(
        new AppException(AppErrorCode.ORDER_ITEM_OUT_OF_STOCK, {
          variantId: VARIANT_ID.toString(),
          requested: 2,
          available: 0,
        }),
      );

      await expect(
        service.create(dto(), {
          id: new Types.ObjectId().toString(),
          email: 'store@imraaah.com',
          role: 'VENDOR',
          fullName: 'Vendor',
        }),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.ORDER_ITEM_OUT_OF_STOCK });

      expect(reservations.assertLinesInStock).toHaveBeenCalledTimes(1);
    });

    it('leaves the storefront checkout advisory — the hard gate is vendor-only', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);
      reservations.assertLinesInStock.mockClear();

      await service.create(dto());

      expect(reservations.assertLinesInStock).not.toHaveBeenCalled();
    });

    it('ignores a client-supplied source — the channel comes from the request context', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);

      const payload: any = dto();
      payload.source = 'POS';

      const order: any = await service.create(payload);

      expect(order.source).toBe('ONLINE');
    });

    it('server-stamps a public checkout instead of trusting client dates', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);
      const payload: any = dto();
      payload.date = '2001-01-01T00:00:00.000Z';
      payload.createdAt = '2001-01-01T00:00:00.000Z';
      payload.confirmedAt = '2001-01-02T00:00:00.000Z';
      payload.createdBy = 'Vendor';

      const order: any = await service.create(payload);

      expect(new Date(order.date).getFullYear()).toBeGreaterThan(2001);
      expect(new Date(order.createdAt).getFullYear()).toBeGreaterThan(2001);
      expect(order.confirmedAt).toBeUndefined();
      expect(order.createdBy).toBeUndefined();
      expect(order.history[0].user).toBe('Customer');
    });

    it('keeps the date a vendor recorded on a manual order', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);
      const payload: any = dto();
      payload.date = '2024-05-01T00:00:00.000Z';

      const order: any = await service.create(payload, {
        id: new Types.ObjectId().toString(),
        email: 'store@imraaah.com',
        role: 'VENDOR',
        fullName: 'Vendor',
      });

      expect(new Date(order.date).toISOString()).toBe('2024-05-01T00:00:00.000Z');
    });

    it('resolves a public checkout carrier from the attribution, not the request', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);
      delivery.resolveCompanyForWilaya.mockResolvedValue('company-attributed');
      const payload: any = dto();
      payload.deliveryCompanyId = 'company-chosen-by-the-caller';

      const order: any = await service.create(payload);

      expect(delivery.resolveCompanyForWilaya).toHaveBeenCalledWith('store@imraaah.com', '16');
      expect(order.deliveryCompanyId).toBe('company-attributed');
    });

    it('charges the variant override, never the client-sent price (storefront path)', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);
      variantsService.snapshotsForVariants.mockResolvedValue(
        new Map([
          [
            VARIANT_ID.toString(),
            {
              variantId: VARIANT_ID.toString(),
              productId: PRODUCT_ID.toString(),
              storeId: null,
              sku: null,
              snapshot: null,
              image: null,
              priceOverride: 1500,
            },
          ],
        ]),
      );

      // `dto()` sends price: 100 for the line; the resolved line must charge the override instead.
      const order: any = await service.create(dto());

      expect(order.items[0].price).toBe(1500);
    });

    it('charges the product price, never the client price, when the variant carries no override', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);
      productModel.find.mockReturnValue(
        query([{ _id: PRODUCT_ID, price: 250, weight: 1, originalPrice: null }]),
      );

      // `dto()` sends price: 100 and omits a usable productId; the line must still be priced
      // from the variant's product.
      const order: any = await service.create(dto());

      expect(order.items[0].price).toBe(250);
      expect(order.items[0].price).not.toBe(100);
    });

    it('ignores a zero client price on a storefront line', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);
      deliveryFees.getFeeByStoreId.mockResolvedValue({
        wilayaCode: '16',
        homeDeliveryFee: 600,
        stopDeskDeliveryFee: 0,
      });
      const payload: any = dto();
      payload.items[0].price = 0;
      payload.shippingFee = 0;

      const order: any = await service.create(payload);

      expect(order.items[0].price).toBe(100);
      expect(order.total).toBe(200);
    });

    it('refuses a storefront line whose product is not available', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);
      productModel.find.mockReturnValue(query([]));

      await expect(service.create(dto())).rejects.toMatchObject({
        errorCode: AppErrorCode.ORDER_PRODUCT_NOT_AVAILABLE,
      });
    });

    it('computes storefront shipping from the store fee table', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);
      deliveryFees.getFeeByStoreId.mockResolvedValue({
        wilayaCode: '16',
        homeDeliveryFee: 600,
        stopDeskDeliveryFee: 400,
      });
      const payload: any = dto();
      payload.shippingFee = -500;

      const order: any = await service.create(payload);

      expect(deliveryFees.getFeeByStoreId).toHaveBeenCalledWith(STORE_ID.toString(), '16');
      expect(order.shippingFee).toBe(400);
      expect(order.total).toBe(600);
    });

    it('uses the home fee for a home-delivery storefront order', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);
      const payload: any = dto();
      payload.shippingMethod = 'home';
      payload.shippingFee = 0;

      const order: any = await service.create(payload);

      expect(order.shippingFee).toBe(600);
      expect(order.total).toBe(800);
    });

    it('charges zero shipping when the store has no fee for the wilaya', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);
      deliveryFees.getFeeByStoreId.mockRejectedValue(
        new AppException(AppErrorCode.FEE_NOT_FOUND_FOR_WILAYA, { wilayaCode: '16' }),
      );

      const order: any = await service.create(dto());

      expect(order.shippingFee).toBe(0);
      expect(order.total).toBe(200);
    });

    it('lets a vendor keep the manual line price and shipping fee', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);

      const order: any = await service.create(dto(), {
        id: new Types.ObjectId().toString(),
        email: 'store@imraaah.com',
        role: 'VENDOR',
        fullName: 'Vendor',
      });

      expect(order.items[0].price).toBe(100);
      expect(order.shippingFee).toBe(4);
      expect(order.total).toBe(204);
      expect(deliveryFees.getFeeByStoreId).not.toHaveBeenCalled();
    });

    it('snapshots the variant compare-at as the line originalPrice (D12)', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);
      variantsService.snapshotsForVariants.mockResolvedValue(
        new Map([
          [
            VARIANT_ID.toString(),
            {
              variantId: VARIANT_ID.toString(),
              productId: PRODUCT_ID.toString(),
              storeId: null,
              sku: null,
              snapshot: null,
              image: null,
              priceOverride: null,
              compareAtPrice: 150,
            },
          ],
        ]),
      );

      const order: any = await service.create(dto());

      expect(order.items[0].price).toBe(100);
      expect(order.items[0].originalPrice).toBe(150);
    });

    it('writes originalPrice as null (recorded zero discount) when nothing provides a compare-at (D12)', async () => {
      reservations.checkAdvisoryAvailability.mockResolvedValue([]);

      const order: any = await service.create(dto());

      // Presence marks a covered line; a `null` value is a recorded zero discount.
      expect(order.items[0]).toHaveProperty('originalPrice');
      expect(order.items[0].originalPrice).toBeNull();
    });
  });

  describe('createImmediateSale() — POS sale (Phase 2)', () => {
    // A callable model, because the sale is written with `new orderModel(doc)`; the reservation
    // and ledger effects are stubbed so the test asserts the *ordering and atomicity contract*
    // the service enforces rather than re-testing the reservation engine.
    let orderModel: any;
    let posHoldModel: any;
    let productModel: any;
    let deliveryService: any;
    let storesService: any;
    let reservations: {
      reserve: jest.Mock;
      consume: jest.Mock;
      release: jest.Mock;
      reconcileEditedLines: jest.Mock;
    };
    let variantsService: { snapshotsForVariants: jest.Mock };
    let sessions: any[];

    const PRODUCT_A = new Types.ObjectId();
    const VARIANT_A = new Types.ObjectId();
    const VARIANT_B = new Types.ObjectId();
    const HOLD_ID = new Types.ObjectId();
    const STORE = { _id: STORE_ID, vendorEmail: 'store@imraaah.com' };

    const snapshot = (variantId: Types.ObjectId, over: Record<string, any> = {}) => ({
      variantId: variantId.toString(),
      productId: PRODUCT_A.toString(),
      storeId: STORE_ID.toString(),
      sku: 'SKU-1',
      priceOverride: null,
      image: null,
      isActive: true,
      snapshot: { options: [], label: 'Red / M' },
      ...over,
    });

    beforeEach(async () => {
      sessions = [];

      orderModel = jest.fn().mockImplementation((doc: any) => ({
        ...doc,
        save: jest.fn().mockResolvedValue({ ...doc, toObject: () => ({ ...doc }) }),
      }));
      orderModel.findOne = jest.fn().mockReturnValue(query(undefined));
      orderModel.startSession = jest.fn(() => {
        const s = makeSession();
        sessions.push(s);
        return s;
      });

      posHoldModel = jest.fn().mockImplementation((doc: any) => ({
        ...doc,
        _id: HOLD_ID,
        save: jest.fn().mockResolvedValue({ ...doc, _id: HOLD_ID }),
      }));
      posHoldModel.findOne = jest.fn().mockReturnValue(query(undefined));
      posHoldModel.findOneAndUpdate = jest.fn();
      posHoldModel.findOneAndDelete = jest.fn();
      posHoldModel.find = jest.fn();
      posHoldModel.startSession = jest.fn(() => {
        const s = makeSession();
        sessions.push(s);
        return s;
      });

      productModel = {
        find: jest.fn().mockReturnValue(query([{ _id: PRODUCT_A, price: 250, nameEn: 'Widget' }])),
      };

      deliveryService = { createDeliveryForOrder: jest.fn() };

      storesService = {
        findByVendorIdOrThrow: jest.fn().mockResolvedValue(STORE),
        incrementOrderCount: jest.fn().mockResolvedValue(undefined),
      };

      reservations = {
        reserve: jest.fn().mockResolvedValue(undefined),
        consume: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        reconcileEditedLines: jest.fn().mockResolvedValue(undefined),
      };

      variantsService = {
        snapshotsForVariants: jest
          .fn()
          .mockResolvedValue(new Map([[VARIANT_A.toString(), snapshot(VARIANT_A)]])),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          OrdersService,
          { provide: getModelToken(Order.name), useValue: orderModel },
          {
            provide: getModelToken(Counter.name),
            useValue: { findOneAndUpdate: jest.fn().mockReturnValue(query({ seq: 7 })) },
          },
          { provide: getModelToken(PosHold.name), useValue: posHoldModel },
          { provide: getModelToken(Product.name), useValue: productModel },
          { provide: DeliveryService, useValue: deliveryService },
          {
            provide: DeliveryFeesService,
            useValue: { getFeeByStoreId: jest.fn() },
          },
          {
            provide: OrderStatusesService,
            useValue: { getBySlug: jest.fn(async (slug: string) => statusConfig(slug)) },
          },
          { provide: StoresService, useValue: storesService },
          { provide: ReservationsService, useValue: reservations },
          { provide: VariantsService, useValue: variantsService },
          { provide: AuditService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
        ],
      }).compile();

      service = module.get<OrdersService>(OrdersService);
    });

    const posDto = (over: Record<string, any> = {}) =>
      ({ items: [{ variantId: VARIANT_A.toString(), quantity: 2 }], ...over }) as any;

    it('writes a delivered pickup CASH order and reserves then consumes in one transaction', async () => {
      await service.createImmediateSale(posDto(), VENDOR_USER);

      const session = sessions[1];
      // The probe session is discarded; the real one drives the sale.
      expect(sessions[0].endSession).toHaveBeenCalled();
      expect(session.withTransaction).toHaveBeenCalledTimes(1);
      expect(session.endSession).toHaveBeenCalled();

      const doc = orderModel.mock.calls[0][0];
      expect(doc).toMatchObject({
        source: 'POS',
        shippingMethod: 'pickup',
        paymentMethod: 'CASH',
        vendorEmail: STORE.vendorEmail,
        storeId: STORE_ID,
        total: 500,
        inventoryState: expect.objectContaining({ reservedAt: expect.any(Date), fulfilledAt: expect.any(Date) }),
      });
      expect(doc.status.slug).toBe(OrderStatus.DELIVERED);
      expect(doc.history.map((h: any) => h.status.slug)).toEqual([
        OrderStatus.PLACED,
        OrderStatus.CONFIRMED,
        OrderStatus.DISPATCHED,
        OrderStatus.DELIVERED,
      ]);
      expect(doc.items[0]).toMatchObject({
        variantId: VARIANT_A.toString(),
        quantity: 2,
        price: 250,
        productName: 'Widget',
      });

      const ctx = expect.objectContaining({
        orderId: doc._id,
        storeId: STORE_ID,
        items: [expect.objectContaining({ variantId: VARIANT_A.toString(), quantity: 2 })],
      });
      expect(reservations.reserve).toHaveBeenCalledWith(ctx, expect.any(Types.ObjectId), session);
      expect(reservations.consume).toHaveBeenCalledWith(ctx, expect.any(Types.ObjectId), session);
      // A POS sale is never handed to a courier.
      expect(deliveryService.createDeliveryForOrder).not.toHaveBeenCalled();
      expect(storesService.incrementOrderCount).toHaveBeenCalledWith(STORE.vendorEmail, 1);
    });

    it('prices each line from the variant snapshot, ignoring any client-sent price', async () => {
      const body = posDto({
        items: [{ variantId: VARIANT_A.toString(), quantity: 3, price: 1 }],
      });

      await service.createImmediateSale(body, VENDOR_USER);

      const doc = orderModel.mock.calls[0][0];
      expect(doc.items[0].price).toBe(250);
      expect(doc.total).toBe(750);
    });

    it('prefers the variant price override over the product price', async () => {
      variantsService.snapshotsForVariants.mockResolvedValue(
        new Map([[VARIANT_A.toString(), snapshot(VARIANT_A, { priceOverride: 199 })]]),
      );

      await service.createImmediateSale(posDto(), VENDOR_USER);

      expect(orderModel.mock.calls[0][0].total).toBe(398);
    });

    it('snapshots the variant compare-at as the line originalPrice (D12)', async () => {
      variantsService.snapshotsForVariants.mockResolvedValue(
        new Map([[VARIANT_A.toString(), snapshot(VARIANT_A, { compareAtPrice: 999 })]]),
      );

      await service.createImmediateSale(posDto(), VENDOR_USER);

      expect(orderModel.mock.calls[0][0].items[0]).toMatchObject({ price: 250, originalPrice: 999 });
    });

    it('falls back to the product originalPrice when the variant has no compare-at (D12)', async () => {
      productModel.find.mockReturnValue(
        query([{ _id: PRODUCT_A, price: 250, nameEn: 'Widget', originalPrice: 320 }]),
      );

      await service.createImmediateSale(posDto(), VENDOR_USER);

      expect(orderModel.mock.calls[0][0].items[0].originalPrice).toBe(320);
    });

    it('writes originalPrice as null (recorded zero discount) when nothing provides one (D12)', async () => {
      await service.createImmediateSale(posDto(), VENDOR_USER);

      // The field is present-but-null on every new line: that is the coverage marker.
      const line = orderModel.mock.calls[0][0].items[0];
      expect(line).toHaveProperty('originalPrice');
      expect(line.originalPrice).toBeNull();
    });

    it('falls back to a De passage placeholder when no customer is supplied', async () => {
      await service.createImmediateSale(posDto(), VENDOR_USER);

      expect(orderModel.mock.calls[0][0].customer).toMatchObject({ name: 'De passage', phone: '' });
    });

    it('refuses a line whose product vanished instead of ringing it up at zero', async () => {
      productModel.find.mockReturnValue(query([]));

      await expect(service.createImmediateSale(posDto(), VENDOR_USER)).rejects.toMatchObject({
        errorCode: AppErrorCode.ORDER_PRODUCT_NOT_AVAILABLE,
      });
      expect(orderModel.startSession).not.toHaveBeenCalled();
    });

    it('rejects an empty cart before opening a transaction', async () => {
      await expect(
        service.createImmediateSale({ items: [] } as any, VENDOR_USER),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.POS_EMPTY_CART });
      expect(orderModel.startSession).not.toHaveBeenCalled();
    });

    it('rejects a caller that is neither vendor nor admin', async () => {
      await expect(
        service.createImmediateSale(posDto(), { ...VENDOR_USER, role: 'CUSTOMER' }),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.AUTH_VENDOR_ONLY });
      expect(storesService.findByVendorIdOrThrow).not.toHaveBeenCalled();
    });

    it('refuses a variant owned by another store without opening a transaction', async () => {
      variantsService.snapshotsForVariants.mockResolvedValue(
        new Map([[VARIANT_A.toString(), snapshot(VARIANT_A, { storeId: OTHER_STORE_ID.toString() })]]),
      );

      await expect(service.createImmediateSale(posDto(), VENDOR_USER)).rejects.toMatchObject({
        errorCode: AppErrorCode.VARIANT_NOT_FOUND,
      });
      expect(orderModel.startSession).not.toHaveBeenCalled();
    });

    it('refuses an unknown variant', async () => {
      variantsService.snapshotsForVariants.mockResolvedValue(new Map());

      await expect(service.createImmediateSale(posDto(), VENDOR_USER)).rejects.toMatchObject({
        errorCode: AppErrorCode.VARIANT_NOT_FOUND,
      });
    });

    it('refuses an inactive variant', async () => {
      variantsService.snapshotsForVariants.mockResolvedValue(
        new Map([[VARIANT_A.toString(), snapshot(VARIANT_A, { isActive: false })]]),
      );

      await expect(service.createImmediateSale(posDto(), VENDOR_USER)).rejects.toMatchObject({
        errorCode: AppErrorCode.VARIANT_INACTIVE,
      });
    });

    it('aborts the whole sale and leaks no session when stock cannot be reserved', async () => {
      reservations.reserve.mockRejectedValue(
        new AppException(AppErrorCode.INSUFFICIENT_STOCK, { requested: 2, available: 0 }),
      );

      await expect(service.createImmediateSale(posDto(), VENDOR_USER)).rejects.toMatchObject({
        errorCode: AppErrorCode.INSUFFICIENT_STOCK,
      });

      const session = sessions[1];
      expect(session.abortTransaction).toHaveBeenCalled();
      expect(session.endSession).toHaveBeenCalled();
      // Consumption never ran: reserve failed first, so nothing was deducted twice.
      expect(reservations.consume).not.toHaveBeenCalled();
      // The courtesy counter is not touched on a rolled-back sale.
      expect(storesService.incrementOrderCount).not.toHaveBeenCalled();
    });

    it('resolves the store from the session, never the body', async () => {
      const body = posDto({ storeId: OTHER_STORE_ID.toString(), vendorEmail: 'attacker@example.com' });

      await service.createImmediateSale(body, VENDOR_USER);

      expect(storesService.findByVendorIdOrThrow).toHaveBeenCalledWith(VENDOR_USER.id);
      expect(orderModel.mock.calls[0][0].storeId).toBe(STORE_ID);
      expect(orderModel.mock.calls[0][0].vendorEmail).toBe(STORE.vendorEmail);
    });

    it('is idempotent per line at the reservation layer (reserve is called with the line context)', async () => {
      const body = posDto({
        items: [
          { variantId: VARIANT_A.toString(), quantity: 1 },
          { variantId: VARIANT_A.toString(), quantity: 1 },
        ],
      });
      variantsService.snapshotsForVariants.mockResolvedValue(
        new Map([[VARIANT_A.toString(), snapshot(VARIANT_A)]]),
      );

      await service.createImmediateSale(body, VENDOR_USER);

      // Each line is addressed by its own index, so the same variant twice stays two distinct
      // reservations rather than collapsing into one (the engine's unique key is orderId+index).
      const ctxArg = reservations.reserve.mock.calls[0][0];
      expect(ctxArg.items).toHaveLength(2);
      expect(ctxArg.items[0].lineId).not.toBe(ctxArg.items[1].lineId);
    });
  });

  describe('POS holds — a parked sale reserves its stock', () => {
    // These live in the POS describe's harness: `posHoldModel` is callable so `new
    // posHoldModel(doc)` works, and the reservation engine is stubbed so the assertions are
    // about *when* reserve/release/reconcile/consume run and on which identity.
    let orderModel: any;
    let posHoldModel: any;
    let reservations: any;
    let storesService: any;
    let sessions: any[];

    const PRODUCT = new Types.ObjectId();
    const VARIANT = new Types.ObjectId();
    const HOLD_ID = new Types.ObjectId();
    const HOLD_STORE = { _id: STORE_ID, vendorEmail: 'store@imraaah.com' };

    const holdDoc = (over: Record<string, any> = {}) => ({
      _id: HOLD_ID,
      orderNo: '000007',
      storeId: STORE_ID,
      items: [
        {
          variantId: VARIANT.toString(),
          productId: PRODUCT.toString(),
          productName: 'Widget',
          quantity: 2,
          price: 250,
          originalPrice: null,
          lineId: new Types.ObjectId().toHexString(),
          sku: 'SKU-1',
          variantSnapshot: { options: [], label: 'Red / M' },
        },
      ],
      total: 500,
      customer: { name: 'Ali' },
      note: '',
      createdAt: new Date('2026-01-01T10:00:00.000Z'),
      updatedAt: new Date('2026-01-01T10:00:00.000Z'),
      ...over,
    });

    const snapshot = () => ({
      variantId: VARIANT.toString(),
      productId: PRODUCT.toString(),
      storeId: STORE_ID.toString(),
      sku: 'SKU-1',
      priceOverride: null,
      image: null,
      isActive: true,
      snapshot: { options: [], label: 'Red / M' },
    });

    beforeEach(async () => {
      sessions = [];

      orderModel = jest.fn().mockImplementation((doc: any) => ({
        ...doc,
        save: jest.fn().mockResolvedValue({ ...doc, toObject: () => ({ ...doc }) }),
      }));
      orderModel.findOne = jest.fn().mockReturnValue(query(undefined));
      orderModel.startSession = jest.fn(() => {
        const s = makeSession();
        sessions.push(s);
        return s;
      });

      posHoldModel = jest.fn().mockImplementation((doc: any) => ({
        ...doc,
        _id: HOLD_ID,
        save: jest.fn().mockResolvedValue({ ...doc, _id: HOLD_ID }),
      }));
      posHoldModel.findOne = jest.fn().mockReturnValue(query(undefined));
      posHoldModel.findOneAndUpdate = jest.fn();
      posHoldModel.findOneAndDelete = jest.fn();
      posHoldModel.find = jest.fn();
      posHoldModel.startSession = jest.fn(() => {
        const s = makeSession();
        sessions.push(s);
        return s;
      });

      storesService = {
        findByVendorIdOrThrow: jest.fn().mockResolvedValue(HOLD_STORE),
        incrementOrderCount: jest.fn().mockResolvedValue(undefined),
      };
      reservations = {
        reserve: jest.fn().mockResolvedValue(undefined),
        consume: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        reconcileEditedLines: jest.fn().mockResolvedValue(undefined),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          OrdersService,
          { provide: getModelToken(Order.name), useValue: orderModel },
          {
            provide: getModelToken(Counter.name),
            useValue: { findOneAndUpdate: jest.fn().mockReturnValue(query({ seq: 7 })) },
          },
          { provide: getModelToken(PosHold.name), useValue: posHoldModel },
          {
            provide: getModelToken(Product.name),
            useValue: {
              find: jest.fn().mockReturnValue(query([{ _id: PRODUCT, price: 250, nameEn: 'Widget' }])),
            },
          },
          { provide: DeliveryService, useValue: { createDeliveryForOrder: jest.fn() } },
          { provide: DeliveryFeesService, useValue: { getFeeByStoreId: jest.fn() } },
          {
            provide: OrderStatusesService,
            useValue: { getBySlug: jest.fn(async (slug: string) => statusConfig(slug)) },
          },
          { provide: StoresService, useValue: storesService },
          { provide: ReservationsService, useValue: reservations },
          {
            provide: VariantsService,
            useValue: {
              snapshotsForVariants: jest
                .fn()
                .mockResolvedValue(new Map([[VARIANT.toString(), snapshot()]])),
            },
          },
          { provide: AuditService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
        ],
      }).compile();

      service = module.get<OrdersService>(OrdersService);
    });

    const holdDto = (over: Record<string, any> = {}) =>
      ({ items: [{ variantId: VARIANT.toString(), quantity: 2 }], ...over }) as any;

    it('parks the cart, allocates the order number and reserves under the hold id', async () => {
      const view = await service.createPosHold(holdDto(), VENDOR_USER);

      expect(view).toMatchObject({
        id: HOLD_ID.toString(),
        storeId: STORE_ID.toString(),
        orderNo: '000007',
        total: 500,
      });
      expect(view.lines[0]).toMatchObject({
        variantId: VARIANT.toString(),
        name: 'Widget',
        label: 'Red / M',
        quantity: 2,
        available: 2,
      });

      expect(posHoldModel.mock.calls[0][0]).toMatchObject({
        storeId: STORE_ID,
        orderNo: '000007',
        total: 500,
      });
      const ctx = reservations.reserve.mock.calls[0][0];
      expect(ctx).toMatchObject({ orderNo: '000007', storeId: STORE_ID });
      expect(String(ctx.orderId)).toBe(HOLD_ID.toString());
      // Probe session is discarded; the real one drives the hold write and its reservation.
      expect(sessions[0].withTransaction).not.toHaveBeenCalled();
      expect(reservations.reserve.mock.calls[0][2]).toBe(sessions[1]);
    });

    it('aborts the hold write when the stock cannot be reserved', async () => {
      reservations.reserve.mockRejectedValueOnce(
        new AppException(AppErrorCode.INSUFFICIENT_STOCK, { variantId: VARIANT.toString() }),
      );

      await expect(service.createPosHold(holdDto(), VENDOR_USER)).rejects.toMatchObject({
        errorCode: AppErrorCode.INSUFFICIENT_STOCK,
      });
      expect(sessions[1].abortTransaction).toHaveBeenCalled();
    });

    it('reconciles the reservation when a parked cart is edited', async () => {
      posHoldModel.findOne.mockReturnValue(query(holdDoc()));
      posHoldModel.findOneAndUpdate.mockResolvedValue(
        holdDoc({ total: 750, items: [{ ...holdDoc().items[0], quantity: 3 }] }),
      );

      await service.updatePosHold(
        HOLD_ID.toString(),
        holdDto({ items: [{ variantId: VARIANT.toString(), quantity: 3 }] }),
        VENDOR_USER,
      );

      expect(posHoldModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: HOLD_ID, storeId: STORE_ID },
        expect.objectContaining({ $set: expect.objectContaining({ total: 750 }) }),
        expect.objectContaining({ new: true, session: sessions[1] }),
      );
      expect(reservations.reconcileEditedLines).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: HOLD_ID,
          items: [expect.objectContaining({ quantity: 3 })],
        }),
        expect.anything(),
        sessions[1],
      );
    });

    it('releases the reservation when a parked sale is discarded', async () => {
      posHoldModel.findOne.mockReturnValue(query(holdDoc()));
      posHoldModel.findOneAndDelete.mockResolvedValue(holdDoc());

      await expect(service.deletePosHold(HOLD_ID.toString(), VENDOR_USER)).resolves.toEqual({
        id: HOLD_ID.toString(),
        deleted: true,
      });

      expect(posHoldModel.findOneAndDelete).toHaveBeenCalledWith(
        { _id: HOLD_ID, storeId: STORE_ID },
        { session: sessions[1] },
      );
      expect(reservations.release).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: HOLD_ID, orderNo: '000007' }),
        expect.anything(),
        sessions[1],
      );
    });

    it('completes a hold into the same order identity, reconciles and consumes', async () => {
      posHoldModel.findOne.mockReturnValue(query(holdDoc()));
      posHoldModel.findOneAndDelete.mockResolvedValue(holdDoc());

      await service.completePosHold(HOLD_ID.toString(), holdDto(), VENDOR_USER);

      const doc = orderModel.mock.calls[0][0];
      expect(doc).toMatchObject({
        _id: HOLD_ID,
        orderNo: '000007',
        source: 'POS',
        shippingMethod: 'pickup',
        paymentMethod: 'CASH',
        total: 500,
      });
      expect(String(doc.items[0].variantId)).toBe(VARIANT.toString());
      const orderSession = sessions[1];
      expect(reservations.reconcileEditedLines).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: HOLD_ID, orderNo: '000007' }),
        expect.anything(),
        orderSession,
      );
      expect(reservations.consume).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: HOLD_ID, orderNo: '000007' }),
        expect.anything(),
        orderSession,
      );
      expect(storesService.incrementOrderCount).toHaveBeenCalledWith(HOLD_STORE.vendorEmail, 1);
    });

    it('lists only the session store’s holds, newest first', async () => {
      posHoldModel.find.mockReturnValue(query([holdDoc()]));

      const result = await service.listPosHolds(VENDOR_USER);

      expect(posHoldModel.find).toHaveBeenCalledWith({ storeId: STORE_ID });
      const q = posHoldModel.find.mock.results[0].value;
      expect(q.sort).toHaveBeenCalledWith({ createdAt: -1 });
      expect(result.data[0]).toMatchObject({ id: HOLD_ID.toString(), total: 500 });
    });

    it('refuses a hold that belongs to another store', async () => {
      posHoldModel.findOne.mockReturnValue(query(null));

      await expect(
        service.completePosHold(HOLD_ID.toString(), holdDto(), VENDOR_USER),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.POS_HOLD_NOT_FOUND });
      expect(reservations.consume).not.toHaveBeenCalled();
    });
  });

  describe('findAll() — order source filter (Phase 3)', () => {
    beforeEach(() => {
      orderModel.find = jest.fn().mockReturnValue(query([]));
      orderModel.countDocuments = jest.fn().mockReturnValue(query(0));
      orderModel.aggregate = jest.fn().mockReturnValue(query([]));
    });

    const filterOf = () => orderModel.find.mock.calls[0][0];

    it('adds the requested source to the query filter', async () => {
      await service.findAll({ source: 'POS' }, VENDOR_USER);

      expect(filterOf().source).toBe('POS');
    });

    it('composes the source filter with vendor scoping (cannot widen the tenant)', async () => {
      storesService.resolveStoreIdByEmail.mockResolvedValue(STORE_ID);

      await service.findAll({ source: 'POS' }, VENDOR_USER);

      expect(filterOf().source).toBe('POS');
      // Ownership and search/date predicates are combined under `$and`, so neither can
      // overwrite the other (previously both were assigned to `filter.$or`).
      expect(filterOf().$and).toContainEqual({
        $or: [{ storeId: STORE_ID }, { vendorEmail: VENDOR_USER.email }],
      });
    });

    it('does not constrain source when the query omits it', async () => {
      await service.findAll({}, VENDOR_USER);

      expect(filterOf().source).toBeUndefined();
    });

    it('lets an admin narrow by source without inheriting a store scope', async () => {
      await service.findAll({ source: 'MANUAL' }, ADMIN_USER);

      expect(filterOf().source).toBe('MANUAL');
      expect(filterOf().storeId).toBeUndefined();
      expect(filterOf().vendorEmail).toBeUndefined();
    });
  });

  describe('archive() / restore() — reversible hiding', () => {
    const orderWith = (slug: string, over: Record<string, any> = {}) =>
      makeOrder({ status: statusConfig(slug), ...over });

    beforeEach(() => {
      storesService.findByVendorId.mockResolvedValue(null);
    });

    it.each([
      OrderStatus.PLACED,
      OrderStatus.CANCELLED,
      OrderStatus.RETURNED,
      OrderStatus.DELIVERED,
    ])('archives a %s order and writes only the archive fields', async (slug) => {
      const existing = orderWith(slug);
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findOneAndUpdate.mockReturnValue(query({ ...existing, isArchived: true }));

      const result = await service.archive(ORDER_ID.toString(), VENDOR_USER);

      expect(result).toMatchObject({ id: ORDER_ID.toString(), archived: true });
      const [filter, update] = orderModel.findOneAndUpdate.mock.calls[0];
      expect(filter).toMatchObject({
        _id: ORDER_ID.toString(),
        isDeleted: { $ne: true },
        isArchived: { $ne: true },
      });
      expect(update).toEqual({
        $set: {
          isArchived: true,
          archivedAt: expect.any(Date),
          archivedBy: VENDOR_USER.email,
        },
      });
      // Archive has no inventory effect and does not touch status/history.
      expect(reservationsService.release).not.toHaveBeenCalled();
      expect(reservationsService.consume).not.toHaveBeenCalled();
      expect(update.$set.status).toBeUndefined();
      expect(update.$push?.history).toBeUndefined();
    });

    it.each([OrderStatus.CONFIRMED, OrderStatus.DISPATCHED, OrderStatus.IN_TRANSIT])(
      'refuses to archive a %s order until it is cancelled',
      async (slug) => {
        orderModel.findById.mockReturnValue(query(orderWith(slug)));

        await expect(service.archive(ORDER_ID.toString(), VENDOR_USER)).rejects.toMatchObject({
          errorCode: AppErrorCode.ORDER_ARCHIVE_NOT_ALLOWED,
          errorParams: expect.objectContaining({ status: slug }),
        });
        expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
      },
    );

    it('refuses an unknown status with ORDER_ARCHIVE_INVALID_STATUS', async () => {
      orderModel.findById.mockReturnValue(query(orderWith('mystery')));

      await expect(service.archive(ORDER_ID.toString(), VENDOR_USER)).rejects.toMatchObject({
        errorCode: AppErrorCode.ORDER_ARCHIVE_INVALID_STATUS,
      });
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('is idempotent for an already archived order', async () => {
      const existing = orderWith(OrderStatus.CANCELLED, {
        isArchived: true,
        archivedAt: new Date('2026-01-01T00:00:00Z'),
      });
      orderModel.findById.mockReturnValue(query(existing));

      const result = await service.archive(ORDER_ID.toString(), VENDOR_USER);

      expect(result).toMatchObject({ archived: true });
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('restore clears only the three archive fields', async () => {
      const existing = orderWith(OrderStatus.DELIVERED, {
        isArchived: true,
        archivedAt: new Date('2026-01-01T00:00:00Z'),
        archivedBy: VENDOR_USER.email,
      });
      orderModel.findById.mockReturnValue(query(existing));
      orderModel.findOneAndUpdate.mockReturnValue(query({ ...existing, isArchived: false }));

      const result = await service.restore(ORDER_ID.toString(), VENDOR_USER);

      expect(result).toEqual({ id: ORDER_ID.toString(), archived: false });
      const [filter, update] = orderModel.findOneAndUpdate.mock.calls[0];
      expect(filter).toMatchObject({
        _id: ORDER_ID.toString(),
        isDeleted: { $ne: true },
        isArchived: true,
      });
      expect(update).toEqual({
        $set: { isArchived: false, archivedAt: null, archivedBy: null },
      });
      expect(update.$set.status).toBeUndefined();
      expect(update.$push).toBeUndefined();
    });

    it('denies archive and restore across stores, but allows an admin', async () => {
      const foreign = orderWith(OrderStatus.CANCELLED, { storeId: OTHER_STORE_ID });
      storesService.findByVendorId.mockResolvedValue({ _id: STORE_ID });
      orderModel.findById.mockReturnValue(query(foreign));

      await expect(service.archive(ORDER_ID.toString(), VENDOR_USER)).rejects.toMatchObject({
        errorCode: AppErrorCode.AUTH_ORDER_OWNER_ONLY,
      });
      await expect(service.restore(ORDER_ID.toString(), VENDOR_USER)).rejects.toMatchObject({
        errorCode: AppErrorCode.AUTH_ORDER_OWNER_ONLY,
      });
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();

      orderModel.findOneAndUpdate.mockReturnValue(query({ ...foreign, isArchived: true }));
      await expect(service.archive(ORDER_ID.toString(), ADMIN_USER)).resolves.toMatchObject({
        archived: true,
      });
      // The admin claim keeps the status predicate but adds no store scope.
      expect(orderModel.findOneAndUpdate.mock.calls[0][0].$and).toEqual([
        {
          $or: [
            { 'status.slug': { $in: expect.any(Array) } },
            { status: { $in: expect.any(Array) } },
          ],
        },
      ]);
    });

    it('findAll scopes archived rows and keeps vendor search store-bound', async () => {
      orderModel.find = jest.fn().mockReturnValue(query([]));
      orderModel.countDocuments = jest.fn().mockReturnValue(query(0));
      orderModel.aggregate = jest.fn().mockReturnValue(query([]));
      storesService.resolveStoreIdByEmail.mockResolvedValue(STORE_ID);

      const filterOf = () => orderModel.find.mock.calls[0][0];

      await service.findAll({}, VENDOR_USER);
      expect(filterOf().isArchived).toEqual({ $ne: true });

      orderModel.find.mockClear();
      await service.findAll({ archived: 'true' }, VENDOR_USER);
      expect(filterOf().isArchived).toBe(true);

      orderModel.find.mockClear();
      await service.findAll({ search: 'ORD-1' }, VENDOR_USER);
      const filter = filterOf();
      expect(filter.$and).toEqual(
        expect.arrayContaining([
          { $or: [{ storeId: STORE_ID }, { vendorEmail: VENDOR_USER.email }] },
          expect.objectContaining({ $or: expect.any(Array) }),
        ]),
      );
    });
  });

  /**
   * The carrier-driven advance (roadmap §10.3, Phase 4 task 4.4).
   *
   * The carrier may move an order forward, and nothing else. These tests pin the four
   * properties the roadmap requires of that write: it is conditional on the status it moves
   * from, it never overwrites a terminal state, it never bypasses the transition map, and its
   * history entry says the carrier made the change.
   */
  describe('applyCarrierStatusAdvance() — the guarded carrier advance (Phase 4)', () => {
    const CARRIER = { system: 'zr-express-sync', user: 'ZR Express' };

    const advance = (over: { targetSlug?: string; expectedSlug?: string } = {}) =>
      service.applyCarrierStatusAdvance(
        ORDER_ID.toString(),
        over.targetSlug ?? OrderStatus.IN_TRANSIT,
        over.expectedSlug ?? OrderStatus.DISPATCHED,
        CARRIER,
        { storeId: STORE_ID.toString() },
      );

    it('claims the next step with a predicate on the status it moves from', async () => {
      orderModel.findById.mockReturnValue(query(makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) })));
      orderModel.findOneAndUpdate.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.IN_TRANSIT) })),
      );

      const result = await advance();

      expect(result.applied).toBe(true);
      expect(orderModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
      const [filter] = orderModel.findOneAndUpdate.mock.calls[0];
      expect(filter).toMatchObject({
        _id: ORDER_ID.toString(),
        $or: [{ 'status.slug': OrderStatus.DISPATCHED }, { status: OrderStatus.DISPATCHED }],
      });
    });

    it('scopes the claim to the store that owns the order', async () => {
      orderModel.findById.mockReturnValue(query(makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) })));
      orderModel.findOneAndUpdate.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.IN_TRANSIT) })),
      );

      await advance();

      const [filter] = orderModel.findOneAndUpdate.mock.calls[0];
      expect(String(filter.storeId)).toBe(STORE_ID.toString());
    });

    it('attributes the history entry to the carrier', async () => {
      orderModel.findById.mockReturnValue(query(makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) })));
      orderModel.findOneAndUpdate.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.IN_TRANSIT) })),
      );

      await advance();

      const [, update] = orderModel.findOneAndUpdate.mock.calls[0];
      expect(update.$push.history.user).toBe('ZR Express');
      expect(update.$push.history.status.slug).toBe(OrderStatus.IN_TRANSIT);
      expect(update.$set.status.slug).toBe(OrderStatus.IN_TRANSIT);
    });

    it('never overwrites a cancelled order — the vendor stays in charge', async () => {
      orderModel.findById.mockReturnValue(query(makeOrder({ status: statusConfig(OrderStatus.CANCELLED) })));

      const result = await advance();

      expect(result.applied).toBe(false);
      expect(result.conflict).toBe(true);
      expect(result.reason).toBe('order_cancelled_before_delivery');
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('never overwrites a returned order', async () => {
      orderModel.findById.mockReturnValue(query(makeOrder({ status: statusConfig(OrderStatus.RETURNED) })));

      const result = await advance();

      expect(result.applied).toBe(false);
      expect(result.conflict).toBe(true);
      expect(result.reason).toBe('order_already_returned');
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('never overwrites an order that was already delivered', async () => {
      orderModel.findById.mockReturnValue(query(makeOrder({ status: statusConfig(OrderStatus.DELIVERED) })));

      const result = await advance();

      expect(result.applied).toBe(false);
      expect(result.reason).toBe('order_already_delivered');
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('never touches a deleted order', async () => {
      orderModel.findById.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.DISPATCHED), isDeleted: true })),
      );

      const result = await advance();

      expect(result.applied).toBe(false);
      expect(result.reason).toBe('order_deleted');
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('refuses an order that belongs to another store', async () => {
      orderModel.findById.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.DISPATCHED), storeId: OTHER_STORE_ID })),
      );

      const result = await advance();

      expect(result.applied).toBe(false);
      expect(result.reason).toBe('order_not_in_store');
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('refuses an order whose owning store cannot be proven', async () => {
      orderModel.findById.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.DISPATCHED), storeId: undefined })),
      );

      const result = await advance();

      expect(result.applied).toBe(false);
      expect(result.reason).toBe('order_not_in_store');
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('reports a conflict when the claim loses the race', async () => {
      orderModel.findById
        .mockReturnValueOnce(query(makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) })))
        .mockReturnValueOnce(query(makeOrder({ status: statusConfig(OrderStatus.CANCELLED) })));
      orderModel.findOneAndUpdate.mockReturnValue(query(null));

      const result = await advance();

      expect(result.applied).toBe(false);
      expect(result.conflict).toBe(true);
      expect(result.reason).toBe('order_cancelled_before_delivery');
      expect(result.fromStatus).toBe(OrderStatus.CANCELLED);
    });

    it('never invents a step the transition map does not allow', async () => {
      orderModel.findById.mockReturnValue(query(makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) })));

      await expect(
        advance({ targetSlug: OrderStatus.DELIVERED, expectedSlug: OrderStatus.DISPATCHED }),
      ).rejects.toBeInstanceOf(AppException);

      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('does not touch the inventory — neither step reserves nor consumes', async () => {
      orderModel.findById.mockReturnValue(query(makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) })));
      orderModel.findOneAndUpdate.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.IN_TRANSIT) })),
      );

      await advance();

      expect(reservationsService.onStatusChange).not.toHaveBeenCalled();
      expect(reservationsService.reserve).not.toHaveBeenCalled();
      expect(reservationsService.consume).not.toHaveBeenCalled();
      expect(reservationsService.release).not.toHaveBeenCalled();
    });

    it('moves the order one step at a time — a delivered carrier cannot skip a status', async () => {
      orderModel.findById.mockReturnValue(query(makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) })));
      orderModel.findOneAndUpdate.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.IN_TRANSIT) })),
      );

      const result = await advance({
        targetSlug: OrderStatus.IN_TRANSIT,
        expectedSlug: OrderStatus.DISPATCHED,
      });

      expect(result.applied).toBe(true);
      const [, update] = orderModel.findOneAndUpdate.mock.calls[0];
      expect(update.$set.status.slug).toBe(OrderStatus.IN_TRANSIT);
    });
  });

  /**
   * The full carrier action matrix (behaviour refactor Phase 2).
   *
   * These pin the four outcomes a carrier may now request — advance, deliver, cancel and
   * return — and the two invariants that make them safe: only cancel is inventory-aware, and
   * the carrier-only return edges never leak into the global vendor transition map.
   */
  describe('applyCarrierOrderAction() — the carrier order matrix (Phase 2)', () => {
    const CARRIER = { system: 'zr-express-sync', user: 'ZR Express' };

    const act = (
      target: 'in-transit' | 'delivered' | 'cancelled' | 'returned',
      expectedSlug: string,
      steps?: string[],
    ) =>
      service.applyCarrierOrderAction(
        ORDER_ID.toString(),
        { target, steps },
        expectedSlug,
        CARRIER,
        { storeId: STORE_ID.toString() },
      );

    it('walks dispatched → in-transit → delivered in one cycle', async () => {
      orderModel.findById.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) })),
      );
      orderModel.findOneAndUpdate
        .mockReturnValueOnce(query(makeOrder({ status: statusConfig(OrderStatus.IN_TRANSIT) })))
        .mockReturnValueOnce(query(makeOrder({ status: statusConfig(OrderStatus.DELIVERED) })));

      const result = await act('delivered', OrderStatus.DISPATCHED);

      expect(result).toMatchObject({
        applied: true,
        fromStatus: OrderStatus.DISPATCHED,
        toStatus: OrderStatus.DELIVERED,
      });
      expect(orderModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
      expect(orderModel.findOneAndUpdate.mock.calls[0][0].$or).toEqual([
        { 'status.slug': OrderStatus.DISPATCHED },
        { status: OrderStatus.DISPATCHED },
      ]);
      expect(orderModel.findOneAndUpdate.mock.calls[1][0].$or).toEqual([
        { 'status.slug': OrderStatus.IN_TRANSIT },
        { status: OrderStatus.IN_TRANSIT },
      ]);
      expect(orderModel.findOneAndUpdate.mock.calls[1][1].$set.status.slug).toBe(
        OrderStatus.DELIVERED,
      );
      expect(reservationsService.onStatusChange).not.toHaveBeenCalled();
    });

    it('applies a direct carrier delivered from dispatched as two validated steps', async () => {
      orderModel.findById.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) })),
      );
      orderModel.findOneAndUpdate
        .mockReturnValueOnce(query(makeOrder({ status: statusConfig(OrderStatus.IN_TRANSIT) })))
        .mockReturnValueOnce(query(makeOrder({ status: statusConfig(OrderStatus.DELIVERED) })));

      await act('delivered', OrderStatus.DISPATCHED);

      expect(statusesService.validateTransition).toHaveBeenCalledWith(
        OrderStatus.DISPATCHED,
        OrderStatus.IN_TRANSIT,
      );
      expect(statusesService.validateTransition).toHaveBeenCalledWith(
        OrderStatus.IN_TRANSIT,
        OrderStatus.DELIVERED,
      );
    });

    it('cancels a confirmed order through the inventory-aware claim', async () => {
      orderModel.findById.mockReturnValue(
        query(
          makeOrder({
            status: statusConfig(OrderStatus.CONFIRMED),
            deliveryParcelId: 'PARCEL-1',
          }),
        ),
      );
      orderModel.findOneAndUpdate.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.CANCELLED) })),
      );

      const result = await act('cancelled', OrderStatus.CONFIRMED);

      expect(result.applied).toBe(true);
      expect(reservationsService.onStatusChange).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: ORDER_ID }),
        OrderStatus.CONFIRMED,
        OrderStatus.CANCELLED,
        null,
        expect.any(Object),
      );
      expect(reservationsService.release).not.toHaveBeenCalled();
      const [, update] = orderModel.findOneAndUpdate.mock.calls[0];
      expect(update.$push.history.user).toBe('ZR Express');
    });

    it('cancels a dispatched order without restoring stock itself', async () => {
      orderModel.findById.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) })),
      );
      orderModel.findOneAndUpdate.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.CANCELLED) })),
      );

      await act('cancelled', OrderStatus.DISPATCHED);

      expect(reservationsService.onStatusChange).toHaveBeenCalledWith(
        expect.anything(),
        OrderStatus.DISPATCHED,
        OrderStatus.CANCELLED,
        null,
        expect.any(Object),
      );
      // The post-dispatch rule lives in `onStatusChange`; the carrier path never restocks.
      expect(reservationsService.release).not.toHaveBeenCalled();
    });

    it('refuses a cancel from confirmed when no parcel exists (Q5)', async () => {
      orderModel.findById.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.CONFIRMED) })),
      );

      const result = await act('cancelled', OrderStatus.CONFIRMED);

      expect(result).toMatchObject({
        applied: false,
        conflict: true,
        reason: 'order_not_dispatched',
      });
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(reservationsService.onStatusChange).not.toHaveBeenCalled();
    });

    it('refuses a cancel after delivery', async () => {
      orderModel.findById.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.DELIVERED) })),
      );

      const result = await act('cancelled', OrderStatus.DELIVERED);

      expect(result).toMatchObject({
        applied: false,
        conflict: true,
        reason: 'order_already_delivered',
      });
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it.each([OrderStatus.DISPATCHED, OrderStatus.IN_TRANSIT, OrderStatus.DELIVERED])(
      'returns a %s order through the carrier-only edge, with no stock movement',
      async (current) => {
        orderModel.findById.mockReturnValue(query(makeOrder({ status: statusConfig(current) })));
        orderModel.findOneAndUpdate.mockReturnValue(
          query(makeOrder({ status: statusConfig(OrderStatus.RETURNED) })),
        );

        const result = await act('returned', current);

        expect(result.applied).toBe(true);
        expect(orderModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
        expect(orderModel.findOneAndUpdate.mock.calls[0][0].$or).toEqual([
          { 'status.slug': current },
          { status: current },
        ]);
        expect(orderModel.findOneAndUpdate.mock.calls[0][1].$set.status.slug).toBe(
          OrderStatus.RETURNED,
        );
        expect(reservationsService.onStatusChange).not.toHaveBeenCalled();
        expect(reservationsService.release).not.toHaveBeenCalled();
      },
    );

    it('does not add the carrier return edges to the global transition map', () => {
      expect(ORDER_STATUS_TRANSITIONS[OrderStatus.DISPATCHED]).not.toContain(
        OrderStatus.RETURNED,
      );
      expect(ORDER_STATUS_TRANSITIONS[OrderStatus.IN_TRANSIT]).not.toContain(
        OrderStatus.RETURNED,
      );
    });

    it('refuses a return before dispatch', async () => {
      orderModel.findById.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.CONFIRMED) })),
      );

      const result = await act('returned', OrderStatus.CONFIRMED);

      expect(result).toMatchObject({
        applied: false,
        conflict: true,
        reason: 'order_not_dispatched',
      });
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('treats a vendor-cancelled order as a conflict, not an overwrite', async () => {
      orderModel.findById.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.CANCELLED) })),
      );

      const result = await act('returned', OrderStatus.CANCELLED);

      expect(result).toMatchObject({
        applied: false,
        conflict: true,
        reason: 'order_cancelled_before_delivery',
      });
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('reports a conflict when the order was changed underneath the carrier', async () => {
      orderModel.findById
        .mockReturnValueOnce(query(makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) })))
        .mockReturnValueOnce(query(makeOrder({ status: statusConfig(OrderStatus.CANCELLED) })));
      orderModel.findOneAndUpdate.mockReturnValue(query(null));

      const result = await act('delivered', OrderStatus.DISPATCHED);

      expect(result).toMatchObject({
        applied: false,
        conflict: true,
        reason: 'order_cancelled_before_delivery',
        fromStatus: OrderStatus.CANCELLED,
      });
    });

    it('keeps the tenancy narrowing on every step', async () => {
      orderModel.findById.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) })),
      );
      orderModel.findOneAndUpdate
        .mockReturnValueOnce(query(makeOrder({ status: statusConfig(OrderStatus.IN_TRANSIT) })))
        .mockReturnValueOnce(query(makeOrder({ status: statusConfig(OrderStatus.DELIVERED) })));

      await act('delivered', OrderStatus.DISPATCHED);

      for (const call of orderModel.findOneAndUpdate.mock.calls) {
        expect(String(call[0].storeId)).toBe(STORE_ID.toString());
      }
    });

    it('refuses a caller-supplied path that does not end at the target', async () => {
      orderModel.findById.mockReturnValue(
        query(makeOrder({ status: statusConfig(OrderStatus.DISPATCHED) })),
      );

      await expect(
        act('delivered', OrderStatus.DISPATCHED, [OrderStatus.IN_TRANSIT]),
      ).rejects.toBeInstanceOf(AppException);
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });
});

