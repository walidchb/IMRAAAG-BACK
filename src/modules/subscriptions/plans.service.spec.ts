import { Types } from 'mongoose';
import { PlansService } from './plans.service';
import {
  resolveEffectiveSubscriptionStatus,
  SubscriptionEventAction,
  SubscriptionStatus,
} from '../../common/constants/subscription.const';
import { AppException } from '../../common/errors/app-exception';

function leanQuery(result: unknown) {
  const q: any = { lean: jest.fn(() => q), exec: jest.fn(async () => result) };
  return q;
}

function docFrom(data: Record<string, unknown>) {
  const doc: any = {
    ...data,
    toObject() {
      return { ...this };
    },
    save: jest.fn(async () => undefined),
  };
  return doc;
}

function sessionMock(options: { transactionError?: Error } = {}) {
  const session: any = {
    startTransaction: jest.fn(async () => {
      if (options.transactionError) throw options.transactionError;
    }),
    abortTransaction: jest.fn(async () => undefined),
    endSession: jest.fn(async () => undefined),
    withTransaction: jest.fn(async (fn: () => Promise<void>) => fn()),
  };
  return session;
}

function buildService(overrides: {
  planModel?: any;
  subscriptionModel?: any;
  eventModel?: any;
}) {
  const planModel = overrides.planModel ?? {};
  const subscriptionModel = overrides.subscriptionModel ?? {};
  const eventModel = overrides.eventModel ?? {};
  const billingConfig = {
    getEnabledDurations: jest.fn(async () => [1, 3, 6, 12]),
    get: jest.fn(async () => ({
      enabledDurations: [1, 3, 6, 12],
      allDurations: [1, 3, 6, 12],
      updatedAt: null,
    })),
    update: jest.fn(),
  };
  return new PlansService(planModel, subscriptionModel, eventModel, billingConfig as any);
}

const PLAN_ID = '507f1f77bcf86cd799439011';

describe('resolveEffectiveSubscriptionStatus', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('returns cancelled regardless of dates', () => {
    expect(
      resolveEffectiveSubscriptionStatus(
        { status: SubscriptionStatus.CANCELLED, endDate: new Date('2027-01-01') },
        now,
      ),
    ).toBe(SubscriptionStatus.CANCELLED);
  });

  it('expires when the end date has passed', () => {
    expect(
      resolveEffectiveSubscriptionStatus(
        { status: SubscriptionStatus.ACTIVE, endDate: new Date('2026-05-31T23:59:59.000Z') },
        now,
      ),
    ).toBe(SubscriptionStatus.EXPIRED);
  });

  it('is active one millisecond before the end date', () => {
    expect(
      resolveEffectiveSubscriptionStatus(
        { status: SubscriptionStatus.ACTIVE, endDate: new Date('2026-06-01T00:00:00.001Z') },
        now,
      ),
    ).toBe(SubscriptionStatus.ACTIVE);
  });

  it('treats a null end date as perpetual active', () => {
    expect(
      resolveEffectiveSubscriptionStatus(
        { status: SubscriptionStatus.ACTIVE, endDate: null },
        now,
      ),
    ).toBe(SubscriptionStatus.ACTIVE);
  });

  it('flags a live trial as trialing', () => {
    expect(
      resolveEffectiveSubscriptionStatus(
        { status: SubscriptionStatus.TRIALING, isTrial: true, endDate: new Date('2026-06-10') },
        now,
      ),
    ).toBe(SubscriptionStatus.TRIALING);
  });

  it('is trialing while an included trial window is open', () => {
    expect(
      resolveEffectiveSubscriptionStatus(
        {
          status: SubscriptionStatus.ACTIVE,
          isTrial: false,
          endDate: new Date('2026-12-01'),
          trialEndsAt: new Date('2026-06-10'),
        },
        now,
      ),
    ).toBe(SubscriptionStatus.TRIALING);
  });

  it('is active once the included trial window has closed', () => {
    expect(
      resolveEffectiveSubscriptionStatus(
        {
          status: SubscriptionStatus.ACTIVE,
          isTrial: false,
          endDate: new Date('2026-12-01'),
          trialEndsAt: new Date('2026-05-01'),
        },
        now,
      ),
    ).toBe(SubscriptionStatus.ACTIVE);
  });

  it('expires when the paid end passes even if a trial window is recorded', () => {
    expect(
      resolveEffectiveSubscriptionStatus(
        {
          status: SubscriptionStatus.ACTIVE,
          isTrial: false,
          endDate: new Date('2026-05-01'),
          trialEndsAt: new Date('2026-04-01'),
        },
        now,
      ),
    ).toBe(SubscriptionStatus.EXPIRED);
  });
});

describe('PlansService', () => {
  it('creates a plan with a normalised name key and version 1', async () => {
    const created: any = docFrom({
      _id: new Types.ObjectId(PLAN_ID),
      name: 'Pro',
      nameKey: 'pro',
      price: 5000,
      currency: 'DZD',
      durationDays: 30,
      isActive: true,
      isDefaultForSignup: false,
      version: 1,
      limits: { maxOrders: null, maxProducts: null, maxTeamMembers: null },
      features: { pos: true },
      trial: { enabled: false, days: null },
    });
    const planModel = {
      findOne: jest.fn(() => leanQuery(null)),
      updateMany: jest.fn(() => ({ exec: jest.fn(async () => undefined) })),
      create: jest.fn(async () => created),
    };
    const eventModel = { create: jest.fn(async () => ({})) };
    const service = buildService({ planModel, eventModel });

    const result = await service.create(
      {
        name: '  Pro ',
        descriptionEn: 'English',
        descriptionFr: 'Français',
        descriptionAr: 'العربية',
        image: 'https://cdn.test/plan.webp',
        price: 5000,
        currency: 'DZD',
        durationDays: 30,
        billingMode: 'legacy',
        features: { pos: true },
      },
      { id: 'admin1', email: 'admin@imraaah.com' },
    );

    expect(planModel.findOne).toHaveBeenCalledWith({ nameKey: 'pro' });
    expect(planModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Pro',
        nameKey: 'pro',
        version: 1,
        description: 'English',
        descriptionEn: 'English',
        descriptionFr: 'Français',
        descriptionAr: 'العربية',
        image: 'https://cdn.test/plan.webp',
      }),
    );
    expect(result.version).toBe(1);
    expect(eventModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: SubscriptionEventAction.PLAN_CREATED }),
    );
  });

  it('rejects an inactive signup default before any write', async () => {
    const planModel = {
      findOne: jest.fn(() => leanQuery(null)),
      updateMany: jest.fn(),
      create: jest.fn(),
    };
    const service = buildService({ planModel });

    await expect(
      service.create(
        {
          name: 'Pro',
          price: 0,
          currency: 'DZD',
          durationDays: 30,
          billingMode: 'legacy',
          isActive: false,
          isDefaultForSignup: true,
        },
        { id: 'a', email: 'a@b.c' },
      ),
    ).rejects.toMatchObject({
      errorCode: 'VALIDATION_INVALID_VALUE',
      errorParams: { field: 'isDefaultForSignup', reason: 'default_requires_active' },
    });
    expect(planModel.updateMany).not.toHaveBeenCalled();
    expect(planModel.create).not.toHaveBeenCalled();
  });

  it('clears the previous default and creates the new one in one transaction', async () => {
    const created: any = docFrom({
      _id: new Types.ObjectId(PLAN_ID),
      name: 'Pro',
      nameKey: 'pro',
      price: 5000,
      currency: 'DZD',
      durationDays: 30,
      isActive: true,
      isDefaultForSignup: true,
      version: 1,
      limits: { maxOrders: null, maxProducts: null, maxTeamMembers: null },
      features: { pos: false },
      trial: { enabled: false, days: null },
    });
    const session = sessionMock();
    const planModel = {
      findOne: jest.fn(() => leanQuery(null)),
      updateMany: jest.fn(() => ({ exec: jest.fn(async () => undefined) })),
      create: jest.fn(async () => [created]),
      startSession: jest.fn(async () => session),
    };
    const service = buildService({ planModel, eventModel: { create: jest.fn(async () => ({})) } });

    await service.create(
      {
        name: 'Pro',
        price: 5000,
        currency: 'DZD',
        durationDays: 30,
        billingMode: 'legacy',
        isDefaultForSignup: true,
      },
      { id: 'admin1', email: 'admin@imraaah.com' },
    );

    expect(planModel.updateMany).toHaveBeenCalledWith(
      { isDefaultForSignup: true },
      { $set: { isDefaultForSignup: false } },
      { session },
    );
    expect(planModel.create).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'Pro', isDefaultForSignup: true })],
      { session },
    );
    expect(session.withTransaction).toHaveBeenCalled();
  });

  it('maps a duplicate default/name key to a domain conflict', async () => {
    const session = sessionMock();
    const duplicate: any = Object.assign(new Error('E11000 duplicate key'), {
      code: 11000,
      keyPattern: { nameKey: 1 },
    });
    const planModel = {
      findOne: jest.fn(() => leanQuery(null)),
      updateMany: jest.fn(() => ({ exec: jest.fn(async () => undefined) })),
      create: jest.fn(async () => {
        throw duplicate;
      }),
      startSession: jest.fn(async () => session),
    };
    const service = buildService({ planModel });

    await expect(
      service.create(
        {
          name: 'Pro',
          price: 0,
          currency: 'DZD',
          durationDays: 30,
          billingMode: 'legacy',
          isDefaultForSignup: true,
        },
        { id: 'a', email: 'a@b.c' },
      ),
    ).rejects.toMatchObject({ errorCode: 'SUBSCRIPTION_PLAN_NAME_TAKEN' });
  });

  it('fails before writing a default change when transactions are unavailable', async () => {
    const session = sessionMock({
      transactionError: new Error('Transaction numbers are only allowed on a replica set member'),
    });
    const planModel = {
      findOne: jest.fn(() => leanQuery(null)),
      updateMany: jest.fn(),
      create: jest.fn(),
      startSession: jest.fn(async () => session),
    };
    const service = buildService({ planModel });

    await expect(
      service.create(
        {
          name: 'Pro',
          price: 0,
          currency: 'DZD',
          durationDays: 30,
          billingMode: 'legacy',
          isDefaultForSignup: true,
        },
        { id: 'a', email: 'a@b.c' },
      ),
    ).rejects.toMatchObject({
      errorCode: 'INVALID_COMBINATION',
      errorParams: { reason: 'transactions_unavailable' },
    });
    expect(planModel.updateMany).not.toHaveBeenCalled();
    expect(planModel.create).not.toHaveBeenCalled();
  });

  it('rejects an inactive plan being made the signup default', async () => {
    const plan: any = docFrom({
      _id: new Types.ObjectId(PLAN_ID),
      name: 'Pro',
      nameKey: 'pro',
      price: 5000,
      durationDays: 30,
      isActive: false,
      isDefaultForSignup: false,
      version: 1,
      limits: { maxOrders: null, maxProducts: null, maxTeamMembers: null },
      features: { pos: false },
      trial: { enabled: false, days: null },
    });
    const planModel = {
      findById: jest.fn(() => ({ exec: jest.fn(async () => plan) })),
      updateMany: jest.fn(),
    };
    const service = buildService({ planModel });

    await expect(
      service.update(PLAN_ID, { isDefaultForSignup: true }, { id: 'a', email: 'a@b.c' }),
    ).rejects.toMatchObject({
      errorCode: 'VALIDATION_INVALID_VALUE',
      errorParams: { field: 'isDefaultForSignup', reason: 'default_requires_active' },
    });
    expect(plan.save).not.toHaveBeenCalled();
  });

  it('updates an active plan to default inside a transaction', async () => {
    const plan: any = docFrom({
      _id: new Types.ObjectId(PLAN_ID),
      name: 'Pro',
      nameKey: 'pro',
      price: 5000,
      durationDays: 30,
      isActive: true,
      isDefaultForSignup: false,
      version: 1,
      limits: { maxOrders: null, maxProducts: null, maxTeamMembers: null },
      features: { pos: false },
      trial: { enabled: false, days: null },
    });
    const session = sessionMock();
    const planModel = {
      findById: jest.fn(() => ({ exec: jest.fn(async () => plan) })),
      updateMany: jest.fn(() => ({ exec: jest.fn(async () => undefined) })),
      startSession: jest.fn(async () => session),
    };
    const service = buildService({ planModel, eventModel: { create: jest.fn(async () => ({})) } });

    await service.update(PLAN_ID, { isDefaultForSignup: true }, { id: 'a', email: 'a@b.c' });

    expect(planModel.updateMany).toHaveBeenCalledWith(
      { _id: { $ne: plan._id }, isDefaultForSignup: true },
      { $set: { isDefaultForSignup: false } },
      { session },
    );
    expect(plan.save).toHaveBeenCalledWith({ session });
  });

  it('rejects a duplicate plan name', async () => {
    const planModel: any = { findOne: jest.fn(() => leanQuery({ _id: 'x' })) };
    const service = buildService({ planModel });

    await expect(
      service.create(
        { name: 'Pro', price: 0, currency: 'DZD', durationDays: 30 },
        { id: 'a', email: 'a@b.c' },
      ),
    ).rejects.toBeInstanceOf(AppException);
    expect(planModel.create).toBeUndefined();
  });

  it('increments version on edit and never writes a subscription', async () => {
    const plan: any = docFrom({
      _id: new Types.ObjectId(PLAN_ID),
      name: 'Pro',
      nameKey: 'pro',
      description: undefined,
      price: 5000,
      durationDays: 30,
      isActive: true,
      isDefaultForSignup: false,
      version: 3,
      limits: { maxOrders: 10, maxProducts: null, maxTeamMembers: null },
      features: { pos: true },
      trial: { enabled: false, days: null },
    });
    plan.save = jest.fn(async () => undefined);

    const planModel = {
      findById: jest.fn(() => ({ exec: jest.fn(async () => plan) })),
      updateMany: jest.fn(() => ({ exec: jest.fn(async () => undefined) })),
    };
    const subscriptionModel = {
      aggregate: jest.fn(() => ({ exec: jest.fn(async () => []) })),
      updateOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };
    const eventModel = { create: jest.fn(async () => ({})) };
    const service = buildService({ planModel, subscriptionModel, eventModel });

    const result = await service.update(
      PLAN_ID,
      { price: 6000 },
      { id: 'admin1', email: 'admin@imraaah.com' },
    );

    expect(plan.version).toBe(4);
    expect(plan.price).toBe(6000);
    expect(plan.save).toHaveBeenCalled();
    // Snapshot invariant: no subscription write from a plan edit.
    expect(subscriptionModel.updateOne).not.toHaveBeenCalled();
    expect(subscriptionModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(eventModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: SubscriptionEventAction.PLAN_UPDATED }),
    );
    expect(result.version).toBe(4);
  });

  it('stores per-language descriptions and mirrors English into the legacy field', async () => {
    const plan: any = docFrom({
      _id: new Types.ObjectId(PLAN_ID),
      name: 'Pro',
      nameKey: 'pro',
      description: undefined,
      descriptionEn: undefined,
      descriptionFr: undefined,
      descriptionAr: undefined,
      price: 5000,
      durationDays: 30,
      isActive: true,
      isDefaultForSignup: false,
      version: 1,
      limits: { maxOrders: null, maxProducts: null, maxTeamMembers: null },
      features: { pos: false },
      trial: { enabled: false, days: null },
    });
    plan.save = jest.fn(async () => undefined);

    const planModel = {
      findById: jest.fn(() => ({ exec: jest.fn(async () => plan) })),
      updateMany: jest.fn(() => ({ exec: jest.fn(async () => undefined) })),
    };
    const subscriptionModel = { aggregate: jest.fn(() => ({ exec: jest.fn(async () => []) })) };
    const eventModel = { create: jest.fn(async () => ({})) };
    const service = buildService({ planModel, subscriptionModel, eventModel });

    const result = await service.update(
      PLAN_ID,
      { descriptionEn: 'English', descriptionFr: 'Français', descriptionAr: 'العربية' },
      { id: 'admin1', email: 'admin@imraaah.com' },
    );

    expect(plan.descriptionEn).toBe('English');
    expect(plan.descriptionFr).toBe('Français');
    expect(plan.descriptionAr).toBe('العربية');
    expect(plan.description).toBe('English');
    expect(result).toEqual(
      expect.objectContaining({
        description: 'English',
        descriptionEn: 'English',
        descriptionFr: 'Français',
        descriptionAr: 'العربية',
      }),
    );
  });

  it('refuses to assign an inactive plan', async () => {
    const plan: any = docFrom({ _id: new Types.ObjectId(PLAN_ID), isActive: false });
    const planModel = { findById: jest.fn(() => ({ exec: jest.fn(async () => plan) })) };
    const service = buildService({ planModel });

    await expect(service.getActiveById(PLAN_ID)).rejects.toBeInstanceOf(AppException);
  });

  it('lists all plans publicly (inactive flagged) with commercial fields and no admin metadata', async () => {
    const exec = jest.fn(async () => [
      {
        _id: new Types.ObjectId(PLAN_ID),
        name: 'Starter',
        description: 'For new stores',
        descriptionEn: 'For new stores',
        descriptionFr: 'Pour les nouvelles boutiques',
        descriptionAr: 'للمتاجر الجديدة',
        image: 'https://cdn.test/starter.webp',
        price: 2500,
        currency: 'DZD',
        durationDays: 30,
        isActive: true,
        isDefaultForSignup: true,
        limits: { maxOrders: 100, maxProducts: 50, maxTeamMembers: 3 },
        features: { pos: true },
        trial: { enabled: true, days: 7 },
        createdByAdminEmail: 'admin@imraaah.com',
      },
    ]);
    const lean = jest.fn(() => ({ exec }));
    const sort = jest.fn(() => ({ lean }));
    const planModel = { find: jest.fn(() => ({ sort })) };
    const service = buildService({ planModel });

    const items = await service.listPublic();

    expect(planModel.find).toHaveBeenCalledWith({});
    expect(sort).toHaveBeenCalledWith({ isActive: -1, price: 1, name: 1 });
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      id: PLAN_ID,
      name: 'Starter',
      description: 'For new stores',
      descriptionEn: 'For new stores',
      descriptionFr: 'Pour les nouvelles boutiques',
      descriptionAr: 'للمتاجر الجديدة',
      image: 'https://cdn.test/starter.webp',
      price: 2500,
      currency: 'DZD',
      durationDays: 30,
      billingMode: 'legacy',
      billingOptions: [],
      isActive: true,
      isDefaultForSignup: true,
      limits: { maxOrders: 100, maxProducts: 50, maxTeamMembers: 3 },
      features: { pos: true },
      trial: { enabled: true, days: 7 },
    });
    expect(items[0]).not.toHaveProperty('createdByAdminEmail');
    expect(items[0]).not.toHaveProperty('storeCount');
  });

  it('builds an immutable snapshot from the plan', async () => {
    const plan: any = docFrom({
      _id: new Types.ObjectId(PLAN_ID),
      name: 'Pro',
      description: 'desc',
      descriptionEn: 'desc-en',
      descriptionFr: 'desc-fr',
      descriptionAr: 'desc-ar',
      price: 5000,
      durationDays: 30,
      version: 7,
      limits: { maxOrders: 10, maxProducts: 20, maxTeamMembers: 1 },
      features: { pos: true },
      trial: { enabled: true, days: 14 },
    });
    const service = buildService({});

    const snapshot = service.buildSnapshot(plan);

    expect(snapshot).toEqual({
      planVersion: 7,
      name: 'Pro',
      description: 'desc',
      descriptionEn: 'desc-en',
      descriptionFr: 'desc-fr',
      descriptionAr: 'desc-ar',
      price: 5000,
      currency: 'DZD',
      durationDays: 30,
      limits: { maxOrders: 10, maxProducts: 20, maxTeamMembers: 1 },
      features: { pos: true },
      trial: { enabled: true, days: 14 },
    });
  });

  it('reads single-nested subdocuments instead of losing them to spread', () => {
    // Hydrated Mongoose documents expose `limits`/`features`/`trial` as SingleNested
    // subdocuments whose fields are non-enumerable prototype getters. `{ ...limits }` copies
    // only the defaults, which used to make `entitlements.ordersAllowance` null (1× fallback).
    const subdoc = (data: Record<string, unknown>): any => {
      const doc = Object.create({ toObject: () => ({ ...data, _id: 'nested-id' }) });
      for (const key of Object.keys(data)) {
        Object.defineProperty(doc, key, { get: () => data[key], enumerable: false });
      }
      return doc;
    };

    const plan: any = docFrom({
      _id: new Types.ObjectId(PLAN_ID),
      name: 'Bloom',
      price: 2900,
      currency: 'DZD',
      durationDays: 30,
      version: 1,
      billingMode: 'monthly',
      limits: subdoc({ maxOrders: 1, maxProducts: 100, maxTeamMembers: 3 }),
      features: subdoc({ pos: true }),
      trial: subdoc({ enabled: false, days: null }),
    });

    const snapshot = buildService({}).buildSnapshot(plan, {
      durationMonths: 3,
      discountPercent: 5,
    });

    expect(snapshot.limits).toEqual({ maxOrders: 1, maxProducts: 100, maxTeamMembers: 3 });
    expect(snapshot.features).toEqual({ pos: true });
    expect(snapshot.trial).toEqual({ enabled: false, days: null });
    expect(snapshot.entitlements).toMatchObject({
      monthlyOrders: 1,
      ordersAllowance: 3,
      maxProducts: 100,
      maxTeamMembers: 3,
      durationMonths: 3,
      features: { pos: true },
    });
  });
});

describe('PlansService.resolveBillingOption (global fixed durations)', () => {
  function serviceWith(enabledDurations: number[]) {
    return new PlansService(
      {} as any,
      {} as any,
      {} as any,
      { getEnabledDurations: jest.fn(async () => enabledDurations) } as any,
    );
  }

  const plan = {
    _id: '507f1f77bcf86cd799439011',
    billingMode: 'monthly',
    billingOptions: [
      { durationMonths: 6, discountPercent: 10 },
      { durationMonths: 12, discountPercent: 20 },
    ],
  } as any;

  it('synthesises the mandatory 1-month term when it is not stored', async () => {
    const option = await serviceWith([1, 3, 6, 12]).resolveBillingOption(plan);
    expect(option).toMatchObject({ durationMonths: 1, discountPercent: 0 });
  });

  it('refuses a globally disabled duration', async () => {
    await expect(
      serviceWith([1, 6]).resolveBillingOption(plan, { durationMonths: 12 }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('refuses an unsupported duration', async () => {
    await expect(
      serviceWith([1, 3, 6, 12]).resolveBillingOption(plan, { durationMonths: 2 }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('derives the price from the plan base and stored discount', async () => {
    const selected = await serviceWith([1, 3, 6, 12]).resolveBillingOption(plan, {
      durationMonths: 6,
    });
    const snapshot = serviceWith([1, 3, 6, 12]).buildSnapshot(
      { ...plan, price: 1000, version: 1, limits: {}, features: {}, trial: {} } as any,
      selected,
    );
    expect(snapshot.billing?.listPrice).toBe(6000);
    expect(snapshot.billing?.finalPrice).toBe(5400);
    expect(snapshot.billing?.savings).toBe(600);
  });
});
