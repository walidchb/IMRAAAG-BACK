import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/constants/audit-action.enum';
import { ResourceType } from '../../common/constants/resource-type.enum';
import {
  ASSIGNABLE_STORE_ROLES,
  StoreMemberStatus,
  StoreRole,
} from '../../common/constants/store-roles.enum';
import { StorePermission, hasStorePermission } from '../../common/constants/store-permissions.const';
import { User, UserDocument } from '../users/schemas/user.schema';
import { StoreMember, StoreMemberDocument } from './schemas/store-member.schema';
import { UpdateMemberDto } from './dto/update-member.dto';
import type { StoreAccess } from './store-access.service';

export interface TeamMemberView {
  id: string;
  userId: string;
  fullName: string;
  email: string | null;
  phoneNumber: string | null;
  role: StoreRole;
  status: StoreMemberStatus;
  isOwner: boolean;
  joinedAt: Date | null;
  deactivatedAt: Date | null;
}

export interface TeamActor {
  id: string;
  email?: string;
  fullName?: string;
}

/**
 * Owner-side member management (implementation plan § 5.6).
 *
 * Protections that are enforced here, not merely hidden in the UI:
 *  - the Owner (`Store.vendorId`) can never be modified, deactivated or removed;
 *  - an actor can never modify themselves;
 *  - `OWNER` is never assignable;
 *  - deactivation/removal bumps the target user's `tokenVersion` and clears their refresh
 *    token, so every already-issued access token dies immediately.
 */
@Injectable()
export class TeamService {
  constructor(
    @InjectModel(StoreMember.name)
    private readonly memberModel: Model<StoreMemberDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly auditService: AuditService,
  ) {}

  async listMembers(access: StoreAccess): Promise<TeamMemberView[]> {
    const store = this.requireStore(access);
    const rows = await this.memberModel
      .find({ storeId: store._id })
      .sort({ createdAt: 1 })
      .lean()
      .exec();

    const members = rows.map((row) => ({
      _id: String((row as any)._id),
      userId: String(row.userId),
      role: row.role as StoreRole,
      status: row.status as StoreMemberStatus,
      joinedAt: (row as any).joinedAt ?? null,
      deactivatedAt: (row as any).deactivatedAt ?? null,
    }));

    // Legacy store whose Owner row was never seeded: project the Owner from `vendorId`.
    if (store.vendorId && !members.some((m) => m.userId === String(store.vendorId))) {
      members.unshift({
        _id: `owner:${String(store.vendorId)}`,
        userId: String(store.vendorId),
        role: StoreRole.OWNER,
        status: StoreMemberStatus.ACTIVE,
        joinedAt: (store as any).createdAt ?? null,
        deactivatedAt: null,
      });
    }

    const users = await this.userModel
      .find({ _id: { $in: members.map((m) => m.userId).filter((id) => Types.ObjectId.isValid(id)) } })
      .select('fullName email phoneNumber')
      .lean()
      .exec();
    const byId = new Map(users.map((u: any) => [String(u._id), u]));

    return members.map((m) => {
      const user: any = byId.get(m.userId);
      return {
        id: m._id,
        userId: m.userId,
        fullName: user?.fullName ?? '',
        email: user?.email ?? null,
        phoneNumber: user?.phoneNumber ?? null,
        role: m.role,
        status: m.status,
        isOwner: m.role === StoreRole.OWNER,
        joinedAt: m.joinedAt,
        deactivatedAt: m.deactivatedAt,
      };
    });
  }

  async updateMember(
    access: StoreAccess,
    actor: TeamActor,
    memberId: string,
    dto: UpdateMemberDto,
  ): Promise<TeamMemberView> {
    const store = this.requireStore(access);
    const member = await this.findScopedMember(store._id, memberId);

    this.assertNotOwner(member, store.vendorId);
    this.assertNotSelf(member, actor.id);

    const targetUserId = String(member.userId);

    if (dto.role !== undefined) {
      this.assertAllowed(access, StorePermission.TEAM_UPDATE_ROLE);
      if (!ASSIGNABLE_STORE_ROLES.includes(dto.role)) {
        throw new AppException(AppErrorCode.TEAM_ROLE_INVALID, { role: dto.role });
      }
      member.role = dto.role;
      await member.save();

      this.auditService.record({
        action: AuditAction.TEAM_MEMBER_ROLE_CHANGED,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        storeId: String(store._id),
        resourceType: ResourceType.USER,
        resourceId: targetUserId,
        details: { role: dto.role, memberId: String(member._id) },
      });
    }

    if (dto.status !== undefined) {
      if (dto.status === StoreMemberStatus.DEACTIVATED) {
        this.assertAllowed(access, StorePermission.TEAM_DEACTIVATE);
        await this.deactivate(member, actor.id);
        await this.revokeUserSessions(targetUserId);

        this.auditService.record({
          action: AuditAction.TEAM_MEMBER_DEACTIVATED,
          actorId: actor.id,
          actorEmail: actor.email ?? null,
          storeId: String(store._id),
          resourceType: ResourceType.USER,
          resourceId: targetUserId,
          details: { memberId: String(member._id) },
        });
      } else {
        this.assertAllowed(access, StorePermission.TEAM_REACTIVATE);
        // Set active and clear the deactivation audit fields in one write.
        await this.memberModel.updateOne(
          { _id: member._id, storeId: store._id },
          {
            $set: { status: StoreMemberStatus.ACTIVE },
            $unset: { deactivatedAt: 1, deactivatedBy: 1 },
          },
        ).exec();

        this.auditService.record({
          action: AuditAction.TEAM_MEMBER_REACTIVATED,
          actorId: actor.id,
          actorEmail: actor.email ?? null,
          storeId: String(store._id),
          resourceType: ResourceType.USER,
          resourceId: targetUserId,
          details: { memberId: String(member._id) },
        });
      }
    }

    const fresh = await this.findScopedMember(store._id, String(member._id));
    const user: any = await this.userModel
      .findById(fresh.userId)
      .select('fullName email phoneNumber')
      .lean()
      .exec();

    return {
      id: String((fresh as any)._id),
      userId: String(fresh.userId),
      fullName: user?.fullName ?? '',
      email: user?.email ?? null,
      phoneNumber: user?.phoneNumber ?? null,
      role: fresh.role,
      status: fresh.status,
      isOwner: false,
      joinedAt: (fresh as any).joinedAt ?? null,
      deactivatedAt: (fresh as any).deactivatedAt ?? null,
    };
  }

  async removeMember(
    access: StoreAccess,
    actor: TeamActor,
    memberId: string,
  ): Promise<{ removed: true }> {
    const store = this.requireStore(access);
    this.assertAllowed(access, StorePermission.TEAM_REMOVE);

    const member = await this.findScopedMember(store._id, memberId);
    this.assertNotOwner(member, store.vendorId);
    this.assertNotSelf(member, actor.id);

    await this.memberModel.deleteOne({ _id: member._id, storeId: store._id }).exec();
    await this.revokeUserSessions(String(member.userId));

    this.auditService.record({
      action: AuditAction.TEAM_MEMBER_REMOVED,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      storeId: String(store._id),
      resourceType: ResourceType.USER,
      resourceId: String(member.userId),
      details: { memberId: String(member._id) },
    });

    return { removed: true };
  }

  private async findScopedMember(
    storeId: Types.ObjectId,
    memberId: string,
  ): Promise<StoreMemberDocument> {
    if (!Types.ObjectId.isValid(memberId)) {
      throw new AppException(AppErrorCode.TEAM_MEMBER_NOT_FOUND, { id: memberId });
    }
    const member = await this.memberModel
      .findOne({ _id: new Types.ObjectId(memberId), storeId })
      .exec();
    if (!member) {
      throw new AppException(AppErrorCode.TEAM_MEMBER_NOT_FOUND, { id: memberId });
    }
    return member;
  }

  private assertNotOwner(
    member: StoreMemberDocument,
    vendorId?: Types.ObjectId | null,
  ): void {
    const isOwnerPointer =
      !!vendorId && String(member.userId) === String(vendorId);
    if (member.role === StoreRole.OWNER || isOwnerPointer) {
      throw new AppException(AppErrorCode.TEAM_OWNER_PROTECTED);
    }
  }

  private assertNotSelf(member: StoreMemberDocument, actorId: string): void {
    if (String(member.userId) === String(actorId)) {
      throw new AppException(AppErrorCode.TEAM_CANNOT_MODIFY_SELF);
    }
  }

  private assertAllowed(access: StoreAccess, permission: string): void {
    if (!hasStorePermission(access.permissions, permission)) {
      throw new AppException(AppErrorCode.AUTH_INSUFFICIENT_PERMISSIONS, { permission });
    }
  }

  private async deactivate(
    member: StoreMemberDocument,
    actorId: string,
  ): Promise<void> {
    await this.memberModel.updateOne(
      { _id: member._id },
      {
        $set: {
          status: StoreMemberStatus.DEACTIVATED,
          deactivatedAt: new Date(),
          ...(Types.ObjectId.isValid(actorId)
            ? { deactivatedBy: new Types.ObjectId(actorId) }
            : {}),
        },
      },
    ).exec();
  }

  /**
   * Blocks every existing session immediately. `tokenVersion` is global per user: with the
   * MVP's one-store-per-employee rule this revokes access everywhere, which is intended.
   */
  private async revokeUserSessions(userId: string): Promise<void> {
    if (!Types.ObjectId.isValid(userId)) return;
    await this.userModel
      .updateOne(
        { _id: new Types.ObjectId(userId) },
        {
          $inc: { tokenVersion: 1 },
          $set: { refreshToken: null, refreshTokenExpiresAt: null },
        },
      )
      .exec();
  }

  private requireStore(access: StoreAccess) {
    if (!access.store) {
      throw new AppException(AppErrorCode.STORE_NOT_FOUND);
    }
    return access.store as any;
  }
}
