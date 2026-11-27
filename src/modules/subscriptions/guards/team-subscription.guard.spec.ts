import { ExecutionContext } from '@nestjs/common';
import { TeamSubscriptionGuard } from './team-subscription.guard';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';

function context(user: any): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function setup(options: {
  featureEnforcement?: boolean;
  canManageTeam?: boolean;
  storeFound?: boolean;
}) {
  const accessService: any = {
    isFeatureEnforcementEnabled: jest.fn(() => options.featureEnforcement ?? true),
    getCapabilities: jest.fn(async () => ({ canManageTeam: options.canManageTeam ?? true })),
  };
  const storesService: any = {
    findByMemberIdOrThrow: jest.fn(async () => {
      if (options.storeFound === false) throw new AppException(AppErrorCode.STORE_NOT_FOUND);
      return { _id: 'store-1' };
    }),
  };
  const guard = new TeamSubscriptionGuard(accessService, storesService);
  return { guard, accessService, storesService };
}

describe('TeamSubscriptionGuard', () => {
  it('is a no-op while feature enforcement is off', async () => {
    const { guard, accessService, storesService } = setup({ featureEnforcement: false });
    await expect(guard.canActivate(context({ id: 'u1', role: 'VENDOR' }))).resolves.toBe(true);
    expect(accessService.getCapabilities).not.toHaveBeenCalled();
    expect(storesService.findByMemberIdOrThrow).not.toHaveBeenCalled();
  });

  it('does not gate an admin or an unauthenticated request', async () => {
    const { guard } = setup({ canManageTeam: false });
    await expect(guard.canActivate(context({ id: 'admin', role: 'ADMIN' }))).resolves.toBe(true);
    await expect(guard.canActivate(context(undefined))).resolves.toBe(true);
  });

  it('refuses team management when the plan has only the Owner seat', async () => {
    const { guard, storesService } = setup({ canManageTeam: false });

    await expect(
      guard.canActivate(context({ id: 'u1', role: 'VENDOR' })),
    ).rejects.toMatchObject({
      errorCode: AppErrorCode.SUBSCRIPTION_FEATURE_NOT_INCLUDED,
      errorParams: { feature: 'team' },
    });
    expect(storesService.findByMemberIdOrThrow).toHaveBeenCalledWith('u1');
  });

  it('allows team management when the plan includes a team', async () => {
    const { guard } = setup({ canManageTeam: true });
    await expect(guard.canActivate(context({ id: 'u1', role: 'VENDOR' }))).resolves.toBe(true);
  });
});
