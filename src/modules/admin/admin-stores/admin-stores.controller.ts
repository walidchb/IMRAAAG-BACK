import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminProtected } from '../decorators/admin-protected.decorator';
import { CurrentAdmin } from '../decorators/current-admin.decorator';
import type { AdminPrincipal } from '../decorators/current-admin.decorator';
import { AdminIdParamDto } from '../dto/admin-id-param.dto';
import { AdminStoresService } from './admin-stores.service';
import { AdminStoreQueryDto } from './dto/admin-store-query.dto';
import { UpdateAdminStoreStatusDto } from './dto/update-admin-store-status.dto';

@ApiTags('Admin Stores')
@AdminProtected()
@Controller('admin/stores')
export class AdminStoresController {
  constructor(private readonly adminStoresService: AdminStoresService) {}

  @Get()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({ summary: 'List, search, filter and paginate stores' })
  list(@Query() query: AdminStoreQueryDto) {
    return this.adminStoresService.list(query);
  }

  // Declared before `:id` so a literal path never gets swallowed by the id param.
  @Get('wilayas')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({ summary: 'Distinct stored wilaya labels' })
  async listWilayas() {
    return { wilayas: await this.adminStoresService.listWilayas() };
  }

  @Get(':id')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({ summary: 'Store details plus its owner' })
  async get(@Param() params: AdminIdParamDto) {
    return this.adminStoresService.get(params.id);
  }

  @Patch(':id/status')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Suspend or reactivate a store' })
  async setStatus(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param() params: AdminIdParamDto,
    @Body() dto: UpdateAdminStoreStatusDto,
  ) {
    return this.adminStoresService.updateStatus(
      params.id,
      dto.adminStatus,
      { id: admin.id, email: admin.email },
      dto.reason,
    );
  }
}
