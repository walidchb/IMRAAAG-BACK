import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminProtected } from '../admin/decorators/admin-protected.decorator';
import { CurrentAdmin } from '../admin/decorators/current-admin.decorator';
import type { AdminPrincipal } from '../admin/decorators/current-admin.decorator';
import { AdminIdParamDto } from '../admin/dto/admin-id-param.dto';
import { AdminSubscriptionsService } from './admin-subscriptions.service';
import {
  AssignSubscriptionDto,
  CancelSubscriptionDto,
  ChangePlanDto,
  ExtendSubscriptionDto,
  ReactivateSubscriptionDto,
  SubscriptionQueryDto,
  TrialSubscriptionDto,
} from './dto/subscription.dto';

@ApiTags('Admin Subscriptions')
@AdminProtected()
@Controller('admin/subscriptions')
export class AdminSubscriptionsController {
  constructor(private readonly adminSubscriptionsService: AdminSubscriptionsService) {}

  @Get()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({ summary: 'List, filter and paginate subscriptions (incl. derived expiry)' })
  list(@Query() query: SubscriptionQueryDto) {
    return this.adminSubscriptionsService.list(query);
  }

  @Get(':id')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({ summary: 'Subscription detail with store, owner and event history' })
  get(@Param() params: AdminIdParamDto) {
    return this.adminSubscriptionsService.get(params.id);
  }

  @Post('assign')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Assign a plan and start a new period' })
  assign(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: AssignSubscriptionDto) {
    return this.adminSubscriptionsService.assign(dto.storeId, dto.planId, this.actor(admin), dto.replace);
  }

  @Post('trial')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Grant a trial using the plan trial configuration' })
  trial(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: TrialSubscriptionDto) {
    return this.adminSubscriptionsService.grantTrial(dto.storeId, dto.planId, this.actor(admin), dto.replace);
  }

  @Post(':id/change-plan')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Change plan: new period, usage reset' })
  changePlan(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param() params: AdminIdParamDto,
    @Body() dto: ChangePlanDto,
  ) {
    return this.adminSubscriptionsService.changePlan(params.id, dto.planId, this.actor(admin), dto.reason);
  }

  @Post(':id/extend')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Extend the current period; usage preserved' })
  extend(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param() params: AdminIdParamDto,
    @Body() dto: ExtendSubscriptionDto,
  ) {
    return this.adminSubscriptionsService.extend(params.id, dto.days, this.actor(admin), dto.reason);
  }

  @Post(':id/cancel')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Cancel immediately; data retained' })
  cancel(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param() params: AdminIdParamDto,
    @Body() dto: CancelSubscriptionDto,
  ) {
    return this.adminSubscriptionsService.cancel(params.id, this.actor(admin), dto.reason);
  }

  @Post(':id/reactivate')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Reactivate a cancelled/expired subscription with a new period' })
  reactivate(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param() params: AdminIdParamDto,
    @Body() dto: ReactivateSubscriptionDto,
  ) {
    return this.adminSubscriptionsService.reactivate(params.id, this.actor(admin), {
      days: dto.days,
      reason: dto.reason,
    });
  }

  private actor(admin: AdminPrincipal) {
    return { id: admin.id, email: admin.email };
  }
}
