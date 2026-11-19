import {
  isReservedStoreSubdomain,
  RESERVED_STORE_SUBDOMAINS,
} from '../../common/constants/store-subdomain.const';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { Types } from 'mongoose';
import { StoresController } from './stores.controller';
import { StoresService } from './stores.service';
import { StoreStatus } from './schemas/store-status.enum';
import { StoreSchema } from './schemas/store.schema';
import {
  isValidStoreSubdomain,
  normalizeSubdomain,
} from './store-subdomain.util';

describe('store subdomain utilities', () => {
  describe('normalizeSubdomain()', () => {
    it('lower-cases and trims', () => {
      expect(normalizeSubdomain('  Zainab  ')).toBe('zainab');
    });

    it('strips a trailing dot (FQDN form)', () => {
      expect(normalizeSubdomain('zainab.')).toBe('zainab');
    });

    it('strips diacritics via NFKD', () => {
      expect(normalizeSubdomain('Zäïnab')).toBe('zainab');
    });

    it('accepts interior and trailing digits and single hyphens', () => {
      expect(normalizeSubdomain('zainab-boutique-2')).toBe('zainab-boutique-2');
    });

    it.each([
      ['empty', ''],
      ['spaces', 'zainab boutique'],
      ['dot', 'zainab.imraaah.com'],
      ['underscore', 'zainab_boutique'],
      ['percent-encoding', 'zainab%20boutique'],
      ['leading hyphen', '-zainab'],
      ['trailing hyphen', 'zainab-'],
      ['consecutive hyphens', 'zainab--boutique'],
      ['punycode', 'xn--zainab'],
      ['all-numeric', '12345'],
      ['too short', 'ab'],
      ['too long', 'a'.repeat(31)],
    ])('rejects %s', (_label, value) => {
      expect(normalizeSubdomain(value)).toBeNull();
    });

    it.each([[undefined], [null], [123], [{}]])('rejects non-string input %p', (value) => {
      expect(normalizeSubdomain(value)).toBeNull();
    });
  });

  describe('reserved labels', () => {
    it('matches case-insensitively and exactly', () => {
      expect(isReservedStoreSubdomain('WWW')).toBe(true);
      expect(isReservedStoreSubdomain('www')).toBe(true);
      expect(isReservedStoreSubdomain('www2')).toBe(false);
      expect(isReservedStoreSubdomain('imraaah')).toBe(true);
    });

    it('treats an empty label as not reserved', () => {
      expect(isReservedStoreSubdomain('')).toBe(false);
    });

    it('exposes a non-empty reserved list', () => {
      expect(RESERVED_STORE_SUBDOMAINS.length).toBeGreaterThan(40);
    });

    it('flags a reserved label as not a valid store subdomain', () => {
      expect(isValidStoreSubdomain('www')).toBe(false);
      expect(isValidStoreSubdomain('zainab')).toBe(true);
    });
  });

  describe('schema index', () => {
    it('declares the partial unique index on subdomain', () => {
      const entry = StoreSchema.indexes().find(
        ([, options]) => options && options.name === 'store_subdomain_unique',
      );
      expect(entry).toBeDefined();
      const [fields, options] = entry!;
      expect(fields).toEqual({ subdomain: 1 });
      expect(options.unique).toBe(true);
      expect(options.partialFilterExpression).toEqual({
        subdomain: { $type: 'string' },
      });
    });

    it('does not put unique on the @Prop itself (legacy documents may omit it)', () => {
      const path = StoreSchema.path('subdomain') as unknown as { options?: { unique?: boolean } };
      expect(path.options?.unique).toBeUndefined();
    });
  });
});

/* ---------------------------------------------------------------------------------------
 * Phase 2: service + controller behaviour
 * ------------------------------------------------------------------------------------- */

const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'select', 'lean', 'populate']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

const STORE_ID = new Types.ObjectId();

const makeStoreModel = () => {
  const model: any = jest.fn();
  model.findOne = jest.fn().mockReturnValue(query(null));
  model.findById = jest.fn().mockReturnValue(query(null));
  model.exists = jest.fn().mockReturnValue(query(null));
  model.findByIdAndUpdate = jest.fn().mockReturnValue(query(null));
  model.prototype.save = jest.fn().mockImplementation(function (this: any) {
    this._id = this._id ?? STORE_ID;
    return Promise.resolve(this);
  });
  model.prototype.set = jest.fn().mockImplementation(function (this: any, key: string, value: unknown) {
    this[key] = value;
    return this;
  });
  return model;
};

const makeService = (storeModel: any) => {
  const categoryModel: any = {
    findOne: jest.fn().mockReturnValue(query(null)),
    findOneAndUpdate: jest.fn().mockReturnValue(query({ _id: new Types.ObjectId(), slug: 'general' })),
  };
  const subCategoryModel: any = {
    findOne: jest.fn().mockReturnValue(query(null)),
    findOneAndUpdate: jest.fn().mockReturnValue(query({ _id: new Types.ObjectId(), slug: 'general' })),
  };
  const storeMemberModel: any = { updateOne: jest.fn().mockReturnValue(query({})) };
  const productModel: any = { aggregate: jest.fn().mockReturnValue(query([])) };
  return new StoresService(
    storeModel,
    productModel,
    categoryModel,
    subCategoryModel,
    storeMemberModel,
    {} as any,
  );
};

const activeStore = (overrides: Record<string, unknown> = {}) => ({
  _id: STORE_ID,
  storeName: 'Zineb Store',
  storeSlug: 'zineb-store',
  status: StoreStatus.ACTIVE,
  ...overrides,
});

const duplicateKeyError = () => {
  const err: any = new Error('E11000 duplicate key');
  err.code = 11000;
  err.keyPattern = { subdomain: 1 };
  return err;
};

describe('StoresService - subdomains', () => {
  let storeModel: any;
  let service: StoresService;

  beforeEach(() => {
    storeModel = makeStoreModel();
    service = makeService(storeModel);
  });

  describe('findBySubdomain', () => {
    it('resolves an active store', async () => {
      const store = activeStore({ subdomain: 'zineb-store' });
      storeModel.findOne = jest.fn().mockReturnValue(query(store));

      await expect(service.findBySubdomain('zineb-store')).resolves.toBe(store);
      expect(storeModel.findOne).toHaveBeenCalledWith({ subdomain: 'zineb-store' });
    });

    it('maps a paused store to STORE_NOT_ACTIVE (403)', async () => {
      storeModel.findOne = jest
        .fn()
        .mockReturnValue(query(activeStore({ subdomain: 'paused', status: StoreStatus.PAUSED })));

      await expect(service.findBySubdomain('paused')).rejects.toMatchObject({
        errorCode: AppErrorCode.STORE_NOT_ACTIVE,
      });
    });

    it('returns STORE_NOT_FOUND for an unknown label', async () => {
      storeModel.findOne = jest.fn().mockReturnValue(query(null));

      await expect(service.findBySubdomain('missing')).rejects.toMatchObject({
        errorCode: AppErrorCode.STORE_NOT_FOUND,
      });
    });

    it('returns STORE_NOT_FOUND for an invalid label without querying', async () => {
      await expect(service.findBySubdomain('not_a_label')).rejects.toMatchObject({
        errorCode: AppErrorCode.STORE_NOT_FOUND,
      });
      expect(storeModel.findOne).not.toHaveBeenCalled();
    });
  });

  describe('isSubdomainAvailable', () => {
    it('reports a free label as available and normalizes it', async () => {
      storeModel.exists = jest.fn().mockReturnValue(query(null));

      await expect(service.isSubdomainAvailable('  Zainab  ')).resolves.toEqual({
        value: 'zainab',
        available: true,
      });
    });

    it('reports a taken label without leaking the owner', async () => {
      storeModel.exists = jest.fn().mockReturnValue(query({ _id: STORE_ID }));

      const result = await service.isSubdomainAvailable('zainab');

      expect(result).toEqual({ value: 'zainab', available: false, reason: 'taken' });
      expect(Object.keys(result).sort()).toEqual(['available', 'reason', 'value']);
      expect(JSON.stringify(result)).not.toContain(String(STORE_ID));
    });

    it('reports reserved and invalid labels', async () => {
      await expect(service.isSubdomainAvailable('www')).resolves.toEqual({
        value: 'www',
        available: false,
        reason: 'reserved',
      });
      await expect(service.isSubdomainAvailable('bad_label')).resolves.toEqual({
        value: 'bad_label',
        available: false,
        reason: 'invalid',
      });
    });
  });

  describe('suggestSubdomain', () => {
    it('is deterministic for a free seed', async () => {
      storeModel.exists = jest.fn().mockReturnValue(query(null));

      await expect(service.suggestSubdomain('zineb-store')).resolves.toBe('zineb-store');
      await expect(service.suggestSubdomain('zineb-store')).resolves.toBe('zineb-store');
    });

    it('falls back to `store` for a reserved seed', async () => {
      storeModel.exists = jest.fn().mockReturnValue(query(null));

      await expect(service.suggestSubdomain('www')).resolves.toBe('store');
    });

    it('suffixes a taken seed', async () => {
      storeModel.exists = jest
        .fn()
        .mockReturnValueOnce(query({ _id: STORE_ID }))
        .mockReturnValueOnce(query(null));

      await expect(service.suggestSubdomain('zineb-store')).resolves.toBe('zineb-store-2');
    });

    it('never returns a label longer than 30 chars', async () => {
      storeModel.exists = jest.fn().mockReturnValue(query(null));

      const value = await service.suggestSubdomain('a'.repeat(40));
      expect(value.length).toBeLessThanOrEqual(30);
      expect(normalizeSubdomain(value)).toBe(value);
    });
  });

  describe('updateSubdomain', () => {
    beforeEach(() => {
      storeModel.findById = jest
        .fn()
        .mockReturnValue(query(activeStore({ subdomain: 'old-name' })));
    });

    it('is idempotent when the value is unchanged', async () => {
      storeModel.findById = jest
        .fn()
        .mockReturnValue(query(activeStore({ subdomain: 'zineb-store' })));

      const result = await service.updateSubdomain(String(STORE_ID), ' ZINEB-STORE ');

      expect((result as any).subdomain).toBe('zineb-store');
      expect(storeModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('writes only the subdomain (no slug/images side effects)', async () => {
      storeModel.exists = jest.fn().mockReturnValue(query(null));
      storeModel.findByIdAndUpdate = jest
        .fn()
        .mockReturnValue(query(activeStore({ subdomain: 'zineb' })));

      await service.updateSubdomain(String(STORE_ID), 'zineb');

      expect(storeModel.findByIdAndUpdate).toHaveBeenCalledWith(
        String(STORE_ID),
        { $set: { subdomain: 'zineb' } },
        { returnDocument: 'after' },
      );
    });

    it('maps a pre-check conflict to STORE_SUBDOMAIN_TAKEN', async () => {
      storeModel.exists = jest.fn().mockReturnValue(query({ _id: new Types.ObjectId() }));

      await expect(service.updateSubdomain(String(STORE_ID), 'taken')).rejects.toMatchObject({
        errorCode: AppErrorCode.STORE_SUBDOMAIN_TAKEN,
      });
      expect(storeModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('maps a duplicate-key race to STORE_SUBDOMAIN_TAKEN', async () => {
      storeModel.exists = jest.fn().mockReturnValue(query(null));
      storeModel.findByIdAndUpdate = jest.fn().mockReturnValue({
        exec: jest.fn().mockRejectedValue(duplicateKeyError()),
      });

      await expect(service.updateSubdomain(String(STORE_ID), 'zineb')).rejects.toMatchObject({
        errorCode: AppErrorCode.STORE_SUBDOMAIN_TAKEN,
      });
    });

    it('rejects invalid and reserved values with the matching 400 code', async () => {
      await expect(service.updateSubdomain(String(STORE_ID), 'bad_label')).rejects.toMatchObject({
        errorCode: AppErrorCode.STORE_SUBDOMAIN_INVALID,
      });
      await expect(service.updateSubdomain(String(STORE_ID), 'www')).rejects.toMatchObject({
        errorCode: AppErrorCode.STORE_SUBDOMAIN_RESERVED,
      });
    });
  });

  describe('create', () => {
    const dto = () =>
      ({
        vendorEmail: 'vendor@test.com',
        storeName: 'Zineb Store',
        contactEmail: 'vendor@test.com',
        contactPhone: '0550000000',
      }) as any;

    beforeEach(() => {
      storeModel.findOne = jest.fn().mockReturnValue(query(null));
      storeModel.exists = jest.fn().mockReturnValue(query(null));
    });

    it('auto-assigns a subdomain derived from the slug', async () => {
      await service.create(dto());

      expect(storeModel.mock.calls[0][0].subdomain).toBe('zineb-store');
    });

    it('honours an explicit valid subdomain', async () => {
      await service.create({ ...dto(), subdomain: 'Zineb' });

      expect(storeModel.mock.calls[0][0].subdomain).toBe('zineb');
    });

    it('fails an explicit taken subdomain instead of silently renaming it', async () => {
      storeModel.exists = jest.fn().mockReturnValue(query({ _id: new Types.ObjectId() }));

      await expect(service.create({ ...dto(), subdomain: 'zineb' })).rejects.toMatchObject({
        errorCode: AppErrorCode.STORE_SUBDOMAIN_TAKEN,
      });
    });

    it('fails an explicit reserved subdomain', async () => {
      await expect(service.create({ ...dto(), subdomain: 'www' })).rejects.toMatchObject({
        errorCode: AppErrorCode.STORE_SUBDOMAIN_RESERVED,
      });
    });

    it('retries once on an auto-path duplicate-key race', async () => {
      storeModel.prototype.save = jest
        .fn()
        .mockRejectedValueOnce(duplicateKeyError())
        .mockImplementation(function (this: any) {
          this._id = this._id ?? STORE_ID;
          return Promise.resolve(this);
        });
      // First suggestion conflicts on the write, second (via the retry) is free.
      storeModel.exists = jest.fn().mockReturnValue(query(null));

      const saved = await service.create(dto());
      expect((saved as any).subdomain).toBe('zineb-store');
      expect(storeModel.prototype.save).toHaveBeenCalledTimes(2);
    });
  });

  describe('controller - session-scoped update', () => {
    it('ignores a smuggled storeId and uses the session store', async () => {
      const sessionStoreId = new Types.ObjectId();
      const serviceStub: any = {
        findByMemberIdOrThrow: jest.fn().mockResolvedValue({ _id: sessionStoreId }),
        updateSubdomain: jest.fn().mockResolvedValue({ subdomain: 'zineb' }),
      };
      const controller = new StoresController(serviceStub);

      await controller.updateMineSubdomain(
        { subdomain: 'zineb', storeId: String(new Types.ObjectId()) } as any,
        { user: { id: 'session-user' } } as any,
      );

      expect(serviceStub.findByMemberIdOrThrow).toHaveBeenCalledWith('session-user', {
        skipStatusCheck: true,
      });
      expect(serviceStub.updateSubdomain).toHaveBeenCalledWith(String(sessionStoreId), 'zineb');
      expect(serviceStub.updateSubdomain.mock.calls[0][0]).toBe(String(sessionStoreId));
    });
  });

  describe('controller - route ordering', () => {
    it('declares the static subdomain routes before GET :id', () => {
      const names = Object.getOwnPropertyNames(StoresController.prototype);
      const indexOf = (name: string) => names.indexOf(name);

      expect(indexOf('findBySubdomain')).toBeGreaterThan(-1);
      expect(indexOf('findBySubdomain')).toBeLessThan(indexOf('findOne'));
      expect(indexOf('checkSubdomainAvailability')).toBeLessThan(indexOf('findOne'));
    });
  });
});
