import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { Role } from '../../../common/constants/roles.enum';
import { StoresService } from '../../stores/stores.service';
import { SubscriptionAccessService } from '../subscription-access.service';

/**
 * Team-management feature gate. A plan with a single seat (the Owner only) does not include the
 * team page, so every team management route is refused while team/POS feature enforcement is on.
 * `GET /team/me` is intentionally left open: it describes the caller's own role, not the team.
 *
 * A no-op while feature enforcement is off, and platform admins are untouched.
 */
@Injectable()
export class TeamSubscriptionGuard implements CanActivate {
  private readonly logger = new Logger(TeamSubscriptionGuard.name);

  constructor(
    private readonly accessService: SubscriptionAccessService,
    private readonly storesService: StoresService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.accessService.isFeatureEnforcementEnabled()) return true;

    const req = context.switchToHttp().getRequest();
    const user = req?.user as { id?: string; role?: string } | undefined;
    // Authentication/role rejection is another guard's job; admins have no store membership.
    if (!user?.id || user.role === Role.ADMIN) return true;

    const store = await this.storesService.findByMemberIdOrThrow(user.id);
    const capabilities = await this.accessService.getCapabilities(String(store._id));
    if (!capabilities.canManageTeam) {
      this.logger.warn(
        `[subscriptions] team rejected: feature not included store=${String(store._id)}`,
      );
      throw new AppException(AppErrorCode.SUBSCRIPTION_FEATURE_NOT_INCLUDED, { feature: 'team' });
    }
    return true;
  }
}
