import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AdminStatus } from '../../../common/constants/admin-status.enum';

export interface AdminPrincipal {
  id: string;
  email: string;
  status: AdminStatus;
  tokenVersion: number;
}

/** Controller-side identity. Admin routes never read `req.user` (that is the seller context). */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AdminPrincipal | undefined => {
    const request = context.switchToHttp().getRequest();
    return request.admin;
  },
);
