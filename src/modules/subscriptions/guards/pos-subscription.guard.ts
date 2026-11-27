import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { StoresService } from '../../stores/stores.service';
import { SKIP_POS_SUBSCRIPTION } from '../../pos/decorators/skip-pos-subscription.decorator';
import { SubscriptionAccessService } from '../subscription-access.service';

/**
 * POS feature gate (plan §10.4). Sits beside `POS_ACCESS`: the Owner's `*` wildcard satisfies
 * the permission guard but cannot bypass this one, because entitlement is a subscription fact,
 * not a role permission. A no-op while feature enforcement is off.
 *
 * Two inventory-recovery routes (`GET /pos/holds`, `DELETE /pos/holds/:id`) are exempt through
 * `@SkipPosSubscription()`: a lost POS entitlement must not strand stock that was reserved at
 * park time. Completion is a sale and stays gated.
 */
@Injectable()
export class PosSubscriptionGuard implements CanActivate {
  private readonly logger = new Logger(PosSubscriptionGuard.name);

  constructor(
    private readonly accessService: SubscriptionAccessService,
    private readonly storesService: StoresService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.accessService.isFeatureEnforcementEnabled()) return true;

    const skipped = this.reflector.getAllAndOverride<boolean>(SKIP_POS_SUBSCRIPTION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipped) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user as { id?: string; role?: string } | undefined;
    // Authentication/role rejection is someone else's job; admins have no store membership.
    if (!user?.id || user.role === 'ADMIN') return true;

    const store = await this.storesService.findByMemberIdOrThrow(user.id);
    const capabilities = await this.accessService.getCapabilities(String(store._id));
    if (!capabilities.canUsePos) {
      this.logger.warn(
        `[subscriptions] POS rejected: feature not included store=${String(store._id)}`,
      );
      throw new AppException(AppErrorCode.SUBSCRIPTION_FEATURE_NOT_INCLUDED, { feature: 'pos' });
    }
    return true;
  }
}

