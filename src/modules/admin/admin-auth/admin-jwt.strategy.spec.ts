import { ConfigService } from '@nestjs/config';
import { AdminJwtStrategy } from './admin-jwt.strategy';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { AdminStatus } from '../../../common/constants/admin-status.enum';

const ADMIN_ID = '507f1f77bcf86cd799439011';

function config(): ConfigService {
  return {
    get: (key: string) => {
      if (key === 'adminAuth.jwtSecret') return 'admin-secret';
      if (key === 'jwt.secret') return 'seller-secret';
      return undefined;
    },
  } as unknown as ConfigService;
}

function modelReturning(admin: unknown) {
  const query: any = {
    exec: async () => admin,
  };
  return { findById: jest.fn(() => query) } as any;
}

function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  return fn().then(
    () => undefined,
    (error) => (error as AppException).errorCode,
  );
}

describe('AdminJwtStrategy', () => {
  const activeAdmin = {
    _id: ADMIN_ID,
    email: 'admin@imraaah.com',
    status: AdminStatus.ACTIVE,
    tokenVersion: 2,
  };

  it('accepts an admin token and attaches the principal', async () => {
    const strategy = new AdminJwtStrategy(config(), modelReturning(activeAdmin));
    await expect(
      strategy.validate({ sub: ADMIN_ID, typ: 'admin', tokenVersion: 2 }),
    ).resolves.toEqual({
      id: ADMIN_ID,
      email: 'admin@imraaah.com',
      status: AdminStatus.ACTIVE,
      tokenVersion: 2,
    });
  });

  it('rejects a non-admin (seller-shaped) payload before any database read', async () => {
    const model = modelReturning(activeAdmin);
    const strategy = new AdminJwtStrategy(config(), model);
    expect(
      await codeOf(() => strategy.validate({ sub: ADMIN_ID, tokenVersion: 0 } as any)),
    ).toBe(AppErrorCode.AUTH_TOKEN_INVALID);
    expect(model.findById).not.toHaveBeenCalled();
  });

  it('rejects a malformed subject', async () => {
    const strategy = new AdminJwtStrategy(config(), modelReturning(activeAdmin));
    expect(
      await codeOf(() => strategy.validate({ sub: 'not-an-id', typ: 'admin' })),
    ).toBe(AppErrorCode.AUTH_TOKEN_INVALID);
  });

  it('rejects an unknown admin', async () => {
    const strategy = new AdminJwtStrategy(config(), modelReturning(null));
    expect(
      await codeOf(() => strategy.validate({ sub: ADMIN_ID, typ: 'admin' })),
    ).toBe(AppErrorCode.ADMIN_NOT_FOUND);
  });

  it('rejects a disabled admin even with a valid token', async () => {
    const strategy = new AdminJwtStrategy(
      config(),
      modelReturning({ ...activeAdmin, status: AdminStatus.DISABLED }),
    );
    expect(
      await codeOf(() => strategy.validate({ sub: ADMIN_ID, typ: 'admin' })),
    ).toBe(AppErrorCode.AUTH_ACCOUNT_DISABLED);
  });

  it('rejects a token whose generation no longer matches', async () => {
    const strategy = new AdminJwtStrategy(config(), modelReturning(activeAdmin));
    expect(
      await codeOf(() =>
        strategy.validate({ sub: ADMIN_ID, typ: 'admin', tokenVersion: 1 }),
      ),
    ).toBe(AppErrorCode.AUTH_TOKEN_INVALID);
  });
});
