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
    getDocumentById: jest.fn(),
    getDefaultSignupPlan: jest.fn(),
    findByCode: jest.fn(),
    resolveBillingOption: jest.fn(() => null),
    extensionAllowance: jest.fn(() => null),
    buildSnapshot: jest.fn(() => ({ ...SNAPSHOT })),
  };
  const configService: any = { get: jest.fn(() => false) };
  const service = new SubscriptionsService(
    subscriptionModel,
    eventModel,
    plansService as unknown as PlansService,
    configService as unknown as ConfigService,
  );
  return { service, subscriptionModel, eventModel, plansService, configService };
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

    await service.changePlan(SUB_ID, PLAN_ID, actor, { reason: 'upgrade' });

    const set = subscriptionModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set.planSnapshot.name).toBe('Pro');
    expect(set['usage.ordersUsed']).toBe(0);
    expect(set.status).toBe(SubscriptionStatus.ACTIVE);
  });

  it('assigns a plan with an included trial: trial first, then the paid period', async () => {
    const created = subDoc({ usage: { ordersUsed: 0 } });
    const { service, subscriptionModel, plansService } = build({
      getForStore: null,
      findOneAndUpdate: created,
    });
    plansService.getActiveById.mockResolvedValue({
      _id: new Types.ObjectId(PLAN_ID),
      trial: { enabled: true, days: 14 },
    });

    await service.assignPlan(STORE_ID, PLAN_ID, actor, { includeTrial: true });

    const set = subscriptionModel.findOneAndUpdate.mock.calls[0][1].$set;
    const day = 86_400_000;
    expect(set.isTrial).toBe(false);
    expect(set.status).toBe(SubscriptionStatus.ACTIVE);
    expect(set.trialStartedAt).toBeInstanceOf(Date);
    expect(set.trialUsedAt).toBeInstanceOf(Date);
    expect(set.trialEndsAt.getTime() - set.trialStartedAt.getTime()).toBe(14 * day);
    // Paid period starts when the trial ends and runs the plan's duration (legacy 30d).
    expect(set.endDate.getTime() - set.trialEndsAt.getTime()).toBe(30 * day);
  });

  it('changes plan with includeTrial: prepends the new trial before the paid period', async () => {
    const current = subDoc({ endDate: new Date(Date.now() + 5 * 86_400_000) });
    const updated = subDoc();
    const { service, subscriptionModel, plansService } = build({
      findById: current,
      findOneAndUpdate: updated,
    });
    plansService.getActiveById.mockResolvedValue({
      _id: new Types.ObjectId(PLAN_ID),
      trial: { enabled: true, days: 7 },
    });

    await service.changePlan(SUB_ID, PLAN_ID, actor, { includeTrial: true });

    const set = subscriptionModel.findOneAndUpdate.mock.calls[0][1].$set;
    const day = 86_400_000;
    expect(set.isTrial).toBe(false);
    expect(set.trialStartedAt.getTime()).toBe(set.startDate.getTime());
    expect(set.trialEndsAt.getTime() - set.trialStartedAt.getTime()).toBe(7 * day);
    expect(set.endDate.getTime() - set.trialEndsAt.getTime()).toBe(30 * day);
    expect(set.trialUsedAt).toBeInstanceOf(Date);
  });

  it('changes plan without a trial: paid period starts now and trial dates are cleared', async () => {
    const current = subDoc({
      trialStartedAt: new Date('2026-01-01'),
      trialEndsAt: new Date('2026-01-15'),
    });
    const updated = subDoc();
    const { service, subscriptionModel, plansService } = build({
      findById: current,
      findOneAndUpdate: updated,
    });
    plansService.getActiveById.mockResolvedValue({
      _id: new Types.ObjectId(PLAN_ID),
      trial: { enabled: true, days: 14 },
    });

    await service.changePlan(SUB_ID, PLAN_ID, actor);

    const set = subscriptionModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set.trialStartedAt).toBeNull();
    expect(set.trialEndsAt).toBeNull();
    expect(set.endDate.getTime() - set.startDate.getTime()).toBe(30 * 86_400_000);
  });

  it('refuses includeTrial when the plan has no trial', async () => {
    const { service, subscriptionModel, plansService } = build({
      findById: subDoc(),
      findOneAndUpdate: subDoc(),
    });
    plansService.getActiveById.mockResolvedValue({
      _id: new Types.ObjectId(PLAN_ID),
      trial: { enabled: false, days: null },
    });

    await expect(
      service.changePlan(SUB_ID, PLAN_ID, actor, { includeTrial: true }),
    ).rejects.toBeInstanceOf(AppException);
    expect(subscriptionModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('signup default assignment includes the plan trial automatically', async () => {
    const { service, subscriptionModel, eventModel, plansService, configService } = build({
      getForStore: null,
    });
    configService.get.mockImplementation((key: string) => key === 'subscriptions.featureEnforcementEnabled');
    const plan = {
      _id: new Types.ObjectId(PLAN_ID),
      billingMode: 'legacy',
      isActive: true,
      trial: { enabled: true, days: 14 },
    };
    plansService.getDefaultSignupPlan.mockResolvedValue(plan);

    await service.assignDefaultSignupPlan(STORE_ID, 'starter');

    const created = subscriptionModel.create.mock.calls[0][0];
    const day = 86_400_000;
    expect(created.startDate).toBeInstanceOf(Date);
    expect(created.trialStartedAt.getTime()).toBe(created.startDate.getTime());
    expect(created.trialEndsAt.getTime() - created.trialStartedAt.getTime()).toBe(14 * day);
    expect(created.endDate.getTime() - created.trialEndsAt.getTime()).toBe(30 * day);
    expect(created.trialUsedAt).toBeInstanceOf(Date);
    expect(created.isTrial).toBe(false);
    expect(eventModel.create).toHaveBeenCalledTimes(1);
  });

  it('signup default assignment without a trial starts the paid period now', async () => {
    const { service, subscriptionModel, plansService, configService } = build({
      getForStore: null,
    });
    configService.get.mockImplementation((key: string) => key === 'subscriptions.featureEnforcementEnabled');
    plansService.getDefaultSignupPlan.mockResolvedValue({
      _id: new Types.ObjectId(PLAN_ID),
      billingMode: 'legacy',
      isActive: true,
      trial: { enabled: false, days: null },
    });

    await service.assignDefaultSignupPlan(STORE_ID, 'starter');

    const created = subscriptionModel.create.mock.calls[0][0];
    expect(created.trialStartedAt).toBeNull();
    expect(created.trialEndsAt).toBeNull();
    expect(created.trialUsedAt).toBeNull();
    expect(created.endDate.getTime() - created.startDate.getTime()).toBe(30 * 86_400_000);
  });

  it('fails signup provisioning under the feature gate when no default plan exists', async () => {
    const { service, subscriptionModel, plansService, configService } = build({});
    configService.get.mockImplementation(
      (key: string) => key === 'subscriptions.featureEnforcementEnabled',
    );
    plansService.getDefaultSignupPlan.mockResolvedValue(null);
    plansService.findByCode.mockResolvedValue(null);

    await expect(service.assignDefaultSignupPlan(STORE_ID, 'starter')).rejects.toMatchObject({
      errorCode: AppErrorCode.SUBSCRIPTION_NOT_CONFIGURED,
      errorParams: { reason: 'no_default_plan' },
    });
    expect(subscriptionModel.create).not.toHaveBeenCalled();
  });

  it('assigns a fallback plan when feature enforcement is on but the display flag is off', async () => {
    const { service, subscriptionModel, plansService, configService } = build({});
    configService.get.mockImplementation(
      (key: string) => key === 'subscriptions.featureEnforcementEnabled',
    );
    plansService.getDefaultSignupPlan.mockResolvedValue(null);
    plansService.findByCode.mockResolvedValue({
      _id: new Types.ObjectId(PLAN_ID),
      billingMode: 'legacy',
      isActive: true,
      trial: { enabled: false, days: null },
    });

    await service.assignDefaultSignupPlan(STORE_ID, 'starter');
    expect(subscriptionModel.create).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when every subscription flag is off', async () => {
    const { service, subscriptionModel, plansService, configService } = build({});
    configService.get.mockReturnValue(false);

    await service.assignDefaultSignupPlan(STORE_ID, 'starter');
    expect(plansService.getDefaultSignupPlan).not.toHaveBeenCalled();
    expect(subscriptionModel.create).not.toHaveBeenCalled();
  });

  it('extends the period and preserves usage', async () => {
    const current = subDoc({ endDate: new Date(Date.now() + 5 * 86400000) });
    const updated = subDoc({ endDate: new Date(Date.now() + 15 * 86400000) });
    const { service, subscriptionModel } = build({
      findById: current,
      findOneAndUpdate: updated,
    });

    await service.extend(SUB_ID, { days: 10 }, actor, 'goodwill');

    const set = subscriptionModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set.endDate.getTime()).toBeGreaterThan(current.endDate.getTime());
    expect(set['usage.ordersUsed']).toBeUndefined();
  });

  it('refuses to extend a cancelled subscription', async () => {
    const { service } = build({ findById: subDoc({ status: SubscriptionStatus.CANCELLED }) });
    await expect(service.extend(SUB_ID, { days: 5 }, actor)).rejects.toBeInstanceOf(AppException);
  });

  const MONTHLY_SNAPSHOT = {
    ...SNAPSHOT,
    billing: {
      optionId: 'opt-1',
      durationMonths: 1,
      durationDays: 30,
      monthlyBasePrice: 2500,
      listPrice: 2500,
      discountPercent: 0,
      priceOverride: null,
      finalPrice: 2500,
      savings: 0,
      priceSource: 'calculated' as const,
      currency: 'DZD' as const,
    },
    entitlements: {
      monthlyOrders: 100,
      ordersAllowance: 100,
      maxProducts: 50,
      maxTeamMembers: 2,
      features: { pos: false },
      durationMonths: 1,
    },
  };
  const TRIAL_SNAPSHOT = {
    ...SNAPSHOT,
    billing: null,
    entitlements: {
      monthlyOrders: 100,
      ordersAllowance: 100,
      maxProducts: 50,
      maxTeamMembers: 2,
      features: { pos: false },
      durationMonths: null,
    },
  };

  it('leaves a legacy period-total allowance unchanged when extending time', async () => {
    const current = subDoc({
      endDate: new Date(Date.now() + 5 * 86400000),
      isTrial: false,
      planSnapshot: { ...SNAPSHOT, durationDays: 365 },
    });
    const { service, subscriptionModel, eventModel, plansService } = build({
      findById: current,
      findOneAndUpdate: subDoc(),
    });
    plansService.extensionAllowance.mockReturnValue(9999);

    await service.extend(SUB_ID, { months: 1 }, actor);

    const set = subscriptionModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set.planSnapshot).toBeUndefined();
    expect(plansService.extensionAllowance).not.toHaveBeenCalled();
    const event = eventModel.create.mock.calls[0][0];
    expect(event.details).toMatchObject({
      addedAllowance: null,
      allowancePolicy: 'legacy_period_total_unchanged',
    });
  });

  it('leaves a previously extended legacy row unchanged despite a synthetic entitlements block', async () => {
    const current = subDoc({
      endDate: new Date(Date.now() + 5 * 86400000),
      planSnapshot: { ...TRIAL_SNAPSHOT, entitlements: { ...TRIAL_SNAPSHOT.entitlements, durationMonths: null } },
    });
    const { service, subscriptionModel } = build({
      findById: current,
      findOneAndUpdate: subDoc(),
    });

    await service.extend(SUB_ID, { months: 1 }, actor);
    expect(subscriptionModel.findOneAndUpdate.mock.calls[0][1].$set.planSnapshot).toBeUndefined();
  });

  it('adds monthly allowance for a paid monthly extension and records the policy', async () => {
    const current = subDoc({
      endDate: new Date(Date.now() + 5 * 86400000),
      planSnapshot: MONTHLY_SNAPSHOT,
    });
    const { service, subscriptionModel, eventModel, plansService } = build({
      findById: current,
      findOneAndUpdate: subDoc(),
    });
    plansService.extensionAllowance.mockReturnValue(300);

    await service.extend(SUB_ID, { months: 3 }, actor);

    const set = subscriptionModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set.planSnapshot.entitlements.ordersAllowance).toBe(400);
    const event = eventModel.create.mock.calls[0][0];
    expect(event.details).toMatchObject({
      addedAllowance: 300,
      allowancePolicy: 'monthly_allowance_added',
    });
  });

  it('requires paid terms to reactivate an expired monthly pure trial', async () => {
    const current = subDoc({
      isTrial: true,
      status: SubscriptionStatus.EXPIRED,
      endDate: new Date(Date.now() - 86400000),
      planSnapshot: TRIAL_SNAPSHOT,
    });
    const { service, plansService } = build({ findById: current });
    plansService.getDocumentById.mockResolvedValue({
      _id: new Types.ObjectId(PLAN_ID),
      billingMode: 'monthly',
      isActive: true,
    });

    await expect(service.reactivate(SUB_ID, actor)).rejects.toMatchObject({
      errorCode: AppErrorCode.SUBSCRIPTION_BILLING_OPTION_REQUIRED,
      errorParams: { reason: 'trial_conversion_requires_paid_terms' },
    });
    expect(plansService.buildSnapshot).not.toHaveBeenCalled();
  });

  it('converts an expired monthly pure trial to a fresh paid snapshot', async () => {
    const current = subDoc({
      isTrial: true,
      status: SubscriptionStatus.EXPIRED,
      endDate: new Date(Date.now() - 86400000),
      planSnapshot: TRIAL_SNAPSHOT,
    });
    const { service, subscriptionModel, eventModel, plansService } = build({
      findById: current,
      findOneAndUpdate: subDoc({ status: SubscriptionStatus.ACTIVE }),
    });
    plansService.getDocumentById.mockResolvedValue({
      _id: new Types.ObjectId(PLAN_ID),
      billingMode: 'monthly',
      isActive: true,
    });
    plansService.resolveBillingOption.mockResolvedValue({ durationMonths: 3, discountPercent: 0 });
    plansService.buildSnapshot.mockReturnValue(MONTHLY_SNAPSHOT);

    await service.reactivate(SUB_ID, actor, { durationMonths: 3 });

    const set = subscriptionModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set.isTrial).toBe(false);
    expect(set.planSnapshot).toBe(MONTHLY_SNAPSHOT);
    expect(set.planSnapshot.billing.finalPrice).toBe(2500);
    expect(eventModel.create.mock.calls[0][0].details).toMatchObject({
      convertedFromTrial: true,
      finalPrice: 2500,
    });
  });

  it('refuses sameTerms when the trial snapshot has no billing record', async () => {
    const current = subDoc({
      isTrial: true,
      status: SubscriptionStatus.EXPIRED,
      endDate: new Date(Date.now() - 86400000),
      planSnapshot: TRIAL_SNAPSHOT,
    });
    const { service } = build({ findById: current });

    await expect(service.reactivate(SUB_ID, actor, { sameTerms: true })).rejects.toMatchObject({
      errorCode: AppErrorCode.SUBSCRIPTION_STATE_CONFLICT,
    });
  });

  it('requires an explicit period to reactivate a legacy pure trial and preserves the snapshot', async () => {
    const current = subDoc({
      isTrial: true,
      status: SubscriptionStatus.EXPIRED,
      endDate: new Date(Date.now() - 86400000),
      planSnapshot: SNAPSHOT,
    });
    const refused = build({ findById: current });
    refused.plansService.getDocumentById.mockResolvedValue(null);
    await expect(refused.service.reactivate(SUB_ID, actor)).rejects.toMatchObject({
      errorCode: AppErrorCode.SUBSCRIPTION_INVALID_DATES,
    });

    const accepted = build({
      findById: current,
      findOneAndUpdate: subDoc({ status: SubscriptionStatus.ACTIVE }),
    });
    accepted.plansService.getDocumentById.mockResolvedValue(null);

    await accepted.service.reactivate(SUB_ID, actor, { months: 2 });
    const set = accepted.subscriptionModel.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set.planSnapshot).toBe(SNAPSHOT);
    expect(accepted.eventModel.create.mock.calls[0][0].details).toMatchObject({
      convertedFromTrial: true,
      price: SNAPSHOT.price,
      durationDays: SNAPSHOT.durationDays,
    });
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
