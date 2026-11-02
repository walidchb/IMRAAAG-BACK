import { Injectable } from '@nestjs/common';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Request } from 'express';
import { Model } from 'mongoose';
import { User, UserDocument } from '../../users/schemas/user.schema';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (req: Request) => req?.cookies?.auth_token || null,
      ]),
      ignoreExpiration: false,
      // Pin the algorithm: a token can never choose how it is verified (M19).
      algorithms: ['HS256'],
      secretOrKey: configService.get<string>('jwt.secret')!,
    });
  }

  async validate(payload: {
    sub: string;
    email?: string;
    role?: string;
    type?: string;
    tokenVersion?: number;
  }) {
    // An OTP-verification token is a one-purpose credential for `reset-password-phone`; it is
    // never a session. Refusing it here keeps it out of every authenticated route (H3).
    if (payload.type === 'otp_verification') {
      throw new AppException(AppErrorCode.AUTH_TOKEN_INVALID);
    }

    const user = await this.userModel.findById(payload.sub);
    if (!user) {
      throw new AppException(AppErrorCode.AUTH_USER_NOT_FOUND);
    }
    if (!user.isActive) {
      throw new AppException(AppErrorCode.AUTH_ACCOUNT_DISABLED);
    }

    // Revocation (H3): a password reset/change or deactivation bumps `tokenVersion`, which
    // invalidates every access token issued before it. Tokens predating the field are 0.
    const expectedVersion = user.tokenVersion ?? 0;
    if ((payload.tokenVersion ?? 0) !== expectedVersion) {
      throw new AppException(AppErrorCode.AUTH_TOKEN_INVALID);
    }

    return { id: user._id, email: user.email, role: user.role, fullName: user.fullName, phoneNumber: user.phoneNumber };
  }
}
