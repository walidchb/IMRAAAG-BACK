import { Injectable } from '@nestjs/common';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from '../../users/schemas/user.schema';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('jwt.secret')!,
    });
  }

  async validate(payload: { sub: string; email?: string; role?: string; type?: string }) {
    if (payload.type === 'otp_verification') {
      return { phoneNumber: payload.sub, type: 'otp_verification' };
    }

    const user = await this.userModel.findById(payload.sub);
    if (!user) {
      throw new AppException(AppErrorCode.AUTH_USER_NOT_FOUND);
    }
    if (!user.isActive) {
      throw new AppException(AppErrorCode.AUTH_ACCOUNT_DISABLED);
    }
    return { id: user._id, email: user.email, role: user.role, fullName: user.fullName, phoneNumber: user.phoneNumber };
  }
}
