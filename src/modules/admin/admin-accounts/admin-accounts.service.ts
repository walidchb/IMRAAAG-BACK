import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { Admin, AdminDocument } from '../schemas/admin.schema';
import { AdminStatus } from '../../../common/constants/admin-status.enum';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { AdminQueryDto } from '../dto/admin-query.dto';
import { CreateAdminDto } from '../dto/create-admin.dto';
import { AdminResponseDto, toAdminResponse } from '../mappers/admin-response.mapper';

export interface AdminListResult {
  items: AdminResponseDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class AdminAccountsService {
  private readonly bcryptRounds: number;

  constructor(
    @InjectModel(Admin.name) private readonly adminModel: Model<AdminDocument>,
    private readonly configService: ConfigService,
  ) {
    const rounds = this.configService.get<number>('adminAuth.bcryptRounds') ?? 12;
    this.bcryptRounds = Number.isFinite(rounds) && rounds > 0 ? rounds : 12;
  }

  async create(dto: CreateAdminDto, actorAdminId: string): Promise<AdminResponseDto> {
    const email = dto.email.trim().toLowerCase();

    // Uniqueness is scoped to `admins` only. The same address may identify a seller in
    // `users`; the two are independent identities (separate password hashes and sessions).
    if (await this.adminModel.exists({ email })) {
      throw new AppException(AppErrorCode.ADMIN_EMAIL_ALREADY_EXISTS);
    }

    const passwordHash = await bcrypt.hash(dto.password, this.bcryptRounds);
    try {
      const created = await this.adminModel.create({
        firstName: dto.firstName.trim(),
        lastName: dto.lastName.trim(),
        email,
        passwordHash,
        status: dto.status ?? AdminStatus.ACTIVE,
        createdBy: Types.ObjectId.isValid(actorAdminId) ? new Types.ObjectId(actorAdminId) : null,
      });
      return toAdminResponse(created);
    } catch (error: any) {
      // Race-safe backstop for the unique index on `admins.email`.
      if (error?.code === 11000) {
        throw new AppException(AppErrorCode.ADMIN_EMAIL_ALREADY_EXISTS);
      }
      throw error;
    }
  }

  async list(query: AdminQueryDto): Promise<AdminListResult> {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const order: 1 | -1 = query.order === 'asc' ? 1 : -1;

    const filter: Record<string, any> = {};
    if (query.status) filter.status = query.status;
    const term = query.search?.trim();
    if (term) {
      const regex = new RegExp(escapeRegex(term), 'i');
      filter.$or = [{ firstName: regex }, { lastName: regex }, { email: regex }];
    }

    const sort: Record<string, 1 | -1> =
      query.sort === 'name'
        ? { lastName: order, firstName: order }
        : query.sort === 'lastLoginAt'
          ? { lastLoginAt: order, _id: order }
          : { [query.sort ?? 'createdAt']: order };

    const [docs, total] = await Promise.all([
      this.adminModel
        .find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.adminModel.countDocuments(filter),
    ]);

    return {
      items: docs.map((doc) => toAdminResponse(doc)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async get(id: string): Promise<AdminResponseDto> {
    const admin = await this.adminModel.findById(id).exec();
    if (!admin) {
      throw new AppException(AppErrorCode.ADMIN_NOT_FOUND);
    }
    return toAdminResponse(admin);
  }

  /**
   * Permanently delete an admin account.
   *
   * The creator can never delete themselves, and deleting the final active admin is refused
   * so the panel can never be locked out. Deleting a `disabled` account needs no active-count
   * check. The "last active" check uses `countDocuments` + a write; acceptable for a small
   * admin team (strict linearizability would need a transaction).
   */
  async remove(targetId: string, actorAdminId: string): Promise<void> {
    const target = await this.adminModel.findById(targetId).exec();
    if (!target) {
      throw new AppException(AppErrorCode.ADMIN_NOT_FOUND);
    }
    if (String(target._id) === String(actorAdminId)) {
      throw new AppException(AppErrorCode.ADMIN_CANNOT_DELETE_SELF);
    }

    if (target.status === AdminStatus.ACTIVE) {
      const otherActive = await this.adminModel.countDocuments({
        _id: { $ne: target._id },
        status: AdminStatus.ACTIVE,
      });
      if (otherActive === 0) {
        throw new AppException(AppErrorCode.ADMIN_LAST_ACTIVE);
      }
    }

    await this.adminModel.findByIdAndDelete(target._id).exec();
  }

  /**
   * Soft disable / re-enable.
   *
   * "Last active" is enforced with a `countDocuments` + conditional write. That is acceptable
   * for a small admin team; strict linearizability would need a transaction (the deployment
   * already has a replica set, so this can be upgraded without a contract change).
   */
  async setStatus(
    targetId: string,
    status: AdminStatus,
    actorAdminId: string,
  ): Promise<AdminResponseDto> {
    if (status !== AdminStatus.ACTIVE && status !== AdminStatus.DISABLED) {
      throw new AppException(AppErrorCode.ADMIN_INVALID_STATUS);
    }

    const target = await this.adminModel.findById(targetId).exec();
    if (!target) {
      throw new AppException(AppErrorCode.ADMIN_NOT_FOUND);
    }
    if (target.status === status) {
      return toAdminResponse(target);
    }

    const actorObjectId = Types.ObjectId.isValid(actorAdminId)
      ? new Types.ObjectId(actorAdminId)
      : null;

    if (status === AdminStatus.DISABLED) {
      if (String(target._id) === String(actorAdminId)) {
        throw new AppException(AppErrorCode.ADMIN_CANNOT_DISABLE_SELF);
      }
      const otherActive = await this.adminModel.countDocuments({
        _id: { $ne: target._id },
        status: AdminStatus.ACTIVE,
      });
      if (otherActive === 0) {
        throw new AppException(AppErrorCode.ADMIN_LAST_ACTIVE);
      }

      const updated = await this.adminModel
        .findByIdAndUpdate(
          target._id,
          {
            $set: {
              status: AdminStatus.DISABLED,
              disabledAt: new Date(),
              disabledBy: actorObjectId,
              refreshTokenHash: null,
              refreshTokenExpiresAt: null,
            },
            $inc: { tokenVersion: 1 },
          },
          { new: true },
        )
        .exec();
      return toAdminResponse(updated ?? target);
    }

    const updated = await this.adminModel
      .findByIdAndUpdate(
        target._id,
        { $set: { status: AdminStatus.ACTIVE, disabledAt: null, disabledBy: null } },
        { new: true },
      )
      .exec();
    return toAdminResponse(updated ?? target);
  }
}
