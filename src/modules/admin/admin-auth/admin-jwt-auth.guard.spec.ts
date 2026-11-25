import { AdminJwtAuthGuard } from './admin-jwt-auth.guard';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as AppException).errorCode;
  }
  return undefined;
}

describe('AdminJwtAuthGuard', () => {
  const guard = new AdminJwtAuthGuard();

  it('returns the admin principal when authentication succeeded', () => {
    const principal = { id: 'a1', email: 'a@b.c', status: 'active', tokenVersion: 0 };
    expect(guard.handleRequest(null, principal, null)).toBe(principal);
  });

  it('maps an expired token', () => {
    expect(
      codeOf(() => guard.handleRequest(null, null, { name: 'TokenExpiredError' })),
    ).toBe(AppErrorCode.AUTH_TOKEN_EXPIRED);
  });

  it('maps a wrong-signature/invalid token', () => {
    expect(
      codeOf(() =>
        guard.handleRequest(null, null, {
          name: 'JsonWebTokenError',
          message: 'invalid signature',
        }),
      ),
    ).toBe(AppErrorCode.AUTH_TOKEN_INVALID);
  });

  it('maps a wrong issuer/audience token', () => {
    expect(
      codeOf(() =>
        guard.handleRequest(null, null, {
          name: 'JsonWebTokenError',
          message: 'jwt audience invalid',
        }),
      ),
    ).toBe(AppErrorCode.AUTH_TOKEN_INVALID);
  });

  it('falls back to unauthorized when no token is present', () => {
    expect(codeOf(() => guard.handleRequest(null, null, null))).toBe(
      AppErrorCode.AUTH_UNAUTHORIZED,
    );
  });

  it('rethrows an AppException thrown by the strategy untouched', () => {
    const original = new AppException(AppErrorCode.AUTH_ACCOUNT_DISABLED);
    expect(codeOf(() => guard.handleRequest(original, null, null))).toBe(
      AppErrorCode.AUTH_ACCOUNT_DISABLED,
    );
  });
});
