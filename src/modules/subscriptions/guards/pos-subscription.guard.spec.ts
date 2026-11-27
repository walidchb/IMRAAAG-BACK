import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PosSubscriptionGuard } from './pos-subscription.guard';
import { PosController } from '../../pos/pos.controller';
import { SKIP_POS_SUBSCRIPTION } from '../../pos/decorators/skip-pos-subscription.decorator';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';

function context(
  user: any,
  handler: (...args: any[]) => any,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => PosController,
  } as unknown as ExecutionContext;
}

function setup(options: { featureEnforcement?: boolean; canUsePos?: boolean }) {
  const accessService: any = {
    isFeatureEnforcementEnabled: jest.fn(() => options.featureEnforcement ?? true),
    getCapabilities: jest.fn(async () => ({ canUsePos: options.canUsePos ?? false })),
  };
  const storesService: any = {
    findByMemberIdOrThrow: jest.fn(async () => ({ _id: 'store-1' })),
  };
  const guard = new PosSubscriptionGuard(accessService, storesService, new Reflector());
  return { guard, accessService, storesService };
}

const vendor = { id: 'u1', role: 'VENDOR' };

describe('PosSubscriptionGuard', () => {
  it('annotates only the hold list and hold release routes as recovery routes', () => {
    expect(
      Reflect.getMetadata(SKIP_POS_SUBSCRIPTION, PosController.prototype.listHolds),
    ).toBe(true);
    expect(
      Reflect.getMetadata(SKIP_POS_SUBSCRIPTION, PosController.prototype.deleteHold),
    ).toBe(true);
    expect(
      Reflect.getMetadata(SKIP_POS_SUBSCRIPTION, PosController.prototype.createSale),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(SKIP_POS_SUBSCRIPTION, PosController.prototype.completeHold),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(SKIP_POS_SUBSCRIPTION, PosController.prototype.createHold),
    ).toBeUndefined();
  });

  it('is a no-op while feature enforcement is off', async () => {
    const { guard, accessService, storesService } = setup({ featureEnforcement: false });
    await expect(
      guard.canActivate(context(vendor, PosController.prototype.createSale)),
    ).resolves.toBe(true);
    expect(accessService.getCapabilities).not.toHaveBeenCalled();
    expect(storesService.findByMemberIdOrThrow).not.toHaveBeenCalled();
  });

  it('lets an admin through without a store membership', async () => {
    const { guard, storesService } = setup({ canUsePos: false });
    await expect(
      guard.canActivate(context({ id: 'admin', role: 'ADMIN' }, PosController.prototype.createSale)),
    ).resolves.toBe(true);
    expect(storesService.findByMemberIdOrThrow).not.toHaveBeenCalled();
  });

  it('allows hold listing and release without POS entitlement', async () => {
    const { guard } = setup({ canUsePos: false });
    await expect(
      guard.canActivate(context(vendor, PosController.prototype.listHolds)),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(context(vendor, PosController.prototype.deleteHold)),
    ).resolves.toBe(true);
  });

  it('still refuses sales, hold creation and completion when POS is lost', async () => {
    const { guard } = setup({ canUsePos: false });
    for (const handler of [
      PosController.prototype.createSale,
      PosController.prototype.createHold,
      PosController.prototype.updateHold,
      PosController.prototype.completeHold,
    ]) {
      await expect(guard.canActivate(context(vendor, handler))).rejects.toMatchObject({
        errorCode: AppErrorCode.SUBSCRIPTION_FEATURE_NOT_INCLUDED,
        errorParams: { feature: 'pos' },
      } satisfies Partial<AppException>);
    }
  });

  it('allows the gated routes when the plan includes POS', async () => {
    const { guard } = setup({ canUsePos: true });
    await expect(
      guard.canActivate(context(vendor, PosController.prototype.createSale)),
    ).resolves.toBe(true);
  });
});
