import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { Role } from '../../common/constants/roles.enum';
import {
  StoreMemberStatus,
  StoreRole,
} from '../../common/constants/store-roles.enum';
import {
  permissionsForRole,
  WILDCARD_PERMISSION,
  hasStorePermission,
} from '../../common/constants/store-permissions.const';
import { StoreDocument } from '../stores/schemas/store.schema';
import { StoresService } from '../stores/stores.service';
import { StoreMember, StoreMemberDocument } from './schemas/store-member.schema';

export interface StoreAccess {
  store: StoreDocument | null;
  storeId: Types.ObjectId | null;
  storeRole: StoreRole | null;
  isOwner: boolean;
  /** `['*']` for the Owner and for platform admins. */
  permissions: string[];
  /** `null` for a legacy owner without a membership row, or a platform admin. */
  memberId: string | null;
}

export interface AccessUser {
  id: string;
  role?: string;
}

/**
 * Resolves who a user is *inside a store* — Owner or active employee — and their effective
 * permissions. This is the single source used by `PermissionsGuard` and by the team API.
 *
 * Resolution order (implementation plan § 6.2):
 *  1. platform `ADMIN` → `['*']`, no store unless one is named explicitly elsewhere;
 *  2. an active `StoreMember` row → that store and role;
 *  3. fallback: `Store.vendorId` → implicit Owner (legacy stores without a seeded row);
 *  4. otherwise no access (distinguishing a deactivated membership for the error code).
 */
@Injectable()
export class StoreAccessService {
  constructor(
    @InjectModel(StoreMember.name)
    private readonly memberModel: Model<StoreMemberDocument>,
    private readonly storesService: StoresService,
  ) {}

  async resolveForUser(userId: string, platformRole?: string): Promise<StoreAccess | null> {
    if (!userId) return null;

    if (platformRole === Role.ADMIN) {
      return {
        store: null,
        storeId: null,
        storeRole: null,
        isOwner: false,
        permissions: [WILDCARD_PERMISSION],
        memberId: null,
      };
    }

    if (!Types.ObjectId.isValid(userId)) return null;
    const userObjectId = new Types.ObjectId(userId);

    const member = await this.memberModel
      .findOne({ userId: userObjectId, status: StoreMemberStatus.ACTIVE })
      .lean()
      .exec();

    if (member) {
      const store = await this.loadStore(String(member.storeId));
      if (!store) return null;
      return {
        store,
        storeId: store._id as Types.ObjectId,
        storeRole: member.role as StoreRole,
        isOwner: member.role === StoreRole.OWNER,
        permissions: permissionsForRole(member.role as StoreRole, member.permissionOverrides),
        memberId: String(member._id),
      };
    }

    // Legacy owner without a seeded membership row: `Store.vendorId` remains canonical.
    const ownerStore = await this.storesService.findByVendorId(userId);
    if (ownerStore) {
      return {
        store: ownerStore,
        storeId: ownerStore._id as Types.ObjectId,
        storeRole: StoreRole.OWNER,
        isOwner: true,
        permissions: [WILDCARD_PERMISSION],
        memberId: null,
      };
    }

    return null;
  }

  /**
   * Same as `resolveForUser`, but turns "no access" into the right error. A user with only a
   * deactivated membership is told access was revoked rather than that no store exists.
   */
  async resolveForUserOrThrow(user: AccessUser): Promise<StoreAccess> {
    const access = await this.resolveForUser(user.id, user.role);
    if (access) return access;

    if (user.role !== Role.ADMIN && Types.ObjectId.isValid(user.id)) {
      const revoked = await this.memberModel
        .findOne({
          userId: new Types.ObjectId(user.id),
          status: StoreMemberStatus.DEACTIVATED,
        })
        .select('_id')
        .lean()
        .exec();
      if (revoked) {
        throw new AppException(AppErrorCode.AUTH_STORE_ACCESS_REVOKED);
      }
    }

    throw new AppException(AppErrorCode.STORE_NOT_FOUND, { vendorId: user.id });
  }

  hasPermission(access: StoreAccess | null, permission: string): boolean {
    return hasStorePermission(access?.permissions, permission);
  }

  /** True when the user has a membership that was deactivated (access revoked, not absent). */
  async hasDeactivatedMembership(userId: string): Promise<boolean> {
    if (!userId || !Types.ObjectId.isValid(userId)) return false;
    const row = await this.memberModel
      .findOne({
        userId: new Types.ObjectId(userId),
        status: StoreMemberStatus.DEACTIVATED,
      })
      .select('_id')
      .lean()
      .exec();
    return !!row;
  }

  async assertPermission(user: AccessUser, permission: string): Promise<void> {
    const access = await this.resolveForUserOrThrow(user);
    if (!this.hasPermission(access, permission)) {
      throw new AppException(AppErrorCode.AUTH_INSUFFICIENT_PERMISSIONS, { permission });
    }
  }

  private async loadStore(storeId: string): Promise<StoreDocument | null> {
    if (!Types.ObjectId.isValid(storeId)) return null;
    try {
      const store = await this.storesService.findOne(storeId, { skipStatusCheck: true });
      return (store as unknown as StoreDocument) ?? null;
    } catch {
      return null;
    }
  }
}
