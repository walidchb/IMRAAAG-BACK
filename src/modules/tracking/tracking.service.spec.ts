import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TrackingService } from './tracking.service';
import { TrackingConfig } from './schemas/tracking-config.schema';
import { UpdateTrackingConfigDto } from './dto/tracking-config.dto';
import { Store, StoreDocument } from '../stores/schemas/store.schema';

/**
 * First spec for the tracking module (PLAN_PIXELS_MODULE.md Phase 7).
 *
 * These pin the behaviours that are expensive to get wrong and invisible when they break:
 * the `storeId`-keyed upsert (F5), the shape of the two public responses (F12/F16), the
 * enable-toggle kill switch, and the fact that the public endpoint cannot leak anything
 * (R3). A pixel that fires on the wrong store, or reports a value nobody sent, is the kind
 * of bug that shows up weeks later as a restricted ad account and no stack trace.
 */

const STORE_A = new Types.ObjectId();
const STORE_B = new Types.ObjectId();
const EMAIL_A = 'vendor-a@test.com';
const EMAIL_B = 'vendor-b@test.com';

const storeA = { _id: STORE_A, vendorEmail: EMAIL_A } as unknown as StoreDocument;
const storeB = { _id: STORE_B, vendorEmail: EMAIL_B } as unknown as StoreDocument;

/** Chainable mongoose query stub that records which builder args were used. */
const makeQuery = (result: unknown) => {
  const q: any = {};
  q.used = {} as Record<string, unknown>;
  for (const m of ['select', 'lean']) {
    q[m] = jest.fn((arg: unknown) => {
      q.used[m] = arg;
      return q;
    });
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

describe('TrackingService', () => {
  let service: TrackingService;
  let configModel: any;
  let storeModel: any;

  beforeEach(async () => {
    configModel = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };
    // Used only by the stale-row adoption repair in `updateConfig`. `exists()` returning
    // null means "that stale storeId no longer resolves to a live store", which is the
    // case adoption is for.
    storeModel = {
      exists: jest.fn().mockReturnValue(makeQuery(null)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrackingService,
        { provide: getModelToken(TrackingConfig.name), useValue: configModel },
        { provide: getModelToken(Store.name), useValue: storeModel },
      ],
    }).compile();

    service = module.get<TrackingService>(TrackingService);
  });

  describe('getConfig (vendor dashboard)', () => {
    it('returns an all-null view when the store has no config yet', async () => {
      configModel.findOne.mockReturnValue(makeQuery(null));

      const view = await service.getConfig(storeA);

      expect(view).toEqual({
        storeId: String(STORE_A),
        metaPixelId: null,
        metaPixelEnabled: false,
        tikTokPixelId: null,
        tikTokPixelEnabled: false,
      });
    });

    it('never leaks document internals or the vendorEmail shim (F12)', async () => {
      configModel.findOne.mockReturnValue(
        makeQuery({
          _id: new Types.ObjectId(),
          __v: 3,
          storeId: STORE_A,
          vendorEmail: EMAIL_A,
          metaPixelId: '123456789',
          metaPixelEnabled: true,
          tikTokPixelId: 'CLBBL3RC77U1F78OEU3G',
          tikTokPixelEnabled: false,
        }),
      );

      const view = await service.getConfig(storeA);

      expect(Object.keys(view).sort()).toEqual([
        'metaPixelEnabled',
        'metaPixelId',
        'storeId',
        'tikTokPixelEnabled',
        'tikTokPixelId',
      ]);
      expect(view).not.toHaveProperty('_id');
      expect(view).not.toHaveProperty('__v');
      expect(view).not.toHaveProperty('vendorEmail');
      expect(view).not.toHaveProperty('metaAccessToken');
      expect(view).not.toHaveProperty('tikTokAccessToken');
    });

    it('serialises a miss and a hit with the same keys, so the client needs no branch (F12)', async () => {
      configModel.findOne.mockReturnValueOnce(makeQuery(null));
      const miss = await service.getConfig(storeA);

      configModel.findOne.mockReturnValueOnce(
        makeQuery({ storeId: STORE_A, metaPixelId: '1', metaPixelEnabled: true }),
      );
      const hit = await service.getConfig(storeA);

      expect(Object.keys(miss).sort()).toEqual(Object.keys(hit).sort());
    });

    it('queries by storeId and never by vendorEmail', async () => {
      configModel.findOne.mockReturnValue(makeQuery(null));

      await service.getConfig(storeA);

      expect(configModel.findOne).toHaveBeenCalledWith({ storeId: STORE_A });
    });

    it('coerces a missing enabled flag to false rather than undefined', async () => {
      configModel.findOne.mockReturnValue(
        makeQuery({ storeId: STORE_A, metaPixelId: '12345' }),
      );

      const view = await service.getConfig(storeA);

      expect(view.metaPixelEnabled).toBe(false);
      expect(view.tikTokPixelEnabled).toBe(false);
    });
  });

  describe('updateConfig (F5 regression: the upsert must key on storeId)', () => {
    it('updates the existing document instead of inserting when one exists', async () => {
      configModel.findOne.mockReturnValue(makeQuery({ storeId: STORE_A }));
      configModel.findOneAndUpdate.mockReturnValue(
        makeQuery({ storeId: STORE_A, metaPixelId: '222222', metaPixelEnabled: true }),
      );

      const view = await service.updateConfig(storeA, {
        metaPixelId: '222222',
        metaPixelEnabled: true,
      });

      const [filter, update, options] = configModel.findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual({ storeId: STORE_A });
      expect(options.upsert).toBeUndefined();
      expect(view.metaPixelId).toBe('222222');
      expect(update.$set.storeId).toBe(STORE_A);
    });

    it('upserts when the store has no config yet', async () => {
      configModel.findOne.mockReturnValue(makeQuery(null));
      configModel.findOneAndUpdate.mockReturnValue(
        makeQuery({ storeId: STORE_A, metaPixelId: '333333' }),
      );

      await service.updateConfig(storeA, { metaPixelId: '333333' });

      const [, , options] = configModel.findOneAndUpdate.mock.calls[0];
      expect(options.upsert).toBe(true);
      expect(options.setDefaultsOnInsert).toBe(true);
    });

    /**
     * The original bug: the filter was `{ vendorEmail }` while both `vendorEmail_1` and
     * `storeId_1` are unique indexes, so a vendor changing their email matched nothing and
     * tried to insert a duplicate `storeId` — a hard E11000 that permanently blocked saving.
     */
    it('still resolves the same document after the vendor changes their email', async () => {
      configModel.findOne.mockReturnValue(makeQuery({ storeId: STORE_A }));
      configModel.findOneAndUpdate.mockReturnValue(
        makeQuery({ storeId: STORE_A, metaPixelId: '444444' }),
      );

      const renamed = { _id: STORE_A, vendorEmail: 'renamed@test.com' } as unknown as StoreDocument;
      await service.updateConfig(renamed, { metaPixelId: '444444' });

      // Selection and update are both keyed on storeId, so the stale email is irrelevant.
      expect(configModel.findOne).toHaveBeenCalledWith({ storeId: STORE_A });
      const [filter] = configModel.findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual({ storeId: STORE_A });
      expect(filter).not.toHaveProperty('vendorEmail');
    });

    it('still writes vendorEmail as a migration shim without using it to select', async () => {
      configModel.findOne.mockReturnValue(makeQuery({ storeId: STORE_A }));
      configModel.findOneAndUpdate.mockReturnValue(makeQuery({ storeId: STORE_A }));

      await service.updateConfig(storeA, { metaPixelId: '555555' });

      const [, update] = configModel.findOneAndUpdate.mock.calls[0];
      expect(update.$set.vendorEmail).toBe(EMAIL_A);
    });

    it('cannot write one store config onto another store document', async () => {
      configModel.findOne.mockReturnValue(makeQuery({ storeId: STORE_A }));
      configModel.findOneAndUpdate.mockReturnValue(makeQuery({ storeId: STORE_A }));

      await service.updateConfig(storeA, { metaPixelId: '666666' });

      const [filter] = configModel.findOneAndUpdate.mock.calls[0];
      expect(filter).not.toHaveProperty('storeId', STORE_B);
    });
  });

  /**
   * A vendor could not save their Meta Pixel ID at all: their config row pointed at a
   * `storeId` that no longer resolved to any store, so the storeId lookup missed, the
   * upsert tried to INSERT, and the insert collided with that same stale row on the
   * legacy `vendorEmail_1` unique index - E11000, unrecoverable from the UI.
   *
   * These pin the repair: adopt the stale row and re-point it, preserving the vendor's
   * already-saved pixel IDs.
   */
  describe('updateConfig - stale storeId repair (the E11000 that blocked saving)', () => {
    const STALE_STORE_ID = new Types.ObjectId();

    const staleRow = (overrides: Record<string, unknown> = {}) => {
      const doc: any = {
        _id: new Types.ObjectId(),
        storeId: STALE_STORE_ID,
        vendorEmail: EMAIL_A,
        metaPixelId: '345345345',
        metaPixelEnabled: false,
        save: jest.fn().mockResolvedValue(undefined),
        ...overrides,
      };
      return doc;
    };

    it('adopts a row whose storeId no longer resolves, keeping the saved pixel ID', async () => {
      const row = staleRow();
      // 1st findOne: storeId lookup misses. 2nd: legacy vendorEmail lookup hits.
      configModel.findOne
        .mockReturnValueOnce(makeQuery(null))
        .mockReturnValueOnce(makeQuery(row));
      storeModel.exists.mockReturnValue(makeQuery(null)); // stale store is gone
      configModel.findOneAndUpdate.mockReturnValue(
        makeQuery({ storeId: STORE_A, metaPixelId: '345345345' }),
      );

      const view = await service.updateConfig(storeA, { metaPixelId: '999999' });

      expect(row.save).toHaveBeenCalledTimes(1);
      expect(row.storeId).toBe(STORE_A);
      // Repaired, not inserted: the update is keyed on the now-correct storeId.
      const [filter] = configModel.findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual({ storeId: STORE_A });
      expect(view.storeId).toBe(String(STORE_A));
    });

    it('refuses to adopt a row that still belongs to a live store (no cross-vendor takeover)', async () => {
      const row = staleRow();
      configModel.findOne
        .mockReturnValueOnce(makeQuery(null))
        .mockReturnValueOnce(makeQuery(row));
      storeModel.exists.mockReturnValue(makeQuery({ _id: STALE_STORE_ID })); // still live
      configModel.findOneAndUpdate.mockReturnValue(makeQuery({ storeId: STORE_A }));

      await service.updateConfig(storeA, { metaPixelId: '999999' });

      expect(row.save).not.toHaveBeenCalled();
      expect(row.storeId).toBe(STALE_STORE_ID);
    });

    it('does not consult the legacy path at all when storeId already matches', async () => {
      configModel.findOne.mockReturnValue(makeQuery({ storeId: STORE_A }));
      configModel.findOneAndUpdate.mockReturnValue(makeQuery({ storeId: STORE_A }));

      await service.updateConfig(storeA, { metaPixelId: '111111' });

      // Exactly one lookup - the canonical one. The repair must not become the norm.
      expect(configModel.findOne).toHaveBeenCalledTimes(1);
      expect(storeModel.exists).not.toHaveBeenCalled();
    });

    it('only adopts a row carrying this vendor\'s own email', async () => {
      configModel.findOne.mockReturnValueOnce(makeQuery(null)).mockReturnValueOnce(makeQuery(null));
      configModel.findOneAndUpdate.mockReturnValue(makeQuery({ storeId: STORE_A }));

      await service.updateConfig(storeA, { metaPixelId: '222222' });

      // Nothing to adopt, so it upserts instead.
      const [, , options] = configModel.findOneAndUpdate.mock.calls[0];
      expect(options.upsert).toBe(true);
      expect(storeModel.exists).not.toHaveBeenCalled();
    });

    it('skips adoption when the store has no vendorEmail to match on', async () => {
      configModel.findOne.mockReturnValueOnce(makeQuery(null));
      configModel.findOneAndUpdate.mockReturnValue(makeQuery({ storeId: STORE_A }));
      const noEmail = { _id: STORE_A, vendorEmail: '' } as unknown as StoreDocument;

      await service.updateConfig(noEmail, { metaPixelId: '333333' });

      expect(configModel.findOne).toHaveBeenCalledTimes(1);
      const [, , options] = configModel.findOneAndUpdate.mock.calls[0];
      expect(options.upsert).toBe(true);
    });
  });

  describe('getPublicConfig (storefront, unauthenticated)', () => {
    const present = (over: Record<string, unknown> = {}) => ({
      storeId: STORE_A,
      metaPixelId: '123456789',
      metaPixelEnabled: true,
      tikTokPixelId: 'CLBBL3RC77U1F78OEU3G',
      tikTokPixelEnabled: true,
      ...over,
    });

    it('treats a missing config as all-null instead of an error', async () => {
      configModel.findOne.mockReturnValue(makeQuery(null));

      await expect(service.getPublicConfig(String(STORE_A))).resolves.toEqual({
        storeId: String(STORE_A),
        metaPixelId: null,
        tikTokPixelId: null,
      });
    });

    it('returns both IDs when both are enabled', async () => {
      configModel.findOne.mockReturnValue(makeQuery(present()));

      const cfg = await service.getPublicConfig(String(STORE_A));

      expect(cfg.metaPixelId).toBe('123456789');
      expect(cfg.tikTokPixelId).toBe('CLBBL3RC77U1F78OEU3G');
    });

    /**
     * The toggle is an independent kill switch. A saved ID with tracking off must read as
     * `null`, otherwise there is no way for a vendor to stop being measured.
     */
    it('withholds an ID whose enable toggle is off', async () => {
      configModel.findOne.mockReturnValue(
        makeQuery(present({ metaPixelEnabled: false, tikTokPixelEnabled: false })),
      );

      const cfg = await service.getPublicConfig(String(STORE_A));

      expect(cfg.metaPixelId).toBeNull();
      expect(cfg.tikTokPixelId).toBeNull();
    });

    it('honours the toggles independently', async () => {
      configModel.findOne.mockReturnValue(
        makeQuery(present({ metaPixelEnabled: true, tikTokPixelEnabled: false })),
      );

      const cfg = await service.getPublicConfig(String(STORE_A));

      expect(cfg.metaPixelId).toBe('123456789');
      expect(cfg.tikTokPixelId).toBeNull();
    });

    it('withholds an ID that is enabled but empty', async () => {
      configModel.findOne.mockReturnValue(
        makeQuery(present({ metaPixelId: null, tikTokPixelId: '' })),
      );

      const cfg = await service.getPublicConfig(String(STORE_A));

      expect(cfg.metaPixelId).toBeNull();
      expect(cfg.tikTokPixelId).toBeNull();
    });

    it('exposes exactly three fields and no token or seller data (R3)', async () => {
      configModel.findOne.mockReturnValue(
        makeQuery({
          ...present(),
          _id: new Types.ObjectId(),
          __v: 1,
          vendorEmail: EMAIL_A,
          metaAccessToken: 'EAAB-secret',
          tikTokAccessToken: 'secret-token',
        }),
      );

      const cfg = await service.getPublicConfig(String(STORE_A));

      expect(Object.keys(cfg).sort()).toEqual(['metaPixelId', 'storeId', 'tikTokPixelId']);
      expect(JSON.stringify(cfg)).not.toContain('secret');
      expect(JSON.stringify(cfg)).not.toContain(EMAIL_A);
    });

    it('projects only the pixel fields, so no other column can be served by accident', async () => {
      configModel.findOne.mockReturnValue(makeQuery(present()));

      await service.getPublicConfig(String(STORE_A));

      const q = configModel.findOne.mock.results[0].value;
      expect(q.used.select).toBe('metaPixelId metaPixelEnabled tikTokPixelId tikTokPixelEnabled');
    });

    /**
     * D1 / R2. The lookup is by `storeId` alone. If a `vendorEmail` fallback were ever
     * reintroduced here, a storefront could resolve a different store's pixel — the
     * invalid-traffic case that gets a vendor's ad account restricted.
     */
    it('looks up by storeId as an ObjectId with no seller fallback (D1)', async () => {
      configModel.findOne.mockReturnValue(makeQuery(present()));

      await service.getPublicConfig(String(STORE_A));

      const [filter] = configModel.findOne.mock.calls[0];
      expect(filter).toEqual({ storeId: STORE_A });
      expect(filter).not.toHaveProperty('vendorEmail');
      expect(filter).not.toHaveProperty('$or');
    });

    it('returns the requested storeId back, never a different store (cross-store isolation)', async () => {
      configModel.findOne.mockReturnValue(makeQuery(present()));

      const cfg = await service.getPublicConfig(String(STORE_B));

      expect(cfg.storeId).toBe(String(STORE_B));
      const [filter] = configModel.findOne.mock.calls[0];
      expect(filter).toEqual({ storeId: STORE_B });
    });
  });

  describe('testConfig', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('reports a missing Meta ID without calling out to Meta', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch');
      configModel.findOne.mockReturnValue(makeQuery(null));

      const result = await service.testConfig(storeA, {});

      expect(result.meta.ok).toBe(false);
      expect(result.meta.message).toBe('No Meta Pixel ID configured.');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('reports TikTok as saved-but-unverified rather than inventing a failure', async () => {
      configModel.findOne.mockReturnValue(makeQuery(null));

      const result = await service.testConfig(storeA, { tikTokPixelId: 'CLBBL3RC77U1F78OEU3G' });

      expect(result.tikTok.ok).toBe(true);
      expect(result.tikTok.message).toMatch(/no pixel-lookup API/i);
    });

    it('falls back to the saved config when the DTO omits the IDs', async () => {
      configModel.findOne.mockReturnValue(
        makeQuery({ storeId: STORE_A, metaPixelId: '987654321', metaPixelEnabled: true }),
      );
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({ name: 'My Pixel' }) } as any);

      const result = await service.testConfig(storeA, {});

      expect(result.meta.ok).toBe(true);
      expect(result.meta.name).toBe('My Pixel');
    });

    it('prefers the unsaved ID the vendor just typed over the saved one', async () => {
      configModel.findOne.mockReturnValue(
        makeQuery({ storeId: STORE_A, metaPixelId: '111111111', metaPixelEnabled: true }),
      );
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({ name: 'Typed' }) } as any);

      await service.testConfig(storeA, { metaPixelId: '222222222' });

      expect(fetchSpy.mock.calls[0][0]).toContain('/222222222');
    });

    it('surfaces a Meta error message instead of a generic failure', async () => {
      configModel.findOne.mockReturnValue(makeQuery(null));
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'Unsupported get request.' } }),
      } as any);

      const result = await service.testConfig(storeA, { metaPixelId: '123456789' });

      expect(result.meta.ok).toBe(false);
      expect(result.meta.message).toBe('Unsupported get request.');
    });

    it('reports a timeout distinctly from an unreachable network', async () => {
      configModel.findOne.mockReturnValue(makeQuery(null));
      jest.spyOn(global, 'fetch').mockRejectedValue(
        Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
      );

      const result = await service.testConfig(storeA, { metaPixelId: '123456789' });

      expect(result.meta.message).toMatch(/within 8s/);
    });

    it('never throws out of testConfig when Meta is unreachable', async () => {
      configModel.findOne.mockReturnValue(makeQuery(null));
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

      await expect(service.testConfig(storeA, { metaPixelId: '123456789' })).resolves.toBeDefined();
    });
  });
});

describe('UpdateTrackingConfigDto', () => {
  // Mirrors the global ValidationPipe: whitelist strips unknown props and
  // forbidNonWhitelisted then errors on them.
  const check = async (payload: Record<string, unknown>) => {
    const dto = plainToInstance(UpdateTrackingConfigDto, payload);
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    return { dto, messages: errors.flatMap((e) => Object.values(e.constraints ?? {})) };
  };

  const accepts = async (payload: Record<string, unknown>) => (await check(payload)).messages.length === 0;

  describe('metaPixelId', () => {
    it.each(['12345', '123456789012345', '1'.repeat(32)])('accepts a valid numeric ID: %s', async (id) => {
      expect(await accepts({ metaPixelId: id })).toBe(true);
    });

    it('rejects an ID shorter than 5 digits', async () => {
      expect(await accepts({ metaPixelId: '1234' })).toBe(false);
    });

    it('rejects an ID longer than 32 digits', async () => {
      expect(await accepts({ metaPixelId: '1'.repeat(33) })).toBe(false);
    });

    it('rejects a non-numeric ID', async () => {
      expect(await accepts({ metaPixelId: 'abcde' })).toBe(false);
    });

    it('trims surrounding whitespace before validating', async () => {
      const { dto } = await check({ metaPixelId: '  123456789  ' });
      expect(dto.metaPixelId).toBe('123456789');
    });

    it('rejects an ID that is only whitespace', async () => {
      expect(await accepts({ metaPixelId: '     ' })).toBe(false);
    });

    it('allows null, which is how a vendor clears the ID', async () => {
      expect(await accepts({ metaPixelId: null })).toBe(true);
    });
  });

  describe('tikTokPixelId', () => {
    it.each(['abcde', 'CLBBL3RC77U1F78OEU3G', 'A_b-c', 'x'.repeat(64)])('accepts %s', async (id) => {
      expect(await accepts({ tikTokPixelId: id })).toBe(true);
    });

    it('rejects an ID shorter than 5 characters', async () => {
      expect(await accepts({ tikTokPixelId: 'abcd' })).toBe(false);
    });

    it('rejects an ID longer than 64 characters', async () => {
      expect(await accepts({ tikTokPixelId: 'x'.repeat(65) })).toBe(false);
    });

    it('rejects characters outside the allowed set', async () => {
      expect(await accepts({ tikTokPixelId: 'abcde$fgh' })).toBe(false);
    });

    it('trims surrounding whitespace', async () => {
      const { dto } = await check({ tikTokPixelId: '  CLBBL3RC77U1F78OEU3G  ' });
      expect(dto.tikTokPixelId).toBe('CLBBL3RC77U1F78OEU3G');
    });

    it('allows null, which is how a vendor clears the ID', async () => {
      expect(await accepts({ tikTokPixelId: null })).toBe(true);
    });
  });

  describe('enable flags', () => {
    it('accepts booleans', async () => {
      expect(await accepts({ metaPixelEnabled: true, tikTokPixelEnabled: false })).toBe(true);
    });

    it('rejects a non-boolean enable flag', async () => {
      expect(await accepts({ metaPixelEnabled: 'yes' })).toBe(false);
    });
  });

  describe('access tokens (Phase 2 removal)', () => {
    /**
     * The global pipe runs with `forbidNonWhitelisted: true`, so the removed token fields
     * are not merely undocumented — posting one is now a hard 400. This is the assertion
     * that keeps the browser-pixel-only decision (D2) enforced at the API boundary.
     */
    it.each(['metaAccessToken', 'tikTokAccessToken'])('rejects a posted %s', async (field) => {
      expect(await accepts({ [field]: 'EAAB-something-secret' })).toBe(false);
    });

    it('rejects an arbitrary unknown field', async () => {
      expect(await accepts({ someNewField: 'x' })).toBe(false);
    });
  });
});
