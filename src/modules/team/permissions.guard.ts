import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { Role } from '../../common/constants/roles.enum';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { PERMISSIONS_KEY } from './decorators/require-permissions.decorator';
import { StoreAccessService } from './store-access.service';

/**
 * Enforces `@RequirePermissions(...)` on top of the platform `@Roles` guard.
 *
 * Backward-compatible rollout:
 *  - `@Public()` → allow;
 *  - no permission metadata → allow (existing routes keep working unchanged);
 *  - platform `ADMIN` → allow;
 *  - otherwise resolve the caller's store access and require **all** listed permissions.
 *
 * The resolved access is memoised on `req.storeAccess` so a controller can reuse it without a
 * second membership lookup.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly storeAccessService: StoreAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user as { id?: string; role?: string } | undefined;
    if (!user?.id) {
      throw new AppException(AppErrorCode.AUTH_UNAUTHORIZED);
    }
    if (user.role === Role.ADMIN) return true;

    const access =
      request.storeAccess ??
      (await this.storeAccessService.resolveForUserOrThrow({
        id: user.id,
        role: user.role,
      }));
    request.storeAccess = access;

    for (const permission of required) {
      if (!this.storeAccessService.hasPermission(access, permission)) {
        throw new AppException(AppErrorCode.AUTH_INSUFFICIENT_PERMISSIONS, { permission });
      }
    }

    return true;
  }
}
