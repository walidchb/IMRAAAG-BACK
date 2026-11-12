import { DeliveryStatusController } from './delivery-status.controller';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { Role } from '../../../common/constants/roles.enum';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';

const STORE_ID = '6ac400e26b1b2c3d4e5f6a71';
const OTHER_STORE_ID = '6ac400e26b1b2c3d4e5f6a72';
const ORDER_ID = '6ac400e26b1b2c3d4e5f6a73';
const PARCEL_ID = 'parcel-1';
const VENDOR_EMAIL = 'vendor@example.com';

const vendorSession = { id: 'user-1', email: VENDOR_EMAIL, role: Role.VENDOR };
const adminSession = { id: 'admin-1', email: 'admin@example.com', role: Role.ADMIN };

/**
 * The read endpoints (Phase 5).
 *
 * The contract these tests pin:
 *
 * - the store comes from the **session** — a vendor never names a store, and a smuggled one is
 *   ignored;
 * - an order or parcel that belongs to another store answers 404, exactly like one that does
 *   not exist;
 * - the health endpoint is scoped for a vendor and open for an operator;
 * - only an operator may force a sync cycle.
 */
describe('DeliveryStatusController — the read endpoints (Phase 5)', () => {
  let controller: DeliveryStatusController;
  let queryService: {
    getOrderView: jest.Mock;
    getParcelView: jest.Mock;
    refreshParcel: jest.Mock;
    getHealth: jest.Mock;
  };
  let statusService: {
    settings: Record<string, unknown>;
    lastCycleAt: Date | null;
    nextCycleAt: Date | null;
    runCycle: jest.Mock;
    enabledProviders: jest.Mock;
    settingsFor: jest.Mock;
  };
  let storesService: { findByMemberId: jest.Mock; findOne: jest.Mock };

  const build = (store: unknown = { _id: STORE_ID, vendorEmail: VENDOR_EMAIL }) => {
    queryService = {
      getOrderView: jest.fn().mockResolvedValue({ order: { orderNo: 'ORD-1' } }),
      getParcelView: jest.fn().mockResolvedValue({ parcel: { parcelId: PARCEL_ID } }),
      refreshParcel: jest.fn().mockResolvedValue({ parcel: { parcelId: PARCEL_ID } }),
      getHealth: jest.fn().mockResolvedValue({ enabled: true, stores: [], totals: {} }),
    };

    statusService = {
      settings: { enabled: true, intervalMinutes: 15 },
      lastCycleAt: new Date('2026-10-22T09:00:00.000Z'),
      nextCycleAt: new Date('2026-10-22T09:15:00.000Z'),
      runCycle: jest.fn().mockResolvedValue({ processed: 0 }),
      enabledProviders: jest.fn().mockReturnValue([{ companyId: 'zr-express' }]),
      settingsFor: jest.fn().mockReturnValue({ enabled: true, intervalMinutes: 15 }),
    };

    storesService = {
      findByMemberId: jest.fn().mockResolvedValue(store),
      findOne: jest.fn().mockResolvedValue({ _id: OTHER_STORE_ID, vendorEmail: 'other@example.com' }),
    };

    controller = new DeliveryStatusController(
      queryService as never,
      statusService as never,
      storesService as never,
    );
  };

  beforeEach(() => build());

  describe('the order read', () => {
    it('scopes the read to the store of the session', async () => {
      await controller.getOrderStatus({ user: vendorSession }, ORDER_ID);

      expect(storesService.findByMemberId).toHaveBeenCalledWith('user-1');
      expect(queryService.getOrderView).toHaveBeenCalledWith(STORE_ID, ORDER_ID, VENDOR_EMAIL);
    });

    it('ignores a store id the client tried to smuggle in', async () => {
      await controller.getOrderStatus({ user: vendorSession, storeId: OTHER_STORE_ID }, ORDER_ID);

      expect(queryService.getOrderView).toHaveBeenCalledWith(STORE_ID, ORDER_ID, VENDOR_EMAIL);
    });

    it('answers 404 when the order is not the store’s', async () => {
      queryService.getOrderView.mockResolvedValue(null);

      await expect(controller.getOrderStatus({ user: vendorSession }, ORDER_ID)).rejects.toBeInstanceOf(
        AppException,
      );

      try {
        await controller.getOrderStatus({ user: vendorSession }, ORDER_ID);
      } catch (error) {
        expect((error as AppException).errorCode).toBe(AppErrorCode.DELIVERY_STATUS_NOT_FOUND);
        expect((error as AppException).getStatus()).toBe(404);
      }
    });
  });

  describe('the parcel read', () => {
    it('scopes the read to the store of the session', async () => {
      await controller.getParcelStatus({ user: vendorSession }, PARCEL_ID);

      expect(queryService.getParcelView).toHaveBeenCalledWith(STORE_ID, PARCEL_ID, VENDOR_EMAIL);
    });

    it('answers 404 for a parcel the store does not own', async () => {
      queryService.getParcelView.mockResolvedValue(null);

      await expect(controller.getParcelStatus({ user: vendorSession }, PARCEL_ID)).rejects.toBeInstanceOf(
        AppException,
      );
    });
  });

  describe('the manual refresh', () => {
    it('scopes the refresh to the store of the session', async () => {
      await controller.refreshParcel({ user: vendorSession }, PARCEL_ID);

      expect(queryService.refreshParcel).toHaveBeenCalledWith(STORE_ID, PARCEL_ID, VENDOR_EMAIL);
    });

    it('answers 404 for a parcel the store does not own', async () => {
      queryService.refreshParcel.mockResolvedValue(null);

      await expect(controller.refreshParcel({ user: vendorSession }, PARCEL_ID)).rejects.toBeInstanceOf(
        AppException,
      );
    });
  });

  describe('the sync health', () => {
    it('covers only the vendor’s own store', async () => {
      await controller.getSyncHealth({ user: vendorSession });

      expect(queryService.getHealth).toHaveBeenCalledWith([STORE_ID], expect.any(Object));
    });

    it('ignores a store id the vendor tried to smuggle in', async () => {
      await controller.getSyncHealth({ user: vendorSession }, OTHER_STORE_ID);

      expect(queryService.getHealth).toHaveBeenCalledWith([STORE_ID], expect.any(Object));
    });

    it('covers every store for an operator who did not narrow the scope', async () => {
      build(null);
      storesService.findByMemberId.mockRejectedValue(new Error('no store'));

      await controller.getSyncHealth({ user: adminSession });

      expect(queryService.getHealth).toHaveBeenCalledWith(null, expect.any(Object));
    });

    it('narrows to the store an operator named', async () => {
      build(null);
      storesService.findByMemberId.mockRejectedValue(new Error('no store'));

      await controller.getSyncHealth({ user: adminSession }, OTHER_STORE_ID);

      expect(queryService.getHealth).toHaveBeenCalledWith([OTHER_STORE_ID], expect.any(Object));
    });

    it('refuses an operator who named no store and has none', async () => {
      build(null);
      storesService.findByMemberId.mockRejectedValue(new Error('no store'));

      await expect(controller.getSyncHealth({ user: adminSession })).resolves.toBeDefined();
      // An operator sees every store — that is the answer, not an error.
      expect(queryService.getHealth).toHaveBeenCalledWith(null, expect.any(Object));
    });

    it('answers the health with the master switch and the cycle window', async () => {
      await controller.getSyncHealth({ user: vendorSession });

      const [, options] = queryService.getHealth.mock.calls[0];
      expect(options.enabled).toBe(true);
      expect(options.intervalMinutes).toBe(15);
      expect(options.lastCycleAt).toEqual(statusService.lastCycleAt);
      expect(options.nextCycleAt).toEqual(statusService.nextCycleAt);
    });

    it('accepts dhd and reports the provider’s own enabled flag', async () => {
      statusService.settingsFor.mockReturnValue({ enabled: false, intervalMinutes: 20 });

      await controller.getSyncHealth({ user: vendorSession }, undefined, 'dhd');

      expect(statusService.settingsFor).toHaveBeenCalledWith('dhd');
      expect(queryService.getHealth.mock.calls[0][1]).toMatchObject({
        companyId: 'dhd',
        enabled: false,
        intervalMinutes: 20,
      });
    });

    it('still rejects an unknown provider', async () => {
      await expect(
        controller.getSyncHealth({ user: vendorSession }, undefined, 'not-a-carrier'),
      ).rejects.toBeInstanceOf(AppException);
    });
  });

  describe('the forced cycle', () => {
    it('runs every enabled provider when none is named', async () => {
      statusService.enabledProviders.mockReturnValue([
        { companyId: 'zr-express' },
        { companyId: 'ecom-delivery' },
      ]);

      const result = await controller.runSync({});

      expect(statusService.runCycle).toHaveBeenCalledTimes(2);
      expect((result as { providers: unknown[] }).providers).toHaveLength(2);
    });

    it('runs exactly the provider an operator named', async () => {
      await controller.runSync({ provider: 'ecom-delivery' });

      expect(statusService.runCycle).toHaveBeenCalledWith({ companyId: 'ecom-delivery' });
      expect(statusService.enabledProviders).not.toHaveBeenCalled();
    });

    it('does nothing when no provider is enabled', async () => {
      statusService.enabledProviders.mockReturnValue([]);

      const result = await controller.runSync({});

      expect(statusService.runCycle).not.toHaveBeenCalled();
      expect((result as { providers: unknown[] }).providers).toEqual([]);
    });
  });

  describe('the declared contract', () => {
    it('lets a vendor and an operator read, and only an operator force a cycle', () => {
      const proto = DeliveryStatusController.prototype;

      expect(Reflect.getMetadata(ROLES_KEY, proto.getOrderStatus)).toEqual([
        Role.VENDOR,
        Role.ADMIN,
      ]);
      expect(Reflect.getMetadata(ROLES_KEY, proto.getParcelStatus)).toEqual([
        Role.VENDOR,
        Role.ADMIN,
      ]);
      expect(Reflect.getMetadata(ROLES_KEY, proto.getSyncHealth)).toEqual([
        Role.VENDOR,
        Role.ADMIN,
      ]);
      expect(Reflect.getMetadata(ROLES_KEY, proto.refreshParcel)).toEqual([
        Role.VENDOR,
        Role.ADMIN,
      ]);
      expect(Reflect.getMetadata(ROLES_KEY, proto.runSync)).toEqual([Role.ADMIN]);
    });

    it('throttles every endpoint', () => {
      const proto = DeliveryStatusController.prototype;
      const limit = (method: unknown) =>
        Reflect.getMetadata('THROTTLER:LIMITdefault', method as never);

      expect(limit(proto.getOrderStatus)).toBe(30);
      expect(limit(proto.getParcelStatus)).toBe(30);
      expect(limit(proto.getSyncHealth)).toBe(10);
      expect(limit(proto.runSync)).toBe(1);
      expect(limit(proto.refreshParcel)).toBe(2);
    });
  });
});
