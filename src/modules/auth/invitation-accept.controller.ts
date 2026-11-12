import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { Public } from './decorators/public.decorator';
import { Roles } from './decorators/roles.decorator';
import { Role } from '../../common/constants/roles.enum';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';

const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: (process.env.NODE_ENV === 'production' ? 'strict' : 'lax') as 'strict' | 'lax',
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Invitation acceptance and the session self-read.
 *
 * `GET /auth/invitations/:token` and `POST .../accept` are public because the invitee has no
 * account yet. Accepting an invitation for an *existing* account requires a logged-in session
 * whose email matches the invitation — that is how email ownership is proven.
 */
@ApiTags('Auth')
@Controller('auth')
export class InvitationAcceptController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Get('invitations/:token')
  @ApiOperation({ summary: 'Read a store invitation (public, no credentials)' })
  @ApiResponse({ status: 200, description: 'Invitation metadata for the accept page' })
  @ApiResponse({ status: 410, description: 'Invitation expired or revoked' })
  getInvitation(@Param('token') token: string) {
    return this.authService.getInvitationInfo(token);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('invitations/:token/accept')
  @ApiOperation({ summary: 'Accept an invitation by creating the account' })
  async accept(
    @Param('token') token: string,
    @Body() dto: AcceptInvitationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.acceptInvitationNewAccount(dto, token);
    res.cookie('auth_token', result.token, AUTH_COOKIE_OPTIONS);
    return result;
  }

  @Roles(Role.CUSTOMER, Role.VENDOR, Role.ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('invitations/:token/accept-existing')
  @ApiOperation({ summary: 'Accept an invitation with an existing account' })
  async acceptExisting(
    @Param('token') token: string,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.acceptInvitationExisting(req.user, token);
    res.cookie('auth_token', result.token, AUTH_COOKIE_OPTIONS);
    return result;
  }

  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get('me')
  @ApiOperation({ summary: 'The current user with store role and permissions' })
  getMe(@Req() req: any) {
    return this.authService.getMe(req.user.id);
  }
}
