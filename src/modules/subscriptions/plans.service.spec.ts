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

function buildService(overrides: {
  planModel?: any;
  subscriptionModel?: any;
  eventModel?: any;
}) {
  const planModel = overrides.planModel ?? {};
  const subscriptionModel = overrides.subscriptionModel ?? {};
  const eventModel = overrides.eventModel ?? {};
  return new PlansService(planModel, subscriptionModel, eventModel);
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
        price: 5000,
        currency: 'DZD',
        durationDays: 30,
        features: { pos: true },
      },
      { id: 'admin1', email: 'admin@imraaah.com' },
    );

    expect(planModel.findOne).toHaveBeenCalledWith({ nameKey: 'pro' });
    expect(planModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Pro', nameKey: 'pro', version: 1 }),
    );
    expect(result.version).toBe(1);
    expect(eventModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: SubscriptionEventAction.PLAN_CREATED }),
    );
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

  it('refuses to assign an inactive plan', async () => {
    const plan: any = docFrom({ _id: new Types.ObjectId(PLAN_ID), isActive: false });
    const planModel = { findById: jest.fn(() => ({ exec: jest.fn(async () => plan) })) };
    const service = buildService({ planModel });

    await expect(service.getActiveById(PLAN_ID)).rejects.toBeInstanceOf(AppException);
  });

  it('builds an immutable snapshot from the plan', async () => {
    const plan: any = docFrom({
      _id: new Types.ObjectId(PLAN_ID),
      name: 'Pro',
      description: 'desc',
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
      price: 5000,
      currency: 'DZD',
      durationDays: 30,
      limits: { maxOrders: 10, maxProducts: 20, maxTeamMembers: 1 },
      features: { pos: true },
      trial: { enabled: true, days: 14 },
    });
  });
});
