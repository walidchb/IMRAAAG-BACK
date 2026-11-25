import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from '../dto/admin-login.dto';
import { ChangeAdminPasswordDto } from '../dto/change-admin-password.dto';
import { Public } from '../../auth/decorators/public.decorator';
import { AdminProtected } from '../decorators/admin-protected.decorator';
import { CurrentAdmin } from '../decorators/current-admin.decorator';
import type { AdminPrincipal } from '../decorators/current-admin.decorator';
import { AdminOriginGuard } from './admin-origin.guard';
import { UseGuards } from '@nestjs/common';
import {
  ADMIN_REFRESH_COOKIE,
  clearAdminAuthCookies,
  setAdminAuthCookies,
} from './admin-session.util';

@ApiTags('Admin Auth')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly adminAuthService: AdminAuthService,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @UseGuards(AdminOriginGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start an admin session (sets HttpOnly cookies)' })
  async login(
    @Body() dto: AdminLoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.adminAuthService.login(dto);
    setAdminAuthCookies(res, result.tokens, this.configService);
    return { admin: result.admin };
  }

  @Public()
  @UseGuards(AdminOriginGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate the admin session cookies' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = req.cookies?.[ADMIN_REFRESH_COOKIE];
    try {
      const result = await this.adminAuthService.refresh(raw);
      setAdminAuthCookies(res, result.tokens, this.configService);
      return { admin: result.admin };
    } catch (error) {
      clearAdminAuthCookies(res);
      throw error;
    }
  }

  @Public()
  @UseGuards(AdminOriginGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke the current admin session and clear cookies' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.adminAuthService.logout(req.cookies?.[ADMIN_REFRESH_COOKIE]);
    clearAdminAuthCookies(res);
  }

  @AdminProtected()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get('me')
  @ApiOperation({ summary: 'Current admin profile' })
  async me(@CurrentAdmin() admin: AdminPrincipal) {
    return { admin: await this.adminAuthService.me(admin.id) };
  }

  @AdminProtected()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Patch('password')
  @HttpCode(204)
  @ApiOperation({ summary: 'Change your own password (revokes every admin session)' })
  async changePassword(
    @CurrentAdmin() admin: AdminPrincipal,
    @Body() dto: ChangeAdminPasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.adminAuthService.changePassword(admin.id, dto);
    clearAdminAuthCookies(res);
  }
}
