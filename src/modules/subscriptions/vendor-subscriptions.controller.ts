import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Role } from '../../common/constants/roles.enum';
import { StorePermission } from '../../common/constants/store-permissions.const';
import { RequirePermissions } from '../team/decorators/require-permissions.decorator';
import { StoresService } from '../stores/stores.service';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionAccessService } from './subscription-access.service';

/**
 * Seller-facing subscription read. The store is resolved from the session (owner or active
 * employee) — a client-supplied store id is never accepted, so one store can never read
 * another's subscription. Returns display data only; enforcement is backend-side.
 */
@ApiTags('subscriptions')
@Controller('subscriptions')
@UseGuards(RolesGuard)
@Roles(Role.VENDOR)
@RequirePermissions(StorePermission.STORE_VIEW)
@Throttle({ default: { limit: 120, ttl: 60000 } })
export class VendorSubscriptionsController {
  constructor(
    private readonly subscriptionsService: SubscriptionsService,
    private readonly subscriptionAccessService: SubscriptionAccessService,
    private readonly storesService: StoresService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: "The signed-in store's plan, status, dates and usage" })
  async me(@Req() req: any) {
    const store = await this.storesService.findByMemberIdOrThrow(req.user?.id);
    const enabled = this.subscriptionsService.isEnabled();
    const view = await this.subscriptionAccessService.getVendorSubscriptionView(String(store._id));
    return { storeId: String(store._id), enabled, ...view };
  }
}

