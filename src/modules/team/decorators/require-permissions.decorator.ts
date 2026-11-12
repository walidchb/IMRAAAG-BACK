import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Requires every listed store permission. Declared on a controller (class-level) or a handler
 * (method-level, overriding the class). The global `PermissionsGuard` evaluates it after the
 * JWT guard has populated `req.user`.
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
