import { Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { SubscriptionAccessService } from './subscription-access.service';
import { SubscriptionStatus } from '../../common/constants/subscription.const';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { openTransactionSession } from '../inventory/services/session.util';

jest.mock('../inventory/services/session.util', () => ({
  openTransactionSession: jest.fn(),
}));

const mockedOpenSession = openTransactionSession as jest.MockedFunction<
  typeof openTransactionSession
>;

const STORE_ID = '507f1f77bcf86cd799439011';

function q(result: unknown) {
  const query: any = {
    session: jest.fn(() => query),
    exec: jest.fn(async () => result),
  };
  return query;
}

function subDoc(overrides: Record<string, any> = {}) {
  const now = Date.now();
  return {
    _id: new Types.ObjectId(),
    storeId: new Types.ObjectId(STORE_ID),
    status: SubscriptionStatus.ACTIVE,
    isTrial: false,
    startDate: new Date(now - 86_400_000),
    endDate: new Date(now + 86_400_000),
    planSnapshot: {
      planVersion: 1,
      name: 'Basic',
      price: 0,
      currency: 'DZD',
      durationDays: 30,
      limits: { maxOrders: 100, maxProducts: 50, maxTeamMembers: 2 },
      features: { pos: false },
      trial: { enabled: false, days: null },
    },
    usage: { ordersUsed: 0 },
    ...overrides,
  } as any;
}

function build(options: {
  subscription?: any;
  activeProducts?: number;
  activeMembers?: number;
  ownerMembers?: number;
  pendingInvitations?: number;
  enforcement?: boolean;
  featureEnforcement?: boolean;
  enabled?: boolean;
}) {
  const subscriptionModel: any = {
    findOne: jest.fn(() => q(options.subscription ?? null)),
    find: jest.fn(() => q(options.subscription ? [options.subscription] : [])),
    findOneAndUpdate: jest.fn(() => q(options.subscription ?? null)),
  };
  const productModel: any = {
    countDocuments: jest.fn(() => q(options.activeProducts ?? 0)),
  };
  // Two count calls on the member model: active members, then owner members.
  let memberCall = 0;
  const memberModel: any = {
    countDocuments: jest.fn(() => {
      memberCall += 1;
      return q(memberCall === 1 ? options.activeMembers ?? 0 : options.ownerMembers ?? 0);
    }),
  };
  const invitationModel: any = {
    countDocuments: jest.fn(() => q(options.pendingInvitations ?? 0)),
  };
  const configService: any = {
    get: jest.fn((key: string) => {
      if (key === 'subscriptions.enforcementEnabled') return Boolean(options.enforcement);
      if (key === 'subscriptions.featureEnforcementEnabled') {
        return Boolean(options.featureEnforcement);
      }
      return options.enabled ?? true;
    }),
  };
  const service = new SubscriptionAccessService(
    subscriptionModel,
    productModel,
    memberModel,
    invitationModel,
    configService as unknown as ConfigService,
  );
  return { service, subscriptionModel, productModel, memberModel, invitationModel };
}

describe('SubscriptionAccessService', () => {
  it('expires at the end boundary and is active 1ms before it', async () => {
    const now = Date.now();
    const expired = build({ subscription: subDoc({ endDate: new Date(now - 1) }) });
    expect((await expired.service.getEntitlement(STORE_ID)).effectiveStatus).toBe(
      SubscriptionStatus.EXPIRED,
    );

    const live = build({ subscription: subDoc({ endDate: new Date(now + 60_000) }) });
    expect((await live.service.getEntitlement(STORE_ID)).effectiveStatus).toBe(
      SubscriptionStatus.ACTIVE,
    );
  });

  it('treats a null end date as perpetual', async () => {
    const { service } = build({ subscription: subDoc({ endDate: null }) });
    expect((await service.getEntitlement(STORE_ID)).effectiveStatus).toBe(
      SubscriptionStatus.ACTIVE,
    );
  });

  it('fails closed for a missing subscription only when enforcement is on', async () => {
    const off = build({ subscription: null, enforcement: false });
    const offEnt = await off.service.getEntitlement(STORE_ID);
    expect(offEnt.entitled).toBe(true);
    expect(offEnt.features.pos).toBe(true);

    const on = build({ subscription: null, enforcement: true });
    const onEnt = await on.service.getEntitlement(STORE_ID);
    expect(onEnt.entitled).toBe(false);
    expect(onEnt.features.pos).toBe(false);
  });

  it('fails closed for a corrupt snapshot when enforcement is on', async () => {
    const { service } = build({ subscription: subDoc({ planSnapshot: {} }), enforcement: true });
    const entitlement = await service.getEntitlement(STORE_ID);
    expect(entitlement.entitled).toBe(false);
  });

  it('enforces team/POS/product caps through the feature gate while an active subscription still accepts orders', async () => {
    const { service } = build({
      subscription: subDoc(),
      enforcement: false,
      featureEnforcement: true,
      activeMembers: 2,
      ownerMembers: 1,
      activeProducts: 49,
    });
    const caps = await service.getCapabilities(STORE_ID);
    expect(caps.canUsePos).toBe(false);
    expect(caps.canInviteTeam).toBe(false);
    // Product limits follow the feature gate; the order quota is still dark.
    expect(caps.canCreateProduct).toBe(true);
    // An active, valid subscription is entitled, so order acceptance is true even in
    // feature-only mode.
    expect(caps.acceptingOrders).toBe(true);
  });

  it('enforces the product cap through the feature gate while broad enforcement is off', async () => {
    const { service } = build({
      subscription: subDoc(),
      enforcement: false,
      featureEnforcement: true,
      activeProducts: 50,
    });
    const caps = await service.getCapabilities(STORE_ID);
    expect(caps.canCreateProduct).toBe(false);
    expect(caps.canActivateProduct).toBe(false);
    expect(caps.acceptingOrders).toBe(true);
  });

  it('fails team/POS/order acceptance closed for a missing subscription under the feature gate only', async () => {
    const { service } = build({ subscription: null, enforcement: false, featureEnforcement: true });
    const caps = await service.getCapabilities(STORE_ID);
    expect(caps.canUsePos).toBe(false);
    expect(caps.canInviteTeam).toBe(false);
    // A missing subscription has no plan shape to gate on; the page stays viewable.
    expect(caps.canManageTeam).toBe(true);
    // The public state and the order writer fail closed under the feature gate.
    expect(caps.acceptingOrders).toBe(false);
    expect((await service.getPublicState(STORE_ID)).acceptingOrders).toBe(false);
  });

  it('closes team management on a one-seat plan but keeps it for a real team', async () => {
    const oneSeat = build({
      subscription: subDoc({
        planSnapshot: {
          ...subDoc().planSnapshot,
          limits: { maxOrders: 100, maxProducts: 50, maxTeamMembers: 1 },
        },
      }),
      enforcement: true,
      activeMembers: 1,
      ownerMembers: 1,
    });
    const single = await oneSeat.service.getCapabilities(STORE_ID);
    expect(single.canManageTeam).toBe(false);
    expect(single.canInviteTeam).toBe(false);

    const twoSeats = build({
      subscription: subDoc({
        planSnapshot: {
          ...subDoc().planSnapshot,
          limits: { maxOrders: 100, maxProducts: 50, maxTeamMembers: 2 },
        },
      }),
      enforcement: true,
      activeMembers: 1,
      ownerMembers: 1,
    });
    expect((await twoSeats.service.getCapabilities(STORE_ID)).canManageTeam).toBe(true);

    const unlimited = build({
      subscription: subDoc({
        planSnapshot: {
          ...subDoc().planSnapshot,
          limits: { maxOrders: 100, maxProducts: 50, maxTeamMembers: null },
        },
      }),
      enforcement: true,
      activeMembers: 5,
      ownerMembers: 1,
    });
    expect((await unlimited.service.getCapabilities(STORE_ID)).canManageTeam).toBe(true);
  });

  it('never closes team management while feature enforcement is off', async () => {
    const { service } = build({
      subscription: subDoc({
        planSnapshot: {
          ...subDoc().planSnapshot,
          limits: { maxOrders: 100, maxProducts: 50, maxTeamMembers: 1 },
        },
      }),
      enforcement: false,
    });
    expect((await service.getCapabilities(STORE_ID)).canManageTeam).toBe(true);
  });

  it('counts the owner seat when no Owner membership row exists', async () => {
    const { service } = build({
      subscription: subDoc(),
      activeMembers: 2,
      ownerMembers: 0,
      pendingInvitations: 1,
    });
    const usage = await service.getUsage(STORE_ID);
    expect(usage.teamSeats).toBe(3);
    expect(usage.pendingInvitations).toBe(1);
  });

  it('does not double-count an existing Owner membership', async () => {
    const { service } = build({
      subscription: subDoc(),
      activeMembers: 2,
      ownerMembers: 1,
    });
    expect((await service.getUsage(STORE_ID)).teamSeats).toBe(2);
  });

  it('blocks POS when the plan does not include it, regardless of entitlement', async () => {
    const { service } = build({ subscription: subDoc(), enforcement: true });
    const caps = await service.getCapabilities(STORE_ID);
    expect(caps.canUsePos).toBe(false);
  });

  it('withdraws POS and team-invite capabilities from an expired subscription', async () => {
    const now = Date.now();
    const expiredButPosPlan = subDoc({
      endDate: new Date(now - 1),
      planSnapshot: {
        ...subDoc().planSnapshot,
        limits: { maxOrders: 100, maxProducts: 50, maxTeamMembers: 5 },
        features: { pos: true },
      },
    });
    const { service } = build({
      subscription: expiredButPosPlan,
      enforcement: true,
      activeMembers: 1,
      ownerMembers: 1,
      pendingInvitations: 0,
    });
    const caps = await service.getCapabilities(STORE_ID);
    expect(caps.canUsePos).toBe(false);
    expect(caps.canInviteTeam).toBe(false);
    // The team page stays viewable when the subscription lapses; only invites are paused.
    expect(caps.canManageTeam).toBe(true);
    expect(caps.acceptingOrders).toBe(false);
  });

  it('blocks a new invite at the seat cap and allows one below it', async () => {
    const atCap = build({
      subscription: subDoc(),
      enforcement: true,
      activeMembers: 2,
      ownerMembers: 1,
    });
    expect((await atCap.service.getCapabilities(STORE_ID)).canInviteTeam).toBe(false);

    const below = build({
      subscription: subDoc(),
      enforcement: true,
      activeMembers: 1,
      ownerMembers: 1,
    });
    expect((await below.service.getCapabilities(STORE_ID)).canInviteTeam).toBe(true);
  });

  it('blocks product creation at the active-product cap and allows it below', async () => {
    const atCap = build({
      subscription: subDoc(),
      enforcement: true,
      activeProducts: 50,
    });
    const atCapCaps = await atCap.service.getCapabilities(STORE_ID);
    expect(atCapCaps.canCreateProduct).toBe(false);
    expect(atCapCaps.canActivateProduct).toBe(false);

    const below = build({
      subscription: subDoc(),
      enforcement: true,
      activeProducts: 49,
    });
    const belowCaps = await below.service.getCapabilities(STORE_ID);
    expect(belowCaps.canCreateProduct).toBe(true);
    expect(belowCaps.canActivateProduct).toBe(true);
  });

  it('never limits product creation while enforcement is off', async () => {
    const { service } = build({
      subscription: subDoc(),
      enforcement: false,
      activeProducts: 50,
    });
    expect((await service.getCapabilities(STORE_ID)).canCreateProduct).toBe(true);
  });

  it('never limits product creation on an unlimited plan', async () => {
    const unlimited = subDoc();
    unlimited.planSnapshot.limits.maxProducts = null;
    const { service } = build({
      subscription: unlimited,
      enforcement: true,
      activeProducts: 500,
    });
    const caps = await service.getCapabilities(STORE_ID);
    expect(caps.canCreateProduct).toBe(true);
    expect(caps.canActivateProduct).toBe(true);
  });

  it('accepts orders while below the limit and refuses at the limit once enforcement is on', async () => {
    const below = build({
      subscription: subDoc({ usage: { ordersUsed: 99 } }),
      enforcement: true,
    });
    expect((await below.service.getPublicState(STORE_ID)).acceptingOrders).toBe(true);

    const atLimit = build({
      subscription: subDoc({ usage: { ordersUsed: 100 } }),
      enforcement: true,
    });
    expect((await atLimit.service.getPublicState(STORE_ID)).acceptingOrders).toBe(false);
  });

  it('never blocks ordering while enforcement is off', async () => {
    const { service } = build({
      subscription: subDoc({ usage: { ordersUsed: 999 } }),
      enforcement: false,
    });
    expect((await service.getPublicState(STORE_ID)).acceptingOrders).toBe(true);
  });

  it('reports a cancelled subscription as cancelled and not accepting', async () => {
    const { service } = build({
      subscription: subDoc({ status: SubscriptionStatus.CANCELLED }),
      enforcement: true,
    });
    const state = await service.getPublicState(STORE_ID);
    expect(state.subscriptionState).toBe(SubscriptionStatus.CANCELLED);
    expect(state.acceptingOrders).toBe(false);
  });
});

describe('SubscriptionAccessService acceptance truth', () => {
  it('keeps orders open in every state while all enforcement is off', async () => {
    const expired = build({
      subscription: subDoc({ endDate: new Date(Date.now() - 1) }),
      enforcement: false,
      featureEnforcement: false,
    });
    expect((await expired.service.getPublicState(STORE_ID)).acceptingOrders).toBe(true);
    expect((await expired.service.getCapabilities(STORE_ID)).acceptingOrders).toBe(true);

    const missing = build({ subscription: null, enforcement: false, featureEnforcement: false });
    expect((await missing.service.getPublicState(STORE_ID)).acceptingOrders).toBe(true);
    expect(await missing.service.getOrderAcceptance(STORE_ID)).toBe(true);
  });

  it('pauses an expired subscription under the feature gate alone', async () => {
    const { service } = build({
      subscription: subDoc({ endDate: new Date(Date.now() - 1) }),
      featureEnforcement: true,
    });
    expect((await service.getPublicState(STORE_ID)).acceptingOrders).toBe(false);
    expect((await service.getCapabilities(STORE_ID)).acceptingOrders).toBe(false);
    expect(await service.getOrderAcceptance(STORE_ID)).toBe(false);
  });

  it('accepts an active subscription under the feature gate and applies quota only when broad is on', async () => {
    const below = build({
      subscription: subDoc({ usage: { ordersUsed: 99 } }),
      featureEnforcement: true,
    });
    expect((await below.service.getPublicState(STORE_ID)).acceptingOrders).toBe(true);

    // The quota is a broad-rollout rule: feature-only keeps accepting at the numeric limit.
    const featureAtLimit = build({
      subscription: subDoc({ usage: { ordersUsed: 100 } }),
      featureEnforcement: true,
    });
    expect((await featureAtLimit.service.getPublicState(STORE_ID)).acceptingOrders).toBe(true);

    const broadAtLimit = build({
      subscription: subDoc({ usage: { ordersUsed: 100 } }),
      enforcement: true,
    });
    expect((await broadAtLimit.service.getPublicState(STORE_ID)).acceptingOrders).toBe(false);
    expect((await broadAtLimit.service.getCapabilities(STORE_ID)).acceptingOrders).toBe(false);
    expect(await broadAtLimit.service.getOrderAcceptance(STORE_ID)).toBe(false);
  });

  it('fails closed for a corrupt snapshot or inconsistent entitlements under the feature gate', async () => {
    const corrupt = build({ subscription: subDoc({ planSnapshot: {} }), featureEnforcement: true });
    expect((await corrupt.service.getPublicState(STORE_ID)).acceptingOrders).toBe(false);

    const inconsistent = build({
      subscription: subDoc({
        planSnapshot: {
          ...subDoc().planSnapshot,
          entitlements: {
            monthlyOrders: 10,
            ordersAllowance: null,
            maxProducts: null,
            maxTeamMembers: null,
            features: { pos: false },
            durationMonths: 1,
          },
        },
      }),
      featureEnforcement: true,
    });
    expect((await inconsistent.service.getPublicState(STORE_ID)).acceptingOrders).toBe(false);
    expect((await inconsistent.service.getCapabilities(STORE_ID)).acceptingOrders).toBe(false);
  });

  it('keeps a legacy snapshot without an entitlements block valid', async () => {
    const { service } = build({ subscription: subDoc(), featureEnforcement: true });
    expect((await service.getPublicState(STORE_ID)).acceptingOrders).toBe(true);
    expect((await service.getCapabilities(STORE_ID)).acceptingOrders).toBe(true);
  });

  it('batched public state matches the per-store state', async () => {
    const { service } = build({ subscription: subDoc(), featureEnforcement: true });
    const batched = await service.getPublicStates([STORE_ID]);
    const single = await service.getPublicState(STORE_ID);
    expect(batched.get(STORE_ID)).toEqual(single);
  });
});

describe('SubscriptionAccessService cap lock', () => {
  function capSession() {
    return {
      withTransaction: jest.fn(async (fn: () => Promise<void>) => fn()),
      endSession: jest.fn(async () => undefined),
    } as any;
  }

  beforeEach(() => {
    mockedOpenSession.mockReset();
  });

  it('bumps the per-store version, re-reads usage in the session and runs the write', async () => {
    const session = capSession();
    mockedOpenSession.mockResolvedValue(session);
    const { service, subscriptionModel, productModel } = build({
      subscription: subDoc(),
      featureEnforcement: true,
      activeProducts: 49,
    });

    const result = await service.withStoreCapLock(STORE_ID, async (ctx) => ({
      sameSession: ctx.session === session,
      entitled: ctx.entitlement.entitled,
      activeProducts: ctx.usage.activeProducts,
    }));

    expect(subscriptionModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      { $inc: { 'usage.capVersion': 1 } },
      { new: true, session },
    );
    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(session.endSession).toHaveBeenCalledTimes(1);
    expect(productModel.countDocuments.mock.results[0].value.session).toHaveBeenCalledWith(
      session,
    );
    expect(result).toEqual({ sameSession: true, entitled: true, activeProducts: 49 });
  });

  it('fails closed when the store has no subscription row', async () => {
    const session = capSession();
    mockedOpenSession.mockResolvedValue(session);
    const { service } = build({ subscription: null, featureEnforcement: true });

    await expect(
      service.withStoreCapLock(STORE_ID, jest.fn(async () => undefined)),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.SUBSCRIPTION_INACTIVE });
  });

  it('falls back to check-then-act when transactions are unavailable', async () => {
    mockedOpenSession.mockRejectedValue(
      new AppException(AppErrorCode.INVALID_COMBINATION, { reason: 'transactions_unavailable' }),
    );
    const { service } = build({ subscription: subDoc(), featureEnforcement: true });

    const result = await service.withStoreCapLock(STORE_ID, async (ctx) => ({
      session: ctx.session,
      activeProducts: ctx.usage.activeProducts,
    }));
    expect(result.session).toBeNull();
  });

  it('does not open a transaction while feature enforcement is off', async () => {
    const { service } = build({
      subscription: subDoc(),
      enforcement: false,
      featureEnforcement: false,
    });

    const session = await service.withStoreCapLock(STORE_ID, async (ctx) => ctx.session);
    expect(session).toBeNull();
    expect(mockedOpenSession).not.toHaveBeenCalled();
  });
});

describe('SubscriptionAccessService order quota', () => {
  function quotaService(options: {
    used: number;
    limit: number | null;
    enforcement?: boolean;
    endDate?: Date | null;
  }) {
    let used = options.used;
    const doc: any = subDoc({
      usage: { ordersUsed: options.used },
      endDate: options.endDate === undefined ? null : options.endDate,
      planSnapshot: {
        planVersion: 1,
        name: 'Plan',
        price: 0,
        currency: 'DZD',
        durationDays: 30,
        limits: { maxOrders: options.limit, maxProducts: null, maxTeamMembers: null },
        features: { pos: true },
        trial: { enabled: false, days: null },
      },
    });
    const model: any = {
      findOne: jest.fn(() => q(doc)),
      findOneAndUpdate: jest.fn(() => ({ exec: async () => {
        if (options.limit === null || used < options.limit) {
          used += 1;
          doc.usage.ordersUsed = used;
          return { ...doc };
        }
        return null;
      } })),
      updateOne: jest.fn(() => ({ exec: async () => {
        if (used > 0) used -= 1;
        doc.usage.ordersUsed = used;
        return { modifiedCount: 1 };
      } })),
    };
    const configService: any = {
      get: jest.fn((key: string) =>
        key === 'subscriptions.enforcementEnabled'
          ? (options.enforcement ?? true)
          : true,
      ),
    };
    const service = new SubscriptionAccessService(
      model,
      { countDocuments: jest.fn(() => q(0)) } as any,
      { countDocuments: jest.fn(() => q(0)) } as any,
      { countDocuments: jest.fn(() => q(0)) } as any,
      configService as unknown as ConfigService,
    );
    return { service, model, getUsed: () => used };
  }

  it('allows exactly one success at limit-1 under concurrent requests', async () => {
    const { service, getUsed } = quotaService({ used: 4, limit: 5 });
    const results = await Promise.allSettled([
      service.reserveOrderSlot(STORE_ID),
      service.reserveOrderSlot(STORE_ID),
      service.reserveOrderSlot(STORE_ID),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const result of rejected) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(AppException);
      expect(((result as PromiseRejectedResult).reason as AppException).errorCode).toBe(
        AppErrorCode.SUBSCRIPTION_ORDER_LIMIT_REACHED,
      );
    }
    expect(getUsed()).toBe(5);
  });

  it('increments an unlimited plan without a limit predicate', async () => {
    const { service, model } = quotaService({ used: 0, limit: null });
    await expect(service.reserveOrderSlot(STORE_ID)).resolves.toBe(true);
    expect(model.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('refuses when the period has ended', async () => {
    const { service } = quotaService({ used: 0, limit: 5, endDate: new Date(Date.now() - 1000) });
    await expect(service.reserveOrderSlot(STORE_ID)).rejects.toMatchObject({
      errorCode: AppErrorCode.SUBSCRIPTION_INACTIVE,
    });
  });

  it('is a no-op while enforcement is off', async () => {
    const { service, model } = quotaService({ used: 0, limit: 5, enforcement: false });
    await expect(service.reserveOrderSlot(STORE_ID)).resolves.toBe(false);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('releases a slot exactly once and never goes negative', async () => {
    const { service, getUsed } = quotaService({ used: 1, limit: 5 });
    await service.releaseOrderSlot(STORE_ID);
    await service.releaseOrderSlot(STORE_ID);
    expect(getUsed()).toBe(0);
  });
});



