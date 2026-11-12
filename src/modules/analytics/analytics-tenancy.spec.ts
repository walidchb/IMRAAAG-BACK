import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService, StoreScope } from './analytics.service';
import { StoresService } from '../stores/stores.service';
import { Role } from '../../common/constants/roles.enum';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';

/**
 * Analytics tenancy isolation (roadmap Phase 1).
 *
 * Every read derives the store from the session (`req.user.id`) — a client-supplied `storeId`
 * in the query string is never read, so one vendor's numbers can never leak across stores. A
 * controller that trusted a query `storeId` would turn every aggregation below into a
 * cross-tenant leak, so the controller is exercised directly (guards are an HTTP concern and
 * are not run when a handler is invoked as a plain method); the role wiring is pinned via
 * metadata.
 */

const STORE_A = new Types.ObjectId();
const STORE_B = new Types.ObjectId();
const VENDOR_ID = new Types.ObjectId().toString();

const SESSION_REQ = { user: { id: VENDOR_ID } } as any;

describe('AnalyticsController tenancy', () => {
  let controller: AnalyticsController;
  let analytics: {
    summary: jest.Mock;
    trend: jest.Mock;
    channels: jest.Mock;
    ordersStatus: jest.Mock;
  };
  let stores: { findByMemberIdOrThrow: jest.Mock };

  beforeEach(async () => {
    analytics = {
      summary: jest.fn().mockResolvedValue({}),
      trend: jest.fn().mockResolvedValue({}),
      channels: jest.fn().mockResolvedValue({}),
      ordersStatus: jest.fn().mockResolvedValue({}),
    };
    stores = {
      findByMemberIdOrThrow: jest.fn().mockResolvedValue({
        _id: STORE_A,
        vendorEmail: 'vendor-a@store.test',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [
        { provide: AnalyticsService, useValue: analytics },
        { provide: StoresService, useValue: stores },
      ],
    }).compile();

    controller = module.get<AnalyticsController>(AnalyticsController);
  });

  const expectedScope = (): StoreScope => ({
    storeId: STORE_A,
    vendorEmail: 'vendor-a@store.test',
  });

  it('resolves the store from the session and never reads a smuggled storeId', async () => {
    const query = { preset: '7d', storeId: STORE_B.toHexString() };
    await controller.summary(query, SESSION_REQ);

    expect(stores.findByMemberIdOrThrow).toHaveBeenCalledWith(VENDOR_ID);
    expect(analytics.summary).toHaveBeenCalledWith(expectedScope(), query);
    expect(analytics.summary.mock.calls[0][0].storeId).toBe(STORE_A);
  });

  it('propagates a store-resolution failure without touching the aggregation', async () => {
    stores.findByMemberIdOrThrow.mockRejectedValue(
      new AppException(AppErrorCode.STORE_NOT_FOUND, { field: 'vendorId', value: VENDOR_ID }),
    );
    await expect(controller.summary({ preset: '7d' }, SESSION_REQ)).rejects.toMatchObject({
      errorCode: AppErrorCode.STORE_NOT_FOUND,
    });
    expect(analytics.summary).not.toHaveBeenCalled();
  });

  it('forwards every route to its service method with the session-derived scope', async () => {
    await controller.trend({ preset: '7d', bucket: 'day' }, SESSION_REQ);
    await controller.channels({ preset: '7d' }, SESSION_REQ);
    await controller.ordersStatus({ preset: '7d' }, SESSION_REQ);

    expect(analytics.trend).toHaveBeenCalledWith(expectedScope(), { preset: '7d', bucket: 'day' });
    expect(analytics.channels).toHaveBeenCalledWith(expectedScope(), { preset: '7d' });
    expect(analytics.ordersStatus).toHaveBeenCalledWith(expectedScope(), { preset: '7d' });
  });

  it('is restricted to VENDOR and ADMIN behind the RolesGuard', () => {
    expect(Reflect.getMetadata('roles', AnalyticsController)).toEqual([Role.VENDOR, Role.ADMIN]);
    const guards = Reflect.getMetadata('__guards__', AnalyticsController) ?? [];
    expect(guards.some((g: unknown) => g === RolesGuard)).toBe(true);
  });
});