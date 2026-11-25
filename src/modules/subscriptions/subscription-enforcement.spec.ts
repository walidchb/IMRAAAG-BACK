import { Types } from 'mongoose';
import { ProductsService } from '../products/products.service';
import { InvitationsService } from '../team/invitations.service';
import { PosSubscriptionGuard } from './guards/pos-subscription.guard';
import { SubscriptionAccessService } from './subscription-access.service';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';

const STORE_ID = '507f1f77bcf86cd799439011';

function accessMock(options: {
  enforcement?: boolean;
  featureEnforcement?: boolean;
  entitled?: boolean;
  maxProducts?: number | null;
  activeProducts?: number;
  maxTeam?: number | null;
  teamSeats?: number;
  pending?: number;
  pos?: boolean;
}) {
  return {
    isEnforcementEnabled: jest.fn(() => options.enforcement ?? true),
    isFeatureEnforcementEnabled: jest.fn(
      () => options.featureEnforcement ?? options.enforcement ?? true,
    ),
    getEntitlement: jest.fn(async () => ({
      entitled: options.entitled ?? true,
      features: { pos: options.pos ?? true },
      limits: { maxOrders: null, maxProducts: options.maxProducts ?? null, maxTeamMembers: options.maxTeam ?? null },
      subscription: {},
    })),
    getUsage: jest.fn(async () => ({
      activeProducts: options.activeProducts ?? 0,
      productsLimit: options.maxProducts ?? null,
      teamSeats: options.teamSeats ?? 0,
      teamLimit: options.maxTeam ?? null,
      pendingInvitations: options.pending ?? 0,
      ordersUsed: 0,
      ordersLimit: null,
    })),
    getCapabilities: jest.fn(async () => ({
      acceptingOrders: true,
      canUsePos: options.pos ?? true,
      canCreateProduct: true,
      canActivateProduct: true,
      canInviteTeam: true,
    })),
  } as unknown as SubscriptionAccessService;
}

function productsService(access: SubscriptionAccessService) {
  return new ProductsService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    access,
  );
}

function invitationsService(access: SubscriptionAccessService, pendingExists = false) {
  return new InvitationsService(
    {
      findOne: jest.fn(() => ({
        select: jest.fn(() => ({ lean: jest.fn(() => ({ exec: jest.fn(async () => (pendingExists ? { _id: 'x' } : null)) })) })),
      })),
    } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { record: jest.fn() } as any,
    access,
  );
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ errorCode: code });
}

describe('Products subscription enforcement', () => {
  it('is a no-op while enforcement is off', async () => {
    const access = accessMock({ enforcement: false, entitled: false });
    const service = productsService(access);
    await expect(
      (service as any).assertProductWriteAllowed(STORE_ID),
    ).resolves.toBeUndefined();
  });

  it('blocks any creation when the store is not entitled', async () => {
    const access = accessMock({ entitled: false });
    const service = productsService(access);
    await expectCode(
      (service as any).assertProductWriteAllowed(STORE_ID),
      AppErrorCode.SUBSCRIPTION_INACTIVE,
    );
  });

  it('blocks product creation at the active-product cap', async () => {
    const access = accessMock({ maxProducts: 5, activeProducts: 5 });
    const service = productsService(access);
    await expectCode(
      (service as any).assertProductWriteAllowed(STORE_ID),
      AppErrorCode.SUBSCRIPTION_PRODUCT_LIMIT_REACHED,
    );
  });

  it('allows product creation below the cap', async () => {
    const access = accessMock({ maxProducts: 5, activeProducts: 4 });
    const service = productsService(access);
    await expect(
      (service as any).assertProductWriteAllowed(STORE_ID),
    ).resolves.toBeUndefined();
  });

  it('allows creation on an unlimited plan', async () => {
    const access = accessMock({ maxProducts: null, activeProducts: 100 });
    const service = productsService(access);
    await expect(
      (service as any).assertProductWriteAllowed(STORE_ID),
    ).resolves.toBeUndefined();
  });

  it('enforces the product cap through the feature gate while broad enforcement is off', async () => {
    const access = accessMock({
      enforcement: false,
      featureEnforcement: true,
      maxProducts: 5,
      activeProducts: 5,
    });
    const service = productsService(access);
    await expectCode(
      (service as any).assertProductWriteAllowed(STORE_ID),
      AppErrorCode.SUBSCRIPTION_PRODUCT_LIMIT_REACHED,
    );
  });
});

describe('POS subscription guard', () => {
  const stores = {
    findByMemberIdOrThrow: jest.fn(async () => ({ _id: new Types.ObjectId(STORE_ID) })),
  } as any;

  function ctx(role = 'VENDOR') {
    return {
      switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u1', role } }) }),
    } as any;
  }

  it('does not block while enforcement is off', async () => {
    const guard = new PosSubscriptionGuard(accessMock({ enforcement: false, pos: false }), stores);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });

  it('blocks when POS is not in the plan (Owner wildcard cannot bypass)', async () => {
    const guard = new PosSubscriptionGuard(accessMock({ pos: false }), stores);
    await expect(guard.canActivate(ctx('VENDOR'))).rejects.toBeInstanceOf(AppException);
  });

  it('enforces POS through the feature gate while broad enforcement is off', async () => {
    const guard = new PosSubscriptionGuard(
      accessMock({ enforcement: false, featureEnforcement: true, pos: false }),
      stores,
    );
    await expect(guard.canActivate(ctx('VENDOR'))).rejects.toMatchObject({
      errorCode: AppErrorCode.SUBSCRIPTION_FEATURE_NOT_INCLUDED,
    });
  });

  it('allows POS when the plan includes it', async () => {
    const guard = new PosSubscriptionGuard(accessMock({ pos: true }), stores);
    await expect(guard.canActivate(ctx('VENDOR'))).resolves.toBe(true);
  });

  it('lets a platform admin through (no store membership)', async () => {
    const guard = new PosSubscriptionGuard(accessMock({ pos: false }), stores);
    await expect(guard.canActivate(ctx('ADMIN'))).resolves.toBe(true);
  });
});

describe('Team subscription enforcement', () => {
  const store = { _id: new Types.ObjectId(STORE_ID), vendorEmail: 'o@x.com' } as any;

  it('blocks a new invite at the seat cap', async () => {
    const access = accessMock({ maxTeam: 2, teamSeats: 2, pending: 0 });
    const service = invitationsService(access);
    await expectCode(
      (service as any).assertPendingInviteAllowed(store, 'new@x.com'),
      AppErrorCode.SUBSCRIPTION_TEAM_LIMIT_REACHED,
    );
  });

  it('enforces the team cap through the feature gate while broad enforcement is off', async () => {
    const access = accessMock({
      enforcement: false,
      featureEnforcement: true,
      maxTeam: 1,
      teamSeats: 1,
      pending: 0,
    });
    const service = invitationsService(access);
    await expectCode(
      (service as any).assertPendingInviteAllowed(store, 'new@x.com'),
      AppErrorCode.SUBSCRIPTION_TEAM_LIMIT_REACHED,
    );
  });

  it('allows rotating an existing pending invite even at the cap', async () => {
    const access = accessMock({ maxTeam: 2, teamSeats: 2, pending: 0 });
    const service = invitationsService(access, true);
    await expect(
      (service as any).assertPendingInviteAllowed(store, 'pending@x.com'),
    ).resolves.toBeUndefined();
  });

  it('counts pending invitations as reserved seats', async () => {
    const access = accessMock({ maxTeam: 3, teamSeats: 2, pending: 1 });
    const service = invitationsService(access);
    await expectCode(
      (service as any).assertPendingInviteAllowed(store, 'new@x.com'),
      AppErrorCode.SUBSCRIPTION_TEAM_LIMIT_REACHED,
    );
  });

  it('blocks acceptance at the seat cap and when not entitled', async () => {
    const atCap = invitationsService(accessMock({ maxTeam: 2, teamSeats: 2 }));
    await expectCode(
      (atCap as any).assertTeamSeatAcceptable(STORE_ID),
      AppErrorCode.SUBSCRIPTION_TEAM_LIMIT_REACHED,
    );

    const expired = invitationsService(accessMock({ entitled: false }));
    await expectCode(
      (expired as any).assertTeamSeatAcceptable(STORE_ID),
      AppErrorCode.SUBSCRIPTION_INACTIVE,
    );
  });
});
