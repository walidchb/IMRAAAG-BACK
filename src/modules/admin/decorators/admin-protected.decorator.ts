import { applyDecorators, UseGuards } from '@nestjs/common';
import { Public } from '../../auth/decorators/public.decorator';
import { AdminJwtAuthGuard } from '../admin-auth/admin-jwt-auth.guard';
import { AdminOriginGuard } from '../admin-auth/admin-origin.guard';

/**
 * Marks a route public for the *seller* guards, then protects it with the admin-only pair:
 * `AdminJwtAuthGuard` (a seller token can never satisfy it) and `AdminOriginGuard` (state
 * changes must come from an allow-listed browser origin).
 */
export const AdminProtected = () =>
  applyDecorators(Public(), UseGuards(AdminJwtAuthGuard, AdminOriginGuard));
