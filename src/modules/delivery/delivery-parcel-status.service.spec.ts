import { HttpStatus } from '@nestjs/common';
import { DELIVERY_TIMELINE_MAX_ENTRIES } from '../../common/constants/delivery-status.const';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { ERROR_HTTP_STATUS } from '../../common/errors/error-statuses.const';
import { DeliveryConfigSchema } from './schemas/delivery-config.schema';
import {
  DeliveryParcelStatus,
  DeliveryParcelStatusSchema,
} from './schemas/delivery-parcel-status.schema';
import {
  DeliveryParcelStatusService,
  boundTimeline,
} from './delivery-parcel-status.service';

const STORE_ID = '6ac400e26b1b2c3d4e5f6a71';
const OTHER_STORE_ID = '6ac400e26b1b2c3d4e5f6a72';
const ORDER_ID = '6ac400e26b1b2c3d4e5f6a73';
const PARCEL_ID = 'parcel-1';

describe('DeliveryParcelStatus — data model (Phase 2)', () => {
  describe('the schema (§11.1)', () => {
    it('requires the tenancy key and the parcel identity', () => {
      const paths = DeliveryParcelStatusSchema.paths;
      expect(paths.storeId).toBeDefined();
      expect(paths.parcelId).toBeDefined();
      expect(paths.companyId).toBeDefined();
      expect(paths.orderId).toBeDefined();
    });

    it('stores the carrier state, the normalized status and the situation flags', () => {
      const paths = DeliveryParcelStatusSchema.paths;
      for (const field of [
        'deliveryStatus',
        'carrierStateId',
        'carrierStateName',
        'carrierStateDesc',
        'carrierStateRank',
        'carrierStateLocked',
        'carrierTransition',
        'situationFlags',
        'rawSituation',
        'deliveryType',
        'hubName',
        'hubCity',
        'hubDistrict',
        'lastCarrierStateAt',
      ]) {
        expect(paths[field]).toBeDefined();
      }
    });

    it('stores the timeline, the sync state and the polling bookkeeping', () => {
      const paths = DeliveryParcelStatusSchema.paths;
      for (const field of [
        'timeline',
        'timelineTruncated',
        'syncState',
        'lastPolledAt',
        'lastChangedAt',
        'lastError',
        'consecutiveFailures',
        'nextEligiblePollAt',
        'terminal',
      ]) {
        expect(paths[field]).toBeDefined();
      }
    });

    it('keeps the timeline entry id — the idempotency key (§13.1)', () => {
      const entrySchema = DeliveryParcelStatusSchema.paths['timeline'].schema as {
        paths: Record<string, { options?: { required?: boolean } }>;
      };
      expect(entrySchema.paths.providerEntryId).toBeDefined();
      expect(entrySchema.paths.providerEntryId.options?.required).toBe(true);
    });

    it('accepts every sync state of the roadmap', () => {
      const path = DeliveryParcelStatusSchema.paths.syncState as {
        options?: { enum?: string[]; default?: string };
      };
      expect(path.options?.enum).toEqual(
        expect.arrayContaining(['idle', 'synced', 'error', 'not_found', 'superseded']),
      );
      expect(path.options?.default).toBe('idle');
    });
  });

  describe('the indexes (§11.2)', () => {
    const indexes = DeliveryParcelStatusSchema.indexes();

    const has = (spec: Record<string, unknown>) =>
      indexes.some(([keys]) => JSON.stringify(keys) === JSON.stringify(spec));

    it('makes one record per (store, carrier, parcel) unique', () => {
      const found = indexes.find(
        ([keys]) =>
          JSON.stringify(keys) ===
          JSON.stringify({ storeId: 1, companyId: 1, parcelId: 1 }),
      );
      expect(found).toBeDefined();
      expect(found?.[1]).toMatchObject({ unique: true });
    });

    it('serves the order lookup, the work queue, the dashboard filter and the sweep', () => {
      expect(has({ storeId: 1, companyId: 1, orderId: 1 })).toBe(true);
      expect(has({ storeId: 1, companyId: 1, syncState: 1, nextEligiblePollAt: 1 })).toBe(true);
      expect(has({ storeId: 1, companyId: 1, deliveryStatus: 1 })).toBe(true);
      expect(has({ storeId: 1, companyId: 1, lastPolledAt: 1 })).toBe(true);
    });

    it('indexes the timeline entry id for the idempotency guard', () => {
      expect(has({ 'timeline.providerEntryId': 1 })).toBe(true);
    });

    it('prefixes every compound index with the tenancy key', () => {
      for (const [keys] of indexes) {
        if (typeof keys === 'string') continue;
        const first = Object.keys(keys)[0];
        if (first.startsWith('timeline.')) continue;
        if (Object.keys(keys).length < 2) continue;
        expect(first).toBe('storeId');
        expect(Object.keys(keys)[1]).toBe('companyId');
      }
    });
  });

  describe('the per-tenant override (§11.3)', () => {
    it('is stored on the delivery configuration, namespaced by provider', () => {
      const path = DeliveryConfigSchema.paths.statusStateOverrides as {
        instance?: string;
        options?: { default?: unknown };
      };
      expect(path).toBeDefined();
      expect(path.instance).toBe('Mixed');
    });

    it('accepts a carrier slug mapped to another catalogue slug', () => {
      const path = DeliveryConfigSchema.paths.statusStateOverrides as unknown as {
        instance: string;
      };
      expect(path.instance).toBe('Mixed');

      const overrides = { 'zr-express': { pret_a_expedier: 'en_preparation' } };
      expect(overrides['zr-express']['pret_a_expedier']).toBe('en_preparation');
    });
  });

  describe('the error codes (§14.1)', () => {
    it('maps the new codes to their status', () => {
      expect(ERROR_HTTP_STATUS[AppErrorCode.DELIVERY_STATUS_SYNC_FAILED]).toBe(
        HttpStatus.BAD_GATEWAY,
      );
      expect(ERROR_HTTP_STATUS[AppErrorCode.DELIVERY_STATUS_UNKNOWN_STATE]).toBe(HttpStatus.OK);
      expect(ERROR_HTTP_STATUS[AppErrorCode.DELIVERY_STATUS_ADVANCE_CONFLICT]).toBe(
        HttpStatus.CONFLICT,
      );
      expect(ERROR_HTTP_STATUS[AppErrorCode.DELIVERY_STATUS_NOT_FOUND]).toBe(HttpStatus.NOT_FOUND);
    });

    it('extends the existing DELIVERY_ block instead of a parallel namespace', () => {
      for (const code of [
        AppErrorCode.DELIVERY_STATUS_SYNC_FAILED,
        AppErrorCode.DELIVERY_STATUS_UNKNOWN_STATE,
        AppErrorCode.DELIVERY_STATUS_ADVANCE_CONFLICT,
        AppErrorCode.DELIVERY_STATUS_NOT_FOUND,
      ]) {
        expect(code.startsWith('DELIVERY_')).toBe(true);
      }
    });
  });
});

describe('DeliveryParcelStatusService — the write path (§13.1, §13.4)', () => {
  let service: DeliveryParcelStatusService;
  let findOneAndUpdate: jest.Mock;
  let updateOne: jest.Mock;
  let findOne: jest.Mock;

  beforeEach(() => {
    findOneAndUpdate = jest.fn().mockResolvedValue({ _id: 'doc-1' });
    updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    findOne = jest.fn().mockReturnValue({
      select: () => ({ lean: () => ({ exec: async () => ({ timeline: [] }) }) }),
    });

    const model = { findOneAndUpdate, updateOne, findOne } as never;
    service = new DeliveryParcelStatusService(model);
  });

  const input = (overrides: Record<string, unknown> = {}) => ({
    storeId: STORE_ID,
    companyId: 'zr-express',
    orderId: ORDER_ID,
    parcelId: PARCEL_ID,
    ...overrides,
  });

  describe('upsertStatus (§13.4)', () => {
    it('keys the upsert on (storeId, companyId, parcelId) and inserts the identity once', async () => {
      await service.upsertStatus(input());

      const [filter, update, options] = findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual({
        storeId: STORE_ID,
        companyId: 'zr-express',
        parcelId: PARCEL_ID,
      });
      expect(update.$set).toMatchObject({ companyId: 'zr-express' });
      expect(update.$setOnInsert).toMatchObject({
        storeId: STORE_ID,
        parcelId: PARCEL_ID,
        timeline: [],
      });
      expect(options).toMatchObject({ upsert: true, new: true });
    });

    it('never writes outside the caller’s store', async () => {
      await service.upsertStatus(input());

      const [filter, update] = findOneAndUpdate.mock.calls[0];
      expect(String(filter.storeId)).toBe(STORE_ID);
      expect(String(filter.storeId)).not.toBe(OTHER_STORE_ID);
      expect(update.$setOnInsert.storeId).toBe(STORE_ID);
    });

    it('stores the normalized status and the raw carrier state side by side', async () => {
      await service.upsertStatus(
        input({ deliveryStatus: 'in_transit', carrierStateName: 'en_transit' }),
      );

      const [, update] = findOneAndUpdate.mock.calls[0];
      expect(update.$set.deliveryStatus).toBe('in_transit');
      expect(update.$set.carrierStateName).toBe('en_transit');
    });

    it('retries a duplicate-key error as a plain update', async () => {
      findOneAndUpdate
        .mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }))
        .mockResolvedValueOnce({ _id: 'doc-1' });

      const result = await service.upsertStatus(input());

      expect(result).toEqual({ _id: 'doc-1' });
      expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
      const [filter, update, options] = findOneAndUpdate.mock.calls[1];
      expect(filter).toEqual({
        storeId: STORE_ID,
        companyId: 'zr-express',
        parcelId: PARCEL_ID,
      });
      expect(update.$setOnInsert).toBeUndefined();
      expect(options.upsert).toBeUndefined();
    });

    it('rethrows any other error', async () => {
      const boom = new Error('connection lost');
      findOneAndUpdate.mockRejectedValueOnce(boom);

      await expect(service.upsertStatus(input())).rejects.toThrow('connection lost');
      expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe('appendTimelineEntry (§13.1)', () => {
    const entry = {
      providerEntryId: 'entry-1',
      toState: 'en_transit',
      at: new Date('2026-10-21T10:00:00.000Z'),
      situations: [],
    };

    it('guards the push with the carrier entry id', async () => {
      await service.appendTimelineEntry(STORE_ID, PARCEL_ID, entry);

      const [filter, update] = findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual({
        storeId: STORE_ID,
        parcelId: PARCEL_ID,
        'timeline.providerEntryId': { $ne: 'entry-1' },
      });
      expect(update.$push.timeline).toEqual(entry);
    });

    it('reports that the entry was appended', async () => {
      findOneAndUpdate.mockResolvedValueOnce({ _id: 'doc-1' });
      await expect(service.appendTimelineEntry(STORE_ID, PARCEL_ID, entry)).resolves.toBe(true);
    });

    it('reports that the guard rejected a duplicate', async () => {
      findOneAndUpdate.mockResolvedValueOnce(null);
      await expect(service.appendTimelineEntry(STORE_ID, PARCEL_ID, entry)).resolves.toBe(false);
    });

    it('refuses an entry without an id', async () => {
      await expect(
        service.appendTimelineEntry(STORE_ID, PARCEL_ID, {
          providerEntryId: '',
          toState: 'x',
          at: new Date(),
          situations: [],
        }),
      ).resolves.toBe(false);
      expect(findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('the bounded window (§11.4)', () => {
    const makeEntries = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        providerEntryId: `entry-${index}`,
      }));

    it('keeps the first entry and the most recent ones', () => {
      const { entries, truncated } = boundTimeline(makeEntries(250));

      expect(truncated).toBe(true);
      expect(entries).toHaveLength(DELIVERY_TIMELINE_MAX_ENTRIES);
      expect(entries[0].providerEntryId).toBe('entry-0');
      expect(entries[entries.length - 1].providerEntryId).toBe('entry-249');
    });

    it('leaves a short timeline alone', () => {
      const { entries, truncated } = boundTimeline(makeEntries(10));

      expect(truncated).toBe(false);
      expect(entries).toHaveLength(10);
    });

    it('compacts only when the window overflows', async () => {
      findOne = jest.fn().mockReturnValue({
        select: () => ({
          lean: () => ({ exec: async () => ({ timeline: makeEntries(250) }) }),
        }),
      });
      const model = { findOneAndUpdate, updateOne, findOne } as never;
      service = new DeliveryParcelStatusService(model);

      await expect(service.compactTimeline(STORE_ID, PARCEL_ID)).resolves.toBe(true);

      const [filter, update] = updateOne.mock.calls[0];
      expect(filter).toEqual({ storeId: STORE_ID, parcelId: PARCEL_ID });
      expect(update.$set.timeline).toHaveLength(DELIVERY_TIMELINE_MAX_ENTRIES);
      expect(update.$set.timeline[0].providerEntryId).toBe('entry-0');
      expect(update.$set.timelineTruncated).toBe(true);
    });

    it('is a no-op when the timeline is within the bound', async () => {
      await expect(service.compactTimeline(STORE_ID, PARCEL_ID)).resolves.toBe(false);
      expect(updateOne).not.toHaveBeenCalled();
    });
  });
});
