import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../../../common/constants/roles.enum';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles) {
      return true;
    }
    const { user } = context.switchToHttp().getRequest();
    if (!user) {
      throw new AppException(AppErrorCode.AUTH_UNAUTHORIZED);
    }
    if (requiredRoles.includes(user?.role)) {
      return true;
    }

    if (requiredRoles.length === 1) {
      if (requiredRoles[0] === Role.ADMIN) {
        throw new AppException(AppErrorCode.AUTH_ADMIN_ONLY);
      }
      if (requiredRoles[0] === Role.VENDOR) {
        throw new AppException(AppErrorCode.AUTH_VENDOR_ONLY);
      }
    }
    throw new AppException(AppErrorCode.AUTH_INSUFFICIENT_PERMISSIONS);
  }
}
