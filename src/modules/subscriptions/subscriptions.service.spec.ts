import { Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { SubscriptionsService } from './subscriptions.service';
import { PlansService } from './plans.service';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import {
  SubscriptionEventAction,
  SubscriptionStatus,
} from '../../common/constants/subscription.const';
import { openTransactionSession } from '../inventory/services/session.util';

jest.mock('../inventory/services/session.util', () => ({
  openTransactionSession: jest.fn(),
}));

const mockedOpenSession = openTransactionSession as jest.MockedFunction<
  typeof openTransactionSession
>;

const STORE_ID = '507f1f77bcf86cd799439011';
const PLAN_ID = '507f1f77bcf86cd799439012';
const SUB_ID = '507f1f77bcf86cd799439013';

const SNAPSHOT = {
  planVersion: 1,
  name: 'Basic',
  description: 'desc',
  price: 2500,
  currency: 'DZD' as const,
  durationDays: 30,
  limits: { maxOrders: 100, maxProducts: 50, maxTeamMembers: 2 },
  features: { pos: false },
  trial: { enabled: true, days: 14 },
};

function q(result: unknown) {
  const query: any = {
    session: jest.fn(() => query),
    lean: jest.fn(() => query),
    exec: jest.fn(async () => result),
  };
  return query;
}

function subDoc(overrides: Record<string, any> = {}) {
  return {
    _id: new Types.ObjectId(SUB_ID),
    storeId: new Types.ObjectId(STORE_ID),
    planId: new Types.ObjectId(PLAN_ID),
    planSnapshot: SNAPSHOT,
    status: SubscriptionStatus.ACTIVE,
    isTrial: false,
    startDate: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2026-02-01T00:00:00.000Z'),
    usage: { ordersUsed: 5 },
    source: 'admin_assigned',
    trialUsedAt: null,
    updatedAt: new Date('2026-01-10T00:00:00.000Z'),
    ...overrides,
  } as any;
}

const actor = { id: 'admin1', email: 'admin@imraaah.com' };

function build(options: {
  getForStore?: any;
  findById?: any;
  findOneAndUpdate?: any;
  create?: any;
}) {
  const subscriptionModel: any = {
    findOne: jest.fn(() => q(options.getForStore ?? null)),
    findById: jest.fn(() => q(options.findById ?? null)),
    findOneAndUpdate: jest.fn(() => q(options.findOneAndUpdate ?? null)),
    create: jest.fn(async (arg: any) => arg),
  };
  const eventModel: any = { create: jest.fn(options.create ?? (async () => ({}))) };
  const plansService: any = {
    getActiveById: jest.fn(),
    buildSnapshot: jest.fn(() => ({ ...SNAPSHOT })),
  };
  const configService: any = { get: jest.fn(() => false) };
  const service = new SubscriptionsService(
    subscriptionModel,
    eventModel,
    plansService as unknown as PlansService,
    configService as unknown as ConfigService,
  );
  return { service, subscriptionModel, eventModel, plansService };
}

beforeEach(() => {
  mockedOpenSession.mockRejectedValue(
    new AppException(AppErrorCode.INVALID_COMBINATION, { reason: 'transactions_unavailable' }),
  );
});

describe('SubscriptionsService lifecycle', () => {
  it('assigns a plan: snapshot, active status, usage reset, ASSIGNED event', async () => {
    const created = subDoc({ usage: { ordersUsed: 0 }, endDate: new Date('2026-12-31') });
    const { service, subscriptionModel, eventModel, plansService } = build({
      getForStore: null,
      findOneAndUpdate: created,
    });
    plansService.getActiveById.mockResolvedValue({ _id: new Types.ObjectId(PLAN_ID) });

    const result = await service.assignPlan(STORE_ID, PLAN_ID, actor);

    expect(result).toBe(created);
    const update = subscriptionModel.findOneAndUpdate.mock.calls[0][1];
    expect(update.$set.planSnapshot).toEqual(SNAPSHOT);
    expect(update.$set.status).toBe(SubscriptionStatus.ACTIVE);
    expect(update.$set['usage.ordersUsed']).toBe(0);
    expect(eventModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: SubscriptionEventAction.ASSIGNED }),
    );
  });

  it('refuses to replace an active subscription without replace:true', async () => {
    const { service, subscriptionModel, eventModel, plansService } = build({
      getForStore: subDoc({ endDate: new Date(Date.now() + 86400000) }),
    });
    plansService.getActiveById.mockResolvedValue({ _id: new Types.ObjectId(PLAN_ID) });

    await expect(service.assignPlan(STORE_ID, PLAN_ID, actor)).rejects.toBeInstanceOf(
      AppException,
    );
    expect(subscriptionModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(eventModel.create).not.toHaveBeenCalled();
  });

  it('rejects a repeat trial', async () => {
    const { service, plansService } = build({
      getForStore: subDoc({ status: SubscriptionStatus.EXPIRED, trialUsedAt: new Date() }),
    });
    plansService.getActiveById.mockResolvedValue({
      _id: new Types.ObjectId(PLAN_ID),
      trial: { enabled: true, days: 14 },
    });

    await expect(service.grantTrial(STORE_ID, PLAN_ID, actor)).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it('grants a trial with trialing status and trial dates', async () => {
    const created = subDoc({
      status: SubscriptionStatus.TRIALING,
      isTrial: true,
      usage: { ordersUsed: 0 },
    });
    const { service, subscriptionModel, plansService } = build({
      getForStore: null,
      findOneAndUpdate: created,
    });
    plansService.getActiveById.mockResolvedValue({
      _id: new Types.ObjectId(PLAN_ID),
      trial: { enabled: true, days: 14 },
    });

    await service.grantTrial(STORE_ID, PLAN_ID, actor);

    const set = subscriptionModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set.status).toBe(SubscriptionStatus.TRIALING);
    expect(set.isTrial).toBe(true);
    expect(set.trialUsedAt).toBeInstanceOf(Date);
  });

  it('changes plan: new snapshot, new period, usage reset', async () => {
    const current = subDoc();
    const updated = subDoc({ planSnapshot: { ...SNAPSHOT, name: 'Pro', planVersion: 2 } });
    const { service, subscriptionModel, plansService } = build({
      findById: current,
      findOneAndUpdate: updated,
    });
    plansService.getActiveById.mockResolvedValue({ _id: new Types.ObjectId(PLAN_ID) });
    plansService.buildSnapshot.mockReturnValue({ ...SNAPSHOT, name: 'Pro', planVersion: 2 });

    await service.changePlan(SUB_ID, PLAN_ID, actor, 'upgrade');

    const set = subscriptionModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set.planSnapshot.name).toBe('Pro');
    expect(set['usage.ordersUsed']).toBe(0);
    expect(set.status).toBe(SubscriptionStatus.ACTIVE);
  });

  it('extends the period and preserves usage', async () => {
    const current = subDoc({ endDate: new Date(Date.now() + 5 * 86400000) });
    const updated = subDoc({ endDate: new Date(Date.now() + 15 * 86400000) });
    const { service, subscriptionModel } = build({
      findById: current,
      findOneAndUpdate: updated,
    });

    await service.extend(SUB_ID, 10, actor, 'goodwill');

    const set = subscriptionModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set.endDate.getTime()).toBeGreaterThan(current.endDate.getTime());
    expect(set['usage.ordersUsed']).toBeUndefined();
  });

  it('refuses to extend a cancelled subscription', async () => {
    const { service } = build({ findById: subDoc({ status: SubscriptionStatus.CANCELLED }) });
    await expect(service.extend(SUB_ID, 5, actor)).rejects.toBeInstanceOf(AppException);
  });

  it('cancels immediately and retains dates', async () => {
    const current = subDoc();
    const updated = subDoc({ status: SubscriptionStatus.CANCELLED });
    const { service, subscriptionModel, eventModel } = build({
      findById: current,
      findOneAndUpdate: updated,
    });

    await service.cancel(SUB_ID, actor, 'churn');

    const set = subscriptionModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set.status).toBe(SubscriptionStatus.CANCELLED);
    expect(set.cancelledAt).toBeInstanceOf(Date);
    expect(eventModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: SubscriptionEventAction.CANCELLED }),
    );
  });

  it('reactivates a cancelled subscription with a new period and reset usage', async () => {
    const current = subDoc({ status: SubscriptionStatus.CANCELLED });
    const updated = subDoc({ status: SubscriptionStatus.ACTIVE });
    const { service, subscriptionModel } = build({
      findById: current,
      findOneAndUpdate: updated,
    });

    await service.reactivate(SUB_ID, actor, { days: 30 });

    const set = subscriptionModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set.status).toBe(SubscriptionStatus.ACTIVE);
    expect(set['usage.ordersUsed']).toBe(0);
    expect(set.isTrial).toBe(false);
  });

  it('writes a state conflict when the conditional update loses the race', async () => {
    const { service } = build({ findById: subDoc(), findOneAndUpdate: null });
    await expect(service.cancel(SUB_ID, actor)).rejects.toMatchObject({
      errorCode: AppErrorCode.SUBSCRIPTION_STATE_CONFLICT,
    });
  });

  it('never writes an event when the subscription write fails (rollback)', async () => {
    const current = subDoc();
    const { service, subscriptionModel, eventModel } = build({ findById: current });
    subscriptionModel.findOneAndUpdate.mockImplementation(() => {
      throw new Error('write failed');
    });

    await expect(service.cancel(SUB_ID, actor)).rejects.toThrow('write failed');
    expect(eventModel.create).not.toHaveBeenCalled();
  });
});
