import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';

function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * CSRF defense for admin state changes: `SameSite=Strict` (prod) plus an explicit
 * Origin/Referer allow-list. GET/HEAD/OPTIONS are read-only and always allowed.
 *
 * Missing origin *and* referer is rejected — a browser always sends one for a same-origin
 * fetch/form POST, so absence means a non-browser caller.
 */
@Injectable()
export class AdminOriginGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const method = (request.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;

    const allowed = (this.configService.get<string[]>('adminAuth.webOrigins') ?? []).map(
      normalizeOrigin,
    );
    const originHeader = request.headers.origin;
    let candidate = typeof originHeader === 'string' ? originHeader : null;

    if (!candidate) {
      const referer = request.headers.referer;
      if (typeof referer === 'string') {
        try {
          candidate = new URL(referer).origin;
        } catch {
          candidate = null;
        }
      }
    }

    if (candidate && allowed.includes(normalizeOrigin(candidate))) {
      return true;
    }
    throw new AppException(AppErrorCode.ADMIN_ORIGIN_REJECTED);
  }
}
