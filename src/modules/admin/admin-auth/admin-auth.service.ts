import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { Admin, AdminDocument } from '../schemas/admin.schema';
import { AdminStatus } from '../../../common/constants/admin-status.enum';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { AdminLoginDto } from '../dto/admin-login.dto';
import { ChangeAdminPasswordDto } from '../dto/change-admin-password.dto';
import { AdminResponseDto, toAdminResponse } from '../mappers/admin-response.mapper';
import { ADMIN_TOKEN_TYPE } from './admin-session.util';

export interface AdminTokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface AdminAuthResult {
  admin: AdminResponseDto;
  tokens: AdminTokenPair;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);
  private readonly bcryptRounds: number;
  private readonly refreshTtlMs: number;
  /** A real bcrypt hash compared when no admin matches, so timing does not reveal existence. */
  private readonly dummyHash: string;

  constructor(
    @InjectModel(Admin.name) private readonly adminModel: Model<AdminDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    const rounds = this.configService.get<number>('adminAuth.bcryptRounds') ?? 12;
    this.bcryptRounds = Number.isFinite(rounds) && rounds > 0 ? rounds : 12;
    const hours = this.configService.get<number>('adminAuth.refreshTtlHours') ?? 12;
    this.refreshTtlMs = (Number.isFinite(hours) && hours > 0 ? hours : 12) * 60 * 60 * 1000;
    this.dummyHash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), this.bcryptRounds);
  }

  async login(dto: AdminLoginDto): Promise<AdminAuthResult> {
    const email = dto.email.trim().toLowerCase();
    const admin = await this.adminModel.findOne({ email }).select('+passwordHash').exec();

    if (!admin) {
      await bcrypt.compare(dto.password, this.dummyHash);
      throw new AppException(AppErrorCode.AUTH_INVALID_CREDENTIALS);
    }

    const valid = await bcrypt.compare(dto.password, admin.passwordHash);
    if (!valid) {
      throw new AppException(AppErrorCode.AUTH_INVALID_CREDENTIALS);
    }
    if (admin.status !== AdminStatus.ACTIVE) {
      throw new AppException(AppErrorCode.AUTH_ACCOUNT_DISABLED);
    }

    const now = new Date();
    const tokens = await this.issueSession(admin, { lastLoginAt: now });
    admin.lastLoginAt = now;
    this.logger.log(`[ADMIN_LOGIN] adminId=${admin._id}`);
    return { admin: toAdminResponse(admin), tokens };
  }

  async refresh(rawRefreshToken: string | undefined): Promise<AdminAuthResult> {
    if (!rawRefreshToken) {
      throw new AppException(AppErrorCode.AUTH_INVALID_REFRESH_TOKEN);
    }
    const tokenHash = sha256(rawRefreshToken);
    const admin = await this.adminModel
      .findOne({ refreshTokenHash: tokenHash })
      .select('+refreshTokenHash +refreshTokenExpiresAt')
      .exec();

    if (!admin) {
      throw new AppException(AppErrorCode.AUTH_INVALID_REFRESH_TOKEN);
    }

    if (!admin.refreshTokenExpiresAt || admin.refreshTokenExpiresAt.getTime() < Date.now()) {
      await this.clearRefreshToken(admin._id);
      throw new AppException(AppErrorCode.AUTH_REFRESH_TOKEN_EXPIRED);
    }
    if (admin.status !== AdminStatus.ACTIVE) {
      await this.clearRefreshToken(admin._id);
      throw new AppException(AppErrorCode.AUTH_ACCOUNT_DISABLED);
    }

    const tokens = await this.issueSession(admin);
    return { admin: toAdminResponse(admin), tokens };
  }

  /** Idempotent: an unknown/absent refresh token is not an error. Never reveals anything. */
  async logout(rawRefreshToken: string | undefined): Promise<void> {
    if (!rawRefreshToken) return;
    try {
      await this.adminModel.updateOne(
        { refreshTokenHash: sha256(rawRefreshToken) },
        { $set: { refreshTokenHash: null, refreshTokenExpiresAt: null } },
      );
    } catch {
      /* Best effort: the cookies are cleared by the controller regardless. */
    }
  }

  async me(adminId: string): Promise<AdminResponseDto> {
    const admin = await this.adminModel.findById(adminId).exec();
    if (!admin) {
      throw new AppException(AppErrorCode.ADMIN_NOT_FOUND);
    }
    if (admin.status !== AdminStatus.ACTIVE) {
      throw new AppException(AppErrorCode.AUTH_ACCOUNT_DISABLED);
    }
    return toAdminResponse(admin);
  }

  async changePassword(adminId: string, dto: ChangeAdminPasswordDto): Promise<void> {
    if (dto.newPassword !== dto.confirmPassword) {
      throw new AppException(AppErrorCode.USER_PASSWORDS_DO_NOT_MATCH);
    }

    const admin = await this.adminModel.findById(adminId).select('+passwordHash').exec();
    if (!admin) {
      throw new AppException(AppErrorCode.ADMIN_NOT_FOUND);
    }

    const currentValid = await bcrypt.compare(dto.currentPassword, admin.passwordHash);
    if (!currentValid) {
      throw new AppException(AppErrorCode.USER_CURRENT_PASSWORD_INCORRECT);
    }
    if (await bcrypt.compare(dto.newPassword, admin.passwordHash)) {
      throw new AppException(AppErrorCode.USER_PASSWORD_SAME_AS_OLD);
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, this.bcryptRounds);
    await this.adminModel.updateOne(
      { _id: admin._id },
      {
        $set: {
          passwordHash,
          passwordChangedAt: new Date(),
          refreshTokenHash: null,
          refreshTokenExpiresAt: null,
        },
        $inc: { tokenVersion: 1 },
      },
    );
    this.logger.log(`[ADMIN_PASSWORD_CHANGED] adminId=${admin._id} (all sessions revoked)`);
  }

  private async issueSession(
    admin: AdminDocument,
    extra: Record<string, unknown> = {},
  ): Promise<AdminTokenPair> {
    const refreshToken = crypto.randomBytes(48).toString('hex');
    const refreshTokenHash = sha256(refreshToken);
    const refreshTokenExpiresAt = new Date(Date.now() + this.refreshTtlMs);
    const accessToken = this.jwtService.sign({
      sub: String(admin._id),
      typ: ADMIN_TOKEN_TYPE,
      tokenVersion: admin.tokenVersion ?? 0,
    });

    await this.adminModel.updateOne(
      { _id: admin._id },
      { $set: { refreshTokenHash, refreshTokenExpiresAt, ...extra } },
    );

    return { accessToken, refreshToken };
  }

  private async clearRefreshToken(adminId: any): Promise<void> {
    await this.adminModel.updateOne(
      { _id: adminId },
      { $set: { refreshTokenHash: null, refreshTokenExpiresAt: null } },
    );
  }
}
