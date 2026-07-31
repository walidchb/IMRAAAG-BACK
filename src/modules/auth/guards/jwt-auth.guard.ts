import { Injectable, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  handleRequest(err: any, user: any, info: any, context: ExecutionContext, status?: any) {
    if (err || !user) {
      if (!err && info) {
        const msg = info.message || '';
        if (msg.includes('expired') || info.name === 'TokenExpiredError') {
          throw new AppException(AppErrorCode.AUTH_TOKEN_EXPIRED);
        }
        if (msg.includes('malformed') || msg.includes('signature') || info.name === 'JsonWebTokenError') {
          throw new AppException(AppErrorCode.AUTH_TOKEN_INVALID);
        }
      }
      throw err || new AppException(AppErrorCode.AUTH_UNAUTHORIZED);
    }
    return user;
  }
}
