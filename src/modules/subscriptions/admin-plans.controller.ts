import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminProtected } from '../admin/decorators/admin-protected.decorator';
import { CurrentAdmin } from '../admin/decorators/current-admin.decorator';
import type { AdminPrincipal } from '../admin/decorators/current-admin.decorator';
import { AdminIdParamDto } from '../admin/dto/admin-id-param.dto';
import { PlansService } from './plans.service';
import {
  CreatePlanDto,
  PlanQueryDto,
  UpdatePlanAvailabilityDto,
  UpdatePlanDto,
} from './dto/plan.dto';

@ApiTags('Admin Plans')
@AdminProtected()
@Controller('admin/plans')
export class AdminPlansController {
  constructor(private readonly plansService: PlansService) {}

  @Get()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({ summary: 'List, search, filter and paginate plans' })
  list(@Query() query: PlanQueryDto) {
    return this.plansService.list(query);
  }

  @Get(':id')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({ summary: 'Plan detail with subscriber summary' })
  get(@Param() params: AdminIdParamDto) {
    return this.plansService.get(params.id);
  }

  @Post()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Create a plan (affects future assignments only)' })
  create(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: CreatePlanDto) {
    return this.plansService.create(dto, { id: admin.id, email: admin.email });
  }

  @Patch(':id')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Edit a plan; increments version, never touches subscriptions' })
  update(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param() params: AdminIdParamDto,
    @Body() dto: UpdatePlanDto,
  ) {
    return this.plansService.update(params.id, dto, { id: admin.id, email: admin.email });
  }

  @Patch(':id/availability')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Activate or deactivate a plan' })
  setAvailability(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param() params: AdminIdParamDto,
    @Body() dto: UpdatePlanAvailabilityDto,
  ) {
    return this.plansService.setAvailability(params.id, dto.isActive, {
      id: admin.id,
      email: admin.email,
    });
  }
}
