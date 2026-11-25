import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAccountsService } from './admin-accounts.service';
import { AdminProtected } from '../decorators/admin-protected.decorator';
import { CurrentAdmin } from '../decorators/current-admin.decorator';
import type { AdminPrincipal } from '../decorators/current-admin.decorator';
import { AdminQueryDto } from '../dto/admin-query.dto';
import { CreateAdminDto } from '../dto/create-admin.dto';
import { UpdateAdminStatusDto } from '../dto/update-admin-status.dto';
import { AdminIdParamDto } from '../dto/admin-id-param.dto';

@ApiTags('Admin Accounts')
@AdminProtected()
@Controller('admin/accounts')
export class AdminAccountsController {
  constructor(private readonly adminAccountsService: AdminAccountsService) {}

  @Get()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({ summary: 'List, search, filter and paginate admin accounts' })
  list(@Query() query: AdminQueryDto) {
    return this.adminAccountsService.list(query);
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiOperation({ summary: 'Create an admin account (authenticated admins only)' })
  async create(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: CreateAdminDto) {
    return { admin: await this.adminAccountsService.create(dto, admin.id) };
  }

  @Get(':id')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({ summary: 'Admin account details' })
  async get(@Param() params: AdminIdParamDto) {
    return { admin: await this.adminAccountsService.get(params.id) };
  }

  @Patch(':id/status')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Disable or re-enable an admin account' })
  async setStatus(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param() params: AdminIdParamDto,
    @Body() dto: UpdateAdminStatusDto,
  ) {
    return {
      admin: await this.adminAccountsService.setStatus(params.id, dto.status, admin.id),
    };
  }

  @Delete(':id')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Permanently delete an admin account' })
  async remove(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param() params: AdminIdParamDto,
  ): Promise<void> {
    await this.adminAccountsService.remove(params.id, admin.id);
  }
}
