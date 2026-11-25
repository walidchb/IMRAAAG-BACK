import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { StoresService } from '../../stores/stores.service';
import { SubscriptionAccessService } from '../subscription-access.service';

/**
 * POS feature gate (plan §10.4). Sits beside `POS_ACCESS`: the Owner's `*` wildcard satisfies
 * the permission guard but cannot bypass this one, because entitlement is a subscription fact,
 * not a role permission. A no-op while `SUBSCRIPTIONS_ENFORCEMENT_ENABLED` is false.
 */
@Injectable()
export class PosSubscriptionGuard implements CanActivate {
  private readonly logger = new Logger(PosSubscriptionGuard.name);

  constructor(
    private readonly accessService: SubscriptionAccessService,
    private readonly storesService: StoresService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.accessService.isFeatureEnforcementEnabled()) return true;

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

