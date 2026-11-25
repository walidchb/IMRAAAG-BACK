import type { CookieOptions, Response } from 'express';
import { ConfigService } from '@nestjs/config';

export const ADMIN_ACCESS_COOKIE = 'admin_access_token';
export const ADMIN_REFRESH_COOKIE = 'admin_refresh_token';
export const ADMIN_ACCESS_COOKIE_PATH = '/api/admin';
export const ADMIN_REFRESH_COOKIE_PATH = '/api/admin/auth';

export const ADMIN_TOKEN_ISSUER = 'imraaah-admin';
export const ADMIN_TOKEN_AUDIENCE = 'imraaah-admin';
export const ADMIN_TOKEN_TYPE = 'admin';

const DEFAULT_ACCESS_TTL_MS = 15 * 60 * 1000;
const DEFAULT_REFRESH_TTL_MS = 12 * 60 * 60 * 1000;

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * The Admin Panel signs with its own secret. Production refuses to boot without one (main.ts);
 * development derives a stable, non-production-only value so the API still starts locally
 * without weakening a deployed environment.
 */
export function resolveAdminJwtSecret(config: ConfigService): string {
  const configured = config.get<string>('adminAuth.jwtSecret');
  if (configured?.trim()) return configured.trim();
  if (isProduction()) {
    throw new Error('ADMIN_JWT_SECRET is required in production.');
  }
  return `${config.get<string>('jwt.secret') ?? 'imraaah-dev'}:admin-dev`;
}

/** Parses `15m` / `12h` / `30s` / `7d` (or a bare number of seconds) into milliseconds. */
export function parseDurationMs(raw: string | undefined, fallbackMs: number): number {
  if (!raw) return fallbackMs;
  const match = /^(\d+)\s*([smhd])?$/i.exec(raw.trim());
  if (!match) return fallbackMs;
  const value = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  const factor = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : unit === 'm' ? 60000 : 1000;
  return value * factor;
}

export function adminAccessMaxAgeMs(config: ConfigService): number {
  return parseDurationMs(config.get<string>('adminAuth.accessTtl'), DEFAULT_ACCESS_TTL_MS);
}

export function adminRefreshMaxAgeMs(config: ConfigService): number {
  const hours = config.get<number>('adminAuth.refreshTtlHours') ?? 12;
  return (Number.isFinite(hours) && hours > 0 ? hours : 12) * 60 * 60 * 1000;
}

/** Host-only cookies (never a `Domain`), `Secure` + `SameSite=Strict` in production. */
function baseCookieOptions(): CookieOptions {
  const production = isProduction();
  return {
    httpOnly: true,
    secure: production,
    sameSite: production ? 'strict' : 'lax',
  };
}

export function adminAccessCookieOptions(config: ConfigService): CookieOptions {
  return {
    ...baseCookieOptions(),
    path: ADMIN_ACCESS_COOKIE_PATH,
    maxAge: adminAccessMaxAgeMs(config),
  };
}

export function adminRefreshCookieOptions(config: ConfigService): CookieOptions {
  return {
    ...baseCookieOptions(),
    path: ADMIN_REFRESH_COOKIE_PATH,
    maxAge: adminRefreshMaxAgeMs(config),
  };
}

export interface AdminTokenPair {
  accessToken: string;
  refreshToken: string;
}

export function setAdminAuthCookies(
  res: Response,
  tokens: AdminTokenPair,
  config: ConfigService,
): void {
  res.cookie(ADMIN_ACCESS_COOKIE, tokens.accessToken, adminAccessCookieOptions(config));
  res.cookie(ADMIN_REFRESH_COOKIE, tokens.refreshToken, adminRefreshCookieOptions(config));
}

/** Clears both cookies with the exact path/flags they were set with. */
export function clearAdminAuthCookies(res: Response): void {
  res.clearCookie(ADMIN_ACCESS_COOKIE, {
    ...baseCookieOptions(),
    path: ADMIN_ACCESS_COOKIE_PATH,
  });
  res.clearCookie(ADMIN_REFRESH_COOKIE, {
    ...baseCookieOptions(),
    path: ADMIN_REFRESH_COOKIE_PATH,
  });
}
