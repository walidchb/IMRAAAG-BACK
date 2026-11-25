import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';

@Injectable()
export class AdminJwtAuthGuard extends AuthGuard('admin-jwt') {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // No reflector bypass: the seller `@Public()` decorator does not open an admin route.
    const result = (await super.canActivate(context)) as boolean;
    const request = context.switchToHttp().getRequest();
    // Passport writes its result to `req.user`; admin routes read only `req.admin`.
    if (request.user) {
      request.admin = request.user;
      delete request.user;
    }
    return result;
  }

  handleRequest(err: any, admin: any, info: any) {
    if (err) throw err;
    if (!admin) {
      const message = info?.message ?? '';
      if (info?.name === 'TokenExpiredError' || message.includes('expired')) {
        throw new AppException(AppErrorCode.AUTH_TOKEN_EXPIRED);
      }
      if (
        info?.name === 'JsonWebTokenError' ||
        /malformed|signature|audience|issuer|invalid/i.test(message)
      ) {
        throw new AppException(AppErrorCode.AUTH_TOKEN_INVALID);
      }
      throw new AppException(AppErrorCode.AUTH_UNAUTHORIZED);
    }
    return admin;
  }
}
