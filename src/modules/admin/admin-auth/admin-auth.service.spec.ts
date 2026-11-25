jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
  hashSync: jest.fn(() => 'dummy-hash'),
}));

import * as bcrypt from 'bcrypt';
import { AdminAuthService } from './admin-auth.service';
import { AdminStatus } from '../../../common/constants/admin-status.enum';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';

const ADMIN_ID = '507f1f77bcf86cd799439011';

const compareMock = bcrypt.compare as jest.Mock;
const hashMock = bcrypt.hash as jest.Mock;

function query(result: unknown) {
  const q: any = { select: () => q, exec: async () => result };
  return q;
}

function activeDoc(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    _id: ADMIN_ID,
    firstName: 'Amina',
    lastName: 'Bensalem',
    email: 'amina@imraaah.com',
    status: AdminStatus.ACTIVE,
    tokenVersion: 0,
    passwordHash: 'stored-hash',
    refreshTokenHash: 'old-hash',
    refreshTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    lastLoginAt: null,
    passwordChangedAt: null,
    disabledAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('AdminAuthService', () => {
  let adminModel: any;
  let jwt: any;
  let service: AdminAuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    adminModel = {
      findOne: jest.fn(),
      findById: jest.fn(),
      updateOne: jest.fn().mockResolvedValue(undefined),
    };
    jwt = { sign: jest.fn(() => 'access-token') };
    const config: any = {
      get: (key: string) =>
        key === 'adminAuth.bcryptRounds' ? 12 : key === 'adminAuth.refreshTtlHours' ? 12 : undefined,
    };
    service = new AdminAuthService(adminModel, jwt, config);
  });

  function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
    return promise.then(
      () => undefined,
      (error) => (error as AppException).errorCode,
    );
  }

  describe('login', () => {
    it('rejects an unknown email with a generic error and a constant-time compare', async () => {
      adminModel.findOne.mockReturnValue(query(null));
      compareMock.mockResolvedValue(false);

      expect(
        await codeOf(
          service.login({ email: 'nobody@imraaah.com', password: 'whatever123' } as any),
        ),
      ).toBe(AppErrorCode.AUTH_INVALID_CREDENTIALS);
      expect(compareMock).toHaveBeenCalledWith('whatever123', 'dummy-hash');
    });

    it('rejects a wrong password', async () => {
      adminModel.findOne.mockReturnValue(query(activeDoc()));
      compareMock.mockResolvedValue(false);
      expect(
        await codeOf(service.login({ email: 'amina@imraaah.com', password: 'wrong12345' } as any)),
      ).toBe(AppErrorCode.AUTH_INVALID_CREDENTIALS);
      expect(adminModel.updateOne).not.toHaveBeenCalled();
    });

    it('rejects a disabled admin only after the password check', async () => {
      adminModel.findOne.mockReturnValue(query(activeDoc({ status: AdminStatus.DISABLED })));
      compareMock.mockResolvedValue(true);
      expect(
        await codeOf(service.login({ email: 'amina@imraaah.com', password: 'correct123' } as any)),
      ).toBe(AppErrorCode.AUTH_ACCOUNT_DISABLED);
      expect(adminModel.updateOne).not.toHaveBeenCalled();
    });

    it('issues an access token plus a hashed, rotated refresh token and never returns secrets', async () => {
      const doc = activeDoc();
      adminModel.findOne.mockReturnValue(query(doc));
      compareMock.mockResolvedValue(true);

      const result = await service.login({
        email: 'AMINA@imraaah.com',
        password: 'correct123',
      } as any);

      expect(result.tokens.accessToken).toBe('access-token');
      expect(result.tokens.refreshToken).toMatch(/^[0-9a-f]{96}$/);
      expect(JSON.stringify(result.admin)).not.toContain('stored-hash');
      expect((result.admin as any).passwordHash).toBeUndefined();
      expect((result.admin as any).tokenVersion).toBeUndefined();

      expect(jwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: ADMIN_ID, typ: 'admin', tokenVersion: 0 }),
      );
      const update = adminModel.updateOne.mock.calls[0][1].$set;
      expect(update.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(update.refreshTokenExpiresAt).toBeInstanceOf(Date);
      expect(update.lastLoginAt).toBeInstanceOf(Date);
    });
  });

  describe('refresh', () => {
    it('rejects a missing refresh cookie', async () => {
      expect(await codeOf(service.refresh(undefined))).toBe(
        AppErrorCode.AUTH_INVALID_REFRESH_TOKEN,
      );
    });

    it('rejects an unknown refresh token', async () => {
      adminModel.findOne.mockReturnValue(query(null));
      expect(await codeOf(service.refresh('deadbeef'))).toBe(
        AppErrorCode.AUTH_INVALID_REFRESH_TOKEN,
      );
    });

    it('clears and rejects an expired refresh token', async () => {
      adminModel.findOne.mockReturnValue(
        query(activeDoc({ refreshTokenExpiresAt: new Date(Date.now() - 1000) })),
      );
      expect(await codeOf(service.refresh('old-token'))).toBe(
        AppErrorCode.AUTH_REFRESH_TOKEN_EXPIRED,
      );
      expect(adminModel.updateOne).toHaveBeenCalledWith(
        { _id: ADMIN_ID },
        { $set: { refreshTokenHash: null, refreshTokenExpiresAt: null } },
      );
    });

    it('refuses to refresh a disabled admin and clears the token', async () => {
      adminModel.findOne.mockReturnValue(query(activeDoc({ status: AdminStatus.DISABLED })));
      expect(await codeOf(service.refresh('old-token'))).toBe(
        AppErrorCode.AUTH_ACCOUNT_DISABLED,
      );
      expect(adminModel.updateOne).toHaveBeenCalled();
    });

    it('rotates the refresh hash and returns a new pair', async () => {
      adminModel.findOne.mockReturnValue(query(activeDoc()));
      const result = await service.refresh('old-token');
      expect(result.tokens.refreshToken).toMatch(/^[0-9a-f]{96}$/);
      expect(adminModel.updateOne.mock.calls[0][1].$set.refreshTokenHash).toMatch(
        /^[0-9a-f]{64}$/,
      );
    });
  });

  describe('logout', () => {
    it('is a no-op without a refresh token', async () => {
      await service.logout(undefined);
      expect(adminModel.updateOne).not.toHaveBeenCalled();
    });

    it('nulls the stored refresh hash', async () => {
      await service.logout('some-token');
      expect(adminModel.updateOne).toHaveBeenCalledWith(
        { refreshTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
        { $set: { refreshTokenHash: null, refreshTokenExpiresAt: null } },
      );
    });
  });

  describe('me', () => {
    it('returns the profile for an active admin', async () => {
      adminModel.findById.mockReturnValue(query(activeDoc()));
      await expect(service.me(ADMIN_ID)).resolves.toMatchObject({
        id: ADMIN_ID,
        email: 'amina@imraaah.com',
        fullName: 'Amina Bensalem',
      });
    });

    it('rejects an unknown admin', async () => {
      adminModel.findById.mockReturnValue(query(null));
      expect(await codeOf(service.me(ADMIN_ID))).toBe(AppErrorCode.ADMIN_NOT_FOUND);
    });
  });

  describe('changePassword', () => {
    const dto = {
      currentPassword: 'current123',
      newPassword: 'brandnew123',
      confirmPassword: 'brandnew123',
    };

    it('rejects a mismatched confirmation', async () => {
      expect(
        await codeOf(
          service.changePassword(ADMIN_ID, { ...dto, confirmPassword: 'other12345' } as any),
        ),
      ).toBe(AppErrorCode.USER_PASSWORDS_DO_NOT_MATCH);
    });

    it('rejects a wrong current password', async () => {
      adminModel.findById.mockReturnValue(query(activeDoc()));
      compareMock.mockResolvedValue(false);
      expect(await codeOf(service.changePassword(ADMIN_ID, dto as any))).toBe(
        AppErrorCode.USER_CURRENT_PASSWORD_INCORRECT,
      );
    });

    it('rejects reusing the current password', async () => {
      adminModel.findById.mockReturnValue(query(activeDoc()));
      compareMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      expect(await codeOf(service.changePassword(ADMIN_ID, dto as any))).toBe(
        AppErrorCode.USER_PASSWORD_SAME_AS_OLD,
      );
    });

    it('stores a new hash, revokes every session and clears the refresh token', async () => {
      adminModel.findById.mockReturnValue(query(activeDoc()));
      compareMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      hashMock.mockResolvedValue('new-hash');

      await service.changePassword(ADMIN_ID, dto as any);

      const update = adminModel.updateOne.mock.calls[0][1];
      expect(update.$set.passwordHash).toBe('new-hash');
      expect(update.$set.passwordChangedAt).toBeInstanceOf(Date);
      expect(update.$set.refreshTokenHash).toBeNull();
      expect(update.$inc.tokenVersion).toBe(1);
    });
  });
});
