jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
  hashSync: jest.fn(() => 'dummy-hash'),
}));

import * as bcrypt from 'bcrypt';
import { AdminAccountsService } from './admin-accounts.service';
import { AdminStatus } from '../../../common/constants/admin-status.enum';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';

const ADMIN_ID = '507f1f77bcf86cd799439011';
const TARGET_ID = '607f1f77bcf86cd799439012';
const hashMock = bcrypt.hash as jest.Mock;

function execQuery(result: unknown) {
  const q: any = { exec: async () => result };
  return q;
}

function listQuery(result: unknown) {
  const q: any = {
    sort: () => q,
    skip: () => q,
    limit: () => q,
    lean: () => q,
    exec: async () => result,
  };
  return q;
}

function doc(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    _id: TARGET_ID,
    firstName: 'Amina',
    lastName: 'Bensalem',
    email: 'amina@imraaah.com',
    status: AdminStatus.ACTIVE,
    tokenVersion: 0,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    passwordChangedAt: null,
    disabledAt: null,
    ...overrides,
  };
}

describe('AdminAccountsService', () => {
  let adminModel: any;
  let service: AdminAccountsService;

  beforeEach(() => {
    jest.clearAllMocks();
    adminModel = {
      exists: jest.fn(),
      create: jest.fn(),
      find: jest.fn(),
      countDocuments: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findByIdAndDelete: jest.fn(),
    };
    const config: any = { get: (key: string) => (key === 'adminAuth.bcryptRounds' ? 12 : undefined) };
    service = new AdminAccountsService(adminModel, config);
  });

  function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
    return promise.then(
      () => undefined,
      (error) => (error as AppException).errorCode,
    );
  }

  const createDto = {
    firstName: ' Amina ',
    lastName: ' Bensalem ',
    email: 'AMINA@imraaah.com',
    password: 'brandnew123',
  } as any;

  describe('create', () => {
    it('rejects a duplicate admin email', async () => {
      adminModel.exists.mockResolvedValue({ _id: 'x' });
      expect(await codeOf(service.create(createDto, ADMIN_ID))).toBe(
        AppErrorCode.ADMIN_EMAIL_ALREADY_EXISTS,
      );
    });

    it('allows an email that also belongs to a seller account (separate identities)', async () => {
      adminModel.exists.mockResolvedValue(null);
      hashMock.mockResolvedValue('hashed');
      adminModel.create.mockImplementation(async (payload: any) => ({
        ...doc(),
        ...payload,
      }));

      await service.create(
        { ...createDto, email: 'walidchebbab2001@gmail.com' } as any,
        ADMIN_ID,
      );

      expect(adminModel.create).toHaveBeenCalledTimes(1);
      expect(adminModel.create.mock.calls[0][0].email).toBe('walidchebbab2001@gmail.com');
    });

    it('normalizes the email and never returns a secret', async () => {
      adminModel.exists.mockResolvedValue(null);
      hashMock.mockResolvedValue('hashed');
      adminModel.create.mockImplementation(async (payload: any) => ({
        ...doc(),
        ...payload,
        passwordHash: payload.passwordHash,
      }));

      const result = await service.create(createDto, ADMIN_ID);

      const payload = adminModel.create.mock.calls[0][0];
      expect(payload.email).toBe('amina@imraaah.com');
      expect(payload.firstName).toBe('Amina');
      expect(payload.lastName).toBe('Bensalem');
      expect(payload.passwordHash).toBe('hashed');
      expect(String(payload.createdBy)).toBe(ADMIN_ID);
      expect((result as any).passwordHash).toBeUndefined();
      expect((result as any).refreshTokenHash).toBeUndefined();
    });

    it('maps a unique-index race to the friendly duplicate error', async () => {
      adminModel.exists.mockResolvedValue(null);
      hashMock.mockResolvedValue('hashed');
      adminModel.create.mockRejectedValue({ code: 11000 });
      expect(await codeOf(service.create(createDto, ADMIN_ID))).toBe(
        AppErrorCode.ADMIN_EMAIL_ALREADY_EXISTS,
      );
    });

    it('never touches the creator session or issues a token for the new account', async () => {
      adminModel.exists.mockResolvedValue(null);
      hashMock.mockResolvedValue('hashed');
      adminModel.create.mockImplementation(async (payload: any) => ({
        ...doc(),
        ...payload,
      }));

      await service.create(createDto, ADMIN_ID);

      expect(adminModel.create).toHaveBeenCalledTimes(1);
      const payload = adminModel.create.mock.calls[0][0];
      expect(payload).not.toHaveProperty('refreshTokenHash');
      expect(payload).not.toHaveProperty('refreshTokenExpiresAt');
      expect(payload).not.toHaveProperty('tokenVersion');
      expect(adminModel.findByIdAndUpdate).not.toHaveBeenCalled();
      expect(adminModel.findByIdAndDelete).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('applies an escaped search regex, status filter and pagination', async () => {
      adminModel.find.mockReturnValue(listQuery([doc()]));
      adminModel.countDocuments.mockResolvedValue(1);

      const result = await service.list({
        page: 1,
        limit: 20,
        search: 'a+b (test)',
        status: AdminStatus.ACTIVE,
        sort: 'name',
        order: 'asc',
      } as any);

      const filter = adminModel.find.mock.calls[0][0];
      expect(filter.status).toBe(AdminStatus.ACTIVE);
      expect(filter.$or[0].firstName.test('a+b (test)')).toBe(true);
      expect(result).toMatchObject({ total: 1, page: 1, limit: 20, totalPages: 1 });
      expect(result.items).toHaveLength(1);
    });
  });

  describe('get', () => {
    it('rejects an unknown admin id', async () => {
      adminModel.findById.mockReturnValue(execQuery(null));
      expect(await codeOf(service.get(TARGET_ID))).toBe(AppErrorCode.ADMIN_NOT_FOUND);
    });
  });

  describe('remove', () => {
    it('rejects an unknown admin id', async () => {
      adminModel.findById.mockReturnValue(execQuery(null));
      expect(await codeOf(service.remove(TARGET_ID, ADMIN_ID))).toBe(
        AppErrorCode.ADMIN_NOT_FOUND,
      );
      expect(adminModel.findByIdAndDelete).not.toHaveBeenCalled();
    });

    it('refuses to delete yourself', async () => {
      adminModel.findById.mockReturnValue(execQuery(doc({ _id: ADMIN_ID })));
      expect(await codeOf(service.remove(ADMIN_ID, ADMIN_ID))).toBe(
        AppErrorCode.ADMIN_CANNOT_DELETE_SELF,
      );
      expect(adminModel.findByIdAndDelete).not.toHaveBeenCalled();
    });

    it('refuses to delete the last active admin', async () => {
      adminModel.findById.mockReturnValue(execQuery(doc()));
      adminModel.countDocuments.mockResolvedValue(0);
      expect(await codeOf(service.remove(TARGET_ID, ADMIN_ID))).toBe(
        AppErrorCode.ADMIN_LAST_ACTIVE,
      );
      expect(adminModel.findByIdAndDelete).not.toHaveBeenCalled();
    });

    it('deletes another active admin when at least one active admin remains', async () => {
      adminModel.findById.mockReturnValue(execQuery(doc()));
      adminModel.countDocuments.mockResolvedValue(1);
      adminModel.findByIdAndDelete.mockReturnValue(execQuery(doc()));

      await service.remove(TARGET_ID, ADMIN_ID);

      expect(adminModel.findByIdAndDelete).toHaveBeenCalledWith(TARGET_ID);
    });

    it('deletes a disabled admin without an active-count check', async () => {
      adminModel.findById.mockReturnValue(execQuery(doc({ status: AdminStatus.DISABLED })));
      adminModel.findByIdAndDelete.mockReturnValue(execQuery(doc()));

      await service.remove(TARGET_ID, ADMIN_ID);

      expect(adminModel.countDocuments).not.toHaveBeenCalled();
      expect(adminModel.findByIdAndDelete).toHaveBeenCalledWith(TARGET_ID);
    });
  });

  describe('setStatus', () => {
    it('is idempotent when the status already matches', async () => {
      adminModel.findById.mockReturnValue(execQuery(doc()));
      const result = await service.setStatus(TARGET_ID, AdminStatus.ACTIVE, ADMIN_ID);
      expect(result.status).toBe(AdminStatus.ACTIVE);
      expect(adminModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('refuses to disable yourself', async () => {
      adminModel.findById.mockReturnValue(execQuery(doc({ _id: ADMIN_ID })));
      expect(
        await codeOf(service.setStatus(ADMIN_ID, AdminStatus.DISABLED, ADMIN_ID)),
      ).toBe(AppErrorCode.ADMIN_CANNOT_DISABLE_SELF);
    });

    it('refuses to disable the last active admin', async () => {
      adminModel.findById.mockReturnValue(execQuery(doc()));
      adminModel.countDocuments.mockResolvedValue(0);
      expect(
        await codeOf(service.setStatus(TARGET_ID, AdminStatus.DISABLED, ADMIN_ID)),
      ).toBe(AppErrorCode.ADMIN_LAST_ACTIVE);
      expect(adminModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('disable clears the refresh token and bumps the token version', async () => {
      adminModel.findById.mockReturnValue(execQuery(doc()));
      adminModel.countDocuments.mockResolvedValue(1);
      adminModel.findByIdAndUpdate.mockReturnValue(execQuery(doc({ status: AdminStatus.DISABLED })));

      const result = await service.setStatus(TARGET_ID, AdminStatus.DISABLED, ADMIN_ID);

      const update = adminModel.findByIdAndUpdate.mock.calls[0][1];
      expect(update.$set.refreshTokenHash).toBeNull();
      expect(update.$set.disabledAt).toBeInstanceOf(Date);
      expect(update.$inc.tokenVersion).toBe(1);
      expect(result.status).toBe(AdminStatus.DISABLED);
    });

    it('re-enable clears the disable metadata and does not restore sessions', async () => {
      adminModel.findById.mockReturnValue(execQuery(doc({ status: AdminStatus.DISABLED })));
      adminModel.findByIdAndUpdate.mockReturnValue(execQuery(doc()));

      await service.setStatus(TARGET_ID, AdminStatus.ACTIVE, ADMIN_ID);

      const update = adminModel.findByIdAndUpdate.mock.calls[0][1];
      expect(update.$set).toEqual({
        status: AdminStatus.ACTIVE,
        disabledAt: null,
        disabledBy: null,
      });
      expect(update.$inc).toBeUndefined();
    });
  });
});
