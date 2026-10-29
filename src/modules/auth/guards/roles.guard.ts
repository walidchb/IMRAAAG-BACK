import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../../../common/constants/roles.enum';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // `@Public()` wins, exactly as it does in `JwtAuthGuard`. Without this a class-level
    // `@Roles` silently re-imposes authentication on a route that was explicitly marked public:
    // the global JWT guard steps aside, then this one throws AUTH_UNAUTHORIZED anyway, and the
    // route is unreachable for the anonymous visitors it was written for.
    //
    // The override is only read from the handler when the handler declares it, so a controller
    // that marks some routes public does not lose the role requirement on its other routes.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

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
