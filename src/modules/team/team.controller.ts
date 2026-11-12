import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../../common/constants/roles.enum';
import { StorePermission } from '../../common/constants/store-permissions.const';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { RequirePermissions } from './decorators/require-permissions.decorator';
import { StoreAccessService } from './store-access.service';
import { TeamService } from './team.service';
import { InvitationsService } from './invitations.service';
import { InviteEmployeeDto } from './dto/invite-employee.dto';
import { UpdateMemberDto } from './dto/update-member.dto';

/**
 * Team Management API.
 *
 * The store is always resolved from the session. `storeId`, `userId`, `role` and `permissions`
 * are never read from the request body: the DTOs do not declare them and the global
 * `ValidationPipe` rejects unknown fields.
 *
 * Route-level `@RequirePermissions` covers the coarse capability. `PATCH /team/members/:id`
 * is one route for role/status changes, so the service enforces the exact permission the body
 * requires (`team.update_role`, `team.deactivate`, `team.reactivate`).
 */
@ApiTags('Team')
@Controller('team')
@Roles(Role.VENDOR)
export class TeamController {
  constructor(
    private readonly teamService: TeamService,
    private readonly invitationsService: InvitationsService,
    private readonly storeAccessService: StoreAccessService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: "The caller's store role and effective permissions" })
  async me(@Req() req: any) {
    const access = await this.accessFor(req);
    return {
      storeId: access.storeId ? String(access.storeId) : null,
      storeRole: access.storeRole,
      isOwner: access.isOwner,
      permissions: access.permissions,
    };
  }

  @Get('members')
  @RequirePermissions(StorePermission.TEAM_VIEW)
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({ summary: "List the store's members" })
  async members(@Req() req: any) {
    return this.teamService.listMembers(await this.accessFor(req));
  }

  @Get('invitations')
  @RequirePermissions(StorePermission.TEAM_VIEW)
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({ summary: "List the store's invitations" })
  async invitations(@Req() req: any) {
    const access = await this.accessFor(req);
    return this.invitationsService.list(this.storeOf(access));
  }

  @Post('invitations')
  @RequirePermissions(StorePermission.TEAM_INVITE)
  @Throttle({ default: { limit: 20, ttl: 3600000 } })
  @ApiOperation({ summary: 'Invite an employee' })
  @ApiResponse({ status: 201, description: 'Invitation created (or rotated) and emailed' })
  async invite(@Body() dto: InviteEmployeeDto, @Req() req: any) {
    const access = await this.accessFor(req);
    return this.invitationsService.create(this.storeOf(access), req.user, dto);
  }

  @Post('invitations/:id/resend')
  @RequirePermissions(StorePermission.TEAM_RESEND_INVITATION)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: 'Resend a pending invitation (rotates its token)' })
  async resend(@Param('id') id: string, @Req() req: any) {
    const access = await this.accessFor(req);
    return this.invitationsService.resend(this.storeOf(access), req.user, id);
  }

  @Delete('invitations/:id')
  @RequirePermissions(StorePermission.TEAM_REVOKE_INVITATION)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: 'Revoke a pending invitation' })
  async revoke(@Param('id') id: string, @Req() req: any) {
    const access = await this.accessFor(req);
    return this.invitationsService.revoke(this.storeOf(access), req.user, id);
  }

  @Patch('members/:id')
  @RequirePermissions(StorePermission.TEAM_VIEW)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: "Change an employee's role or status" })
  async updateMember(
    @Param('id') id: string,
    @Body() dto: UpdateMemberDto,
    @Req() req: any,
  ) {
    return this.teamService.updateMember(await this.accessFor(req), req.user, id, dto);
  }

  @Delete('members/:id')
  @RequirePermissions(StorePermission.TEAM_REMOVE)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: 'Remove an employee' })
  async removeMember(@Param('id') id: string, @Req() req: any) {
    return this.teamService.removeMember(await this.accessFor(req), req.user, id);
  }

  /** Reuses the access memoised by `PermissionsGuard`, or resolves it for `GET /team/me`. */
  private async accessFor(req: any) {
    if (req.storeAccess) return req.storeAccess;
    const access = await this.storeAccessService.resolveForUserOrThrow(req.user);
    req.storeAccess = access;
    return access;
  }

  private storeOf(access: any) {
    if (!access?.store) {
      throw new AppException(AppErrorCode.STORE_NOT_FOUND);
    }
    return access.store;
  }
}
