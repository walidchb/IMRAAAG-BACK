import { ConfigService } from '@nestjs/config';
import { AdminOriginGuard } from './admin-origin.guard';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';

function configWith(origins: string[]): ConfigService {
  return {
    get: (key: string) => (key === 'adminAuth.webOrigins' ? origins : undefined),
  } as unknown as ConfigService;
}

function context(method: string, headers: Record<string, string> = {}): any {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method, headers }),
    }),
  };
}

describe('AdminOriginGuard', () => {
  const allowed = ['https://admin.imraaah.com', 'http://localhost:3003'];

  it('allows read-only methods without an Origin header', () => {
    const guard = new AdminOriginGuard(configWith(allowed));
    expect(guard.canActivate(context('GET'))).toBe(true);
    expect(guard.canActivate(context('HEAD'))).toBe(true);
    expect(guard.canActivate(context('OPTIONS'))).toBe(true);
  });

  it('allows a POST from an allow-listed Origin', () => {
    const guard = new AdminOriginGuard(configWith(allowed));
    expect(
      guard.canActivate(context('POST', { origin: 'http://localhost:3003' })),
    ).toBe(true);
  });

  it('allows a POST whose Referer matches the allow-list', () => {
    const guard = new AdminOriginGuard(configWith(allowed));
    expect(
      guard.canActivate(
        context('POST', { referer: 'https://admin.imraaah.com/en/admin-users?x=1' }),
      ),
    ).toBe(true);
  });

  it('rejects a foreign Origin', () => {
    const guard = new AdminOriginGuard(configWith(allowed));
    expect(() =>
      guard.canActivate(context('POST', { origin: 'https://evil.example' })),
    ).toThrow(AppException);
    try {
      guard.canActivate(context('POST', { origin: 'https://evil.example' }));
    } catch (error) {
      expect((error as AppException).errorCode).toBe(AppErrorCode.ADMIN_ORIGIN_REJECTED);
    }
  });

  it('rejects a state change with neither Origin nor Referer', () => {
    const guard = new AdminOriginGuard(configWith(allowed));
    expect(() => guard.canActivate(context('PATCH'))).toThrow(AppException);
  });

  it('rejects every write when no origin is configured', () => {
    const guard = new AdminOriginGuard(configWith([]));
    expect(() =>
      guard.canActivate(context('POST', { origin: 'https://admin.imraaah.com' })),
    ).toThrow(AppException);
  });
});
