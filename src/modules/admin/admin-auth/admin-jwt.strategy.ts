import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { PassportStrategy } from '@nestjs/passport';
import { Model, Types } from 'mongoose';
import { Request } from 'express';
import { Strategy } from 'passport-jwt';
import { Admin, AdminDocument } from '../schemas/admin.schema';
import { AdminStatus } from '../../../common/constants/admin-status.enum';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import {
  ADMIN_ACCESS_COOKIE,
  ADMIN_TOKEN_AUDIENCE,
  ADMIN_TOKEN_ISSUER,
  ADMIN_TOKEN_TYPE,
  resolveAdminJwtSecret,
} from './admin-session.util';

interface AdminJwtPayload {
  sub: string;
  typ?: string;
  tokenVersion?: number;
}

@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor(
    configService: ConfigService,
    @InjectModel(Admin.name) private readonly adminModel: Model<AdminDocument>,
  ) {
    super({
      jwtFromRequest: (req: Request) => req?.cookies?.[ADMIN_ACCESS_COOKIE] ?? null,
      ignoreExpiration: false,
      // Pin the algorithm and require the admin issuer/audience: a seller token (different
      // secret) and an arbitrary JWT both fail before the database is touched.
      algorithms: ['HS256'],
      secretOrKey: resolveAdminJwtSecret(configService),
      issuer: ADMIN_TOKEN_ISSUER,
      audience: ADMIN_TOKEN_AUDIENCE,
    });
  }

  async validate(payload: AdminJwtPayload) {
    if (!payload || payload.typ !== ADMIN_TOKEN_TYPE || !payload.sub) {
      throw new AppException(AppErrorCode.AUTH_TOKEN_INVALID);
    }
    if (!Types.ObjectId.isValid(payload.sub)) {
      throw new AppException(AppErrorCode.AUTH_TOKEN_INVALID);
    }

    const admin = await this.adminModel.findById(payload.sub).exec();
    if (!admin) {
      throw new AppException(AppErrorCode.ADMIN_NOT_FOUND);
    }
    if (admin.status !== AdminStatus.ACTIVE) {
      throw new AppException(AppErrorCode.AUTH_ACCOUNT_DISABLED);
    }
    if ((payload.tokenVersion ?? 0) !== (admin.tokenVersion ?? 0)) {
      throw new AppException(AppErrorCode.AUTH_TOKEN_INVALID);
    }

    return {
      id: String(admin._id),
      email: admin.email,
      status: admin.status,
      tokenVersion: admin.tokenVersion ?? 0,
    };
  }
}
