import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { Role } from '../../../common/constants/roles.enum';
import { StoresService } from '../../stores/stores.service';
import { SubscriptionAccessService } from '../subscription-access.service';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Store-management gate. It protects every *write* route of the modules that require an active
 * subscription (products, variants, categories, orders, inventory, boxes) without touching reads:
 * the seller keeps viewing their data, while a cancelled/expired subscription can no longer be
 * bypassed by calling the API directly.
 *
 * A no-op while feature enforcement is off (`SUBSCRIPTIONS_ENFORCEMENT_ENABLED` OR
 * `SUBSCRIPTIONS_FEATURE_ENFORCEMENT_ENABLED`), and platform admins/ non-vendors are untouched.
 */
@Injectable()
export class StoreSubscriptionGuard implements CanActivate {
  private readonly logger = new Logger(StoreSubscriptionGuard.name);

  constructor(
    private readonly accessService: SubscriptionAccessService,
    private readonly storesService: StoresService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const method = String(req?.method ?? 'GET').toUpperCase();
    if (READ_METHODS.has(method)) return true;
    if (!this.accessService.isFeatureEnforcementEnabled()) return true;

    const user = req?.user as { id?: string; role?: string } | undefined;
    // Authentication/role rejection is another guard's job; only a store vendor is gated here.
    if (!user?.id || user.role !== Role.VENDOR) return true;

    const store = await this.storesService.findByMemberIdOrThrow(user.id);
    const entitlement = await this.accessService.getEntitlement(String(store._id));
    if (!entitlement.entitled) {
      this.logger.warn(
        `[subscriptions] write rejected: inactive store=${String(store._id)} route=${req?.originalUrl ?? req?.url ?? ''}`,
      );
      throw new AppException(AppErrorCode.SUBSCRIPTION_INACTIVE, {
        storeId: String(store._id),
      });
    }
    return true;
  }
}
