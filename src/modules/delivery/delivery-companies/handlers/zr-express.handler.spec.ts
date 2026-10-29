import { Logger } from '@nestjs/common';
import { AppException } from '../../../../common/errors/app-exception';
import { AppErrorCode } from '../../../../common/errors/error-codes.enum';
import { fetchWithRetry } from '../../../../common/fetch-with-retry';
import { ZrExpressHandler } from './zr-express.handler';

jest.mock('../../../../common/fetch-with-retry', () => ({
  fetchWithRetry: jest.fn(),
}));

const fetchWithRetryMock = fetchWithRetry as unknown as jest.Mock;

const STORE_ID = '6ac400e26b1b2c3d4e5f6a71';
const OTHER_STORE_ID = '6ac400e26b1b2c3d4e5f6a72';
const VENDOR_EMAIL = 'vendor@imraaah.test';
const API_KEY = 'zr-secret-api-key';
const TENANT_ID = 'zr-tenant-1';

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

describe('ZrExpressHandler â€” status sync (Phase 1)', () => {
  let handler: ZrExpressHandler;
  let findOne: jest.Mock;

  const configDoc = (overrides: Record<string, unknown> = {}) => ({
    _id: 'cfg-1',
    storeId: STORE_ID,
    vendorEmail: VENDOR_EMAIL,
    companies: {
      'zr-express': {
        status: 'enabled',
        credentials: { apiKey: API_KEY, tenantId: TENANT_ID },
      },
    },
    ...overrides,
  });

  const build = (resolver: unknown) => {
    const resolve = resolver as (filter: Record<string, unknown>) => unknown;
    findOne = jest.fn().mockImplementation((filter: Record<string, unknown>) => ({
      lean: () => ({ exec: async () => resolve(filter) }),
    }));

    const configModel = { findOne } as never;
    const wilayaModel = {} as never;
    const communeModel = {} as never;
    const configService = { get: jest.fn().mockReturnValue('') } as never;

    return new ZrExpressHandler(configModel, wilayaModel, communeModel, configService);
  };

  /** The configuration document, as the model would return it for any query. */
  const buildWith = (doc: unknown) => build(() => doc);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('credential resolution â€” store-first', () => {
    it('resolves the configuration by storeId when both identifiers are known', async () => {
      handler = buildWith(configDoc());
      fetchWithRetryMock.mockResolvedValue(jsonResponse({ items: [] }));

      await handler.searchStatusParcels({ storeId: STORE_ID, vendorEmail: VENDOR_EMAIL });

      expect(findOne).toHaveBeenCalledTimes(1);
      const filter = findOne.mock.calls[0][0];
      expect(filter).not.toHaveProperty('$or');
      expect(filter.storeId).toBeDefined();
      expect(String(filter.storeId)).toBe(STORE_ID);
    });

    it('falls back to vendorEmail only when the storeId query misses', async () => {
      handler = build((filter) =>
        filter.storeId ? null : configDoc({ storeId: undefined }),
      );
      fetchWithRetryMock.mockResolvedValue(jsonResponse({ items: [] }));

      await handler.searchStatusParcels({ storeId: STORE_ID, vendorEmail: VENDOR_EMAIL });

      expect(findOne).toHaveBeenCalledTimes(2);
      expect(findOne.mock.calls[0][0]).toHaveProperty('storeId');
      expect(findOne.mock.calls[1][0]).toEqual({ vendorEmail: VENDOR_EMAIL });
    });

    it('falls back to vendorEmail when there is no storeId', async () => {
      handler = buildWith(configDoc());
      fetchWithRetryMock.mockResolvedValue(jsonResponse({ items: [] }));

      await handler.searchStatusParcels({ vendorEmail: VENDOR_EMAIL });

      expect(findOne).toHaveBeenCalledWith({ vendorEmail: VENDOR_EMAIL });
    });

    it('ignores a malformed storeId rather than querying with it', async () => {
      handler = buildWith(configDoc({ storeId: undefined }));
      fetchWithRetryMock.mockResolvedValue(jsonResponse({ items: [] }));

      await handler.searchStatusParcels({ storeId: 'not-an-object-id', vendorEmail: VENDOR_EMAIL });

      expect(findOne).toHaveBeenCalledTimes(1);
      expect(findOne).toHaveBeenCalledWith({ vendorEmail: VENDOR_EMAIL });
    });

    it('refuses a configuration owned by a different store', async () => {
      handler = build((filter) =>
        filter.storeId ? null : configDoc({ storeId: OTHER_STORE_ID }),
      );
      fetchWithRetryMock.mockResolvedValue(jsonResponse({ items: [] }));

      await expect(
        handler.searchStatusParcels({ storeId: STORE_ID, vendorEmail: VENDOR_EMAIL }),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED });

      expect(fetchWithRetryMock).not.toHaveBeenCalled();
    });

    it('accepts a legacy configuration row that predates storeId', async () => {
      handler = build((filter) => (filter.storeId ? null : configDoc({ storeId: undefined })));
      fetchWithRetryMock.mockResolvedValue(jsonResponse({ items: [] }));

      await handler.searchStatusParcels({ storeId: STORE_ID, vendorEmail: VENDOR_EMAIL });

      expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    });

    it('refuses when the store has no configuration at all', async () => {
      handler = buildWith(null);

      await expect(handler.searchStatusParcels({ storeId: STORE_ID })).rejects.toMatchObject({
        errorCode: AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED,
      });
    });

    it('refuses when the carrier is disabled for the store', async () => {
      handler = buildWith(
        configDoc({
          companies: {
            'zr-express': {
              status: 'disabled',
              credentials: { apiKey: API_KEY, tenantId: TENANT_ID },
            },
          },
        }),
      );

      await expect(handler.searchStatusParcels({ storeId: STORE_ID })).rejects.toMatchObject({
        errorCode: AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED,
      });
    });

    it('accepts a legacy row whose carrier has no status field', async () => {
      handler = buildWith(
        configDoc({
          companies: {
            'zr-express': { credentials: { apiKey: API_KEY, tenantId: TENANT_ID } },
          },
        }),
      );
      fetchWithRetryMock.mockResolvedValue(jsonResponse({ items: [] }));

      await handler.searchStatusParcels({ storeId: STORE_ID });

      expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    });

    it('refuses when the credentials are incomplete', async () => {
      handler = buildWith(
        configDoc({
          companies: {
            'zr-express': { status: 'enabled', credentials: { apiKey: '', tenantId: '' } },
          },
        }),
      );

      await expect(handler.searchStatusParcels({ storeId: STORE_ID })).rejects.toMatchObject({
        errorCode: AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED,
      });
    });

    it('never leaks the API key into a log line', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      handler = buildWith(configDoc());
      fetchWithRetryMock.mockRejectedValue(new Error('network down'));

      await expect(handler.searchStatusParcels({ storeId: STORE_ID })).rejects.toBeInstanceOf(
        AppException,
      );

      const logged = [...warn.mock.calls, ...error.mock.calls].flat().join(' ');
      expect(logged).not.toContain(API_KEY);
      warn.mockRestore();
      error.mockRestore();
    });
  });

  describe('searchStatusParcels()', () => {
    beforeEach(() => {
      handler = buildWith(configDoc());
    });

    it('posts to the carrierâ€™s search endpoint with the documented envelope', async () => {
      fetchWithRetryMock.mockResolvedValue(jsonResponse({ items: [] }));

      await handler.searchStatusParcels({ storeId: STORE_ID, limit: 50, page: 2 });

      const [url, init, retry] = fetchWithRetryMock.mock.calls[0];
      expect(url).toBe('https://api.zrexpress.app/api/v1.0/parcels/search');
      expect(init.method).toBe('POST');
      expect(init.headers['X-Tenant']).toBe(TENANT_ID);
      expect(init.headers['X-Api-Key']).toBe(API_KEY);
      expect(JSON.parse(init.body)).toEqual({
        pageNumber: 2,
        pageSize: 50,
        orderBy: ['lastStateUpdateAt desc'],
      });
      expect(retry.circuitBreakerName).toBe(`zr-express-status:${TENANT_ID}`);
    });

    it('defaults the page and the page size', async () => {
      fetchWithRetryMock.mockResolvedValue(jsonResponse({ items: [] }));

      await handler.searchStatusParcels({ storeId: STORE_ID });

      const body = JSON.parse(fetchWithRetryMock.mock.calls[0][1].body);
      expect(body.pageNumber).toBe(1);
      expect(body.pageSize).toBe(20);
    });

    it('maps the carrierâ€™s parcels onto the platform vocabulary', async () => {
      fetchWithRetryMock.mockResolvedValue(
        jsonResponse({
          items: [
            {
              id: 'parcel-1',
              externalId: 'ORD-1',
              trackingNumber: 'TRK-1',
              state: { id: 'uuid', name: 'sortie_en_livraison' },
              lastStateUpdateAt: '2026-10-20T10:00:00.000Z',
            },
          ],
          totalCount: 42,
          hasNext: true,
        }),
      );

      const result = await handler.searchStatusParcels({ storeId: STORE_ID });

      expect(result.parcels).toHaveLength(1);
      expect(result.parcels[0]).toMatchObject({
        parcelId: 'parcel-1',
        externalId: 'ORD-1',
        trackingNumber: 'TRK-1',
        deliveryStatus: 'with_courier',
        carrierStateName: 'sortie_en_livraison',
        terminal: false,
      });
      expect(result.totalCount).toBe(42);
      expect(result.hasNext).toBe(true);
    });

    it('applies the store’s per-tenant state override (§11.3)', async () => {
      handler = buildWith(
        configDoc({
          statusStateOverrides: { 'zr-express': { pret_a_expedier: 'en_preparation' } },
        }),
      );
      fetchWithRetryMock.mockResolvedValue(
        jsonResponse({
          items: [
            {
              id: 'parcel-1',
              state: { id: 'uuid', name: 'pret_a_expedier' },
            },
          ],
        }),
      );

      const result = await handler.searchStatusParcels({ storeId: STORE_ID });

      expect(result.parcels[0].deliveryStatus).toBe('preparing');
      expect(result.parcels[0].carrierStateName).toBe('pret_a_expedier');
    });

    it('keeps only the requested external references', async () => {
      fetchWithRetryMock.mockResolvedValue(
        jsonResponse({
          items: [
            { id: 'p1', externalId: 'ORD-1', state: { name: 'livre' } },
            { id: 'p2', externalId: 'ORD-2', state: { name: 'livre' } },
            { id: 'p3', state: { name: 'livre' } },
          ],
        }),
      );

      const result = await handler.searchStatusParcels({
        storeId: STORE_ID,
        externalIds: ['ORD-2'],
      });

      expect(result.parcels.map((parcel) => parcel.parcelId)).toEqual(['p2']);
    });

    it('keeps only the parcels changed after the watermark', async () => {
      fetchWithRetryMock.mockResolvedValue(
        jsonResponse({
          items: [
            { id: 'p1', state: { name: 'livre' }, lastStateUpdateAt: '2026-10-20T10:00:00.000Z' },
            { id: 'p2', state: { name: 'livre' }, lastStateUpdateAt: '2026-10-19T10:00:00.000Z' },
            { id: 'p3', state: { name: 'livre' } },
          ],
        }),
      );

      const result = await handler.searchStatusParcels({
        storeId: STORE_ID,
        updatedAfter: new Date('2026-10-20T00:00:00.000Z'),
      });

      expect(result.parcels.map((parcel) => parcel.parcelId)).toEqual(['p1']);
    });

    it('tolerates a response with no items', async () => {
      fetchWithRetryMock.mockResolvedValue(jsonResponse({}));

      const result = await handler.searchStatusParcels({ storeId: STORE_ID });

      expect(result.parcels).toEqual([]);
      expect(result.totalCount).toBeNull();
      expect(result.hasNext).toBe(false);
    });

    it('drops a parcel with no carrier id', async () => {
      fetchWithRetryMock.mockResolvedValue(jsonResponse({ items: [{ state: { name: 'livre' } }] }));

      const result = await handler.searchStatusParcels({ storeId: STORE_ID });

      expect(result.parcels).toEqual([]);
    });

    it('maps a rate limit onto the delivery error code', async () => {
      fetchWithRetryMock.mockResolvedValue(jsonResponse('Too many requests', 429));

      await expect(handler.searchStatusParcels({ storeId: STORE_ID })).rejects.toMatchObject({
        errorCode: AppErrorCode.DELIVERY_API_RATE_LIMITED,
      });
    });

    it('maps a client error onto the delivery error code', async () => {
      fetchWithRetryMock.mockResolvedValue(jsonResponse('Bad request', 400));

      await expect(handler.searchStatusParcels({ storeId: STORE_ID })).rejects.toMatchObject({
        errorCode: AppErrorCode.DELIVERY_API_ERROR,
      });
    });

    it('maps a timeout onto the delivery error code', async () => {
      fetchWithRetryMock.mockRejectedValue(new Error('Request timed out after 15000ms'));

      await expect(handler.searchStatusParcels({ storeId: STORE_ID })).rejects.toMatchObject({
        errorCode: AppErrorCode.DELIVERY_API_TIMEOUT,
      });
    });

    it('maps an unexpected failure onto the delivery error code', async () => {
      fetchWithRetryMock.mockRejectedValue(new Error('socket hang up'));

      await expect(handler.searchStatusParcels({ storeId: STORE_ID })).rejects.toMatchObject({
        errorCode: AppErrorCode.DELIVERY_UNKNOWN_ERROR,
      });
    });

    it('maps a non-JSON body onto the delivery error code', async () => {
      fetchWithRetryMock.mockResolvedValue(jsonResponse('<html>gateway</html>'));

      await expect(handler.searchStatusParcels({ storeId: STORE_ID })).rejects.toMatchObject({
        errorCode: AppErrorCode.DELIVERY_API_ERROR,
      });
    });
  });

  describe('fetchStatusHistory()', () => {
    beforeEach(() => {
      handler = buildWith(configDoc());
    });

    it('reads the carrierâ€™s state-history endpoint', async () => {
      fetchWithRetryMock.mockResolvedValue(jsonResponse([]));

      await handler.fetchStatusHistory({ storeId: STORE_ID }, 'parcel-1');

      const [url, init, retry] = fetchWithRetryMock.mock.calls[0];
      expect(url).toBe(
        'https://api.zrexpress.app/api/v1.0/parcels/parcel-1/state-history',
      );
      expect(init.method).toBe('GET');
      expect(init.headers['X-Tenant']).toBe(TENANT_ID);
      expect(retry.circuitBreakerName).toBe(`zr-express-status:${TENANT_ID}`);
    });

    it('escapes the parcel id', async () => {
      fetchWithRetryMock.mockResolvedValue(jsonResponse([]));

      await handler.fetchStatusHistory({ storeId: STORE_ID }, 'a/b?c');

      expect(fetchWithRetryMock.mock.calls[0][0]).toBe(
        'https://api.zrexpress.app/api/v1.0/parcels/a%2Fb%3Fc/state-history',
      );
    });

    it('maps the transitions and returns them oldest first', async () => {
      fetchWithRetryMock.mockResolvedValue(
        jsonResponse([
          {
            id: 'entry-2',
            parcelId: 'parcel-1',
            createdAt: '2026-10-20T10:00:00.000Z',
            previousState: { name: 'en_livraison' },
            newState: { name: 'sortie_en_livraison' },
            situations: [{ situationName: 'Appel telephonique' }],
          },
          {
            id: 'entry-1',
            parcelId: 'parcel-1',
            createdAt: '2026-10-19T10:00:00.000Z',
            previousState: { name: 'pret_a_expedier' },
            newState: { name: 'en_livraison' },
            location: { hubName: 'Hub Alger Centre' },
          },
        ]),
      );

      const entries = await handler.fetchStatusHistory({ storeId: STORE_ID }, 'parcel-1');

      expect(entries.map((entry) => entry.providerEntryId)).toEqual(['entry-1', 'entry-2']);
      expect(entries[0]).toMatchObject({
        fromState: 'pret_a_expedier',
        toState: 'en_livraison',
        fromStatus: 'ready_for_pickup',
        toStatus: 'out_for_delivery',
        hubName: 'Hub Alger Centre',
      });
      expect(entries[1].situationFlags).toEqual(['call_attempt']);
    });

    it('tolerates a non-array body', async () => {
      fetchWithRetryMock.mockResolvedValue(jsonResponse({ nope: true }));

      const entries = await handler.fetchStatusHistory({ storeId: STORE_ID }, 'parcel-1');

      expect(entries).toEqual([]);
    });

    it('refuses an empty parcel id', async () => {
      await expect(handler.fetchStatusHistory({ storeId: STORE_ID }, '')).rejects.toMatchObject({
        errorCode: AppErrorCode.DELIVERY_API_ERROR,
      });
      expect(fetchWithRetryMock).not.toHaveBeenCalled();
    });
  });
});
