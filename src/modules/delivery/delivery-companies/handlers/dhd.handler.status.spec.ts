import { AppException } from '../../../../common/errors/app-exception';
import { DhdHandler } from './dhd.handler';

const STORE_ID = '6ac400e26b1b2c3d4e5f6a71';
const OTHER_STORE_ID = '6ac400e26b1b2c3d4e5f6a72';

function config(overrides: Record<string, any> = {}) {
  return {
    storeId: STORE_ID,
    vendorEmail: 'vendor@example.com',
    companies: {
      dhd: {
        status: 'enabled',
        credentials: { apiToken: 'token-secret' },
      },
    },
    statusStateOverrides: {},
    statusSignalOverrides: {},
    ...overrides,
  };
}

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function parcel(tracking = 'DHD123', overrides: Record<string, unknown> = {}) {
  return {
    tracking,
    reference: 'ORD-1',
    status: 'En livraison',
    activity: [
      {
        date: '2026-10-20',
        time: '08:00:00',
        status: 'Picked',
        station: 'Alger',
      },
      {
        date: '2026-10-21',
        time: '09:30:00',
        status: 'En livraison',
        station: 'Alger',
      },
    ],
    ...overrides,
  };
}

describe('DhdHandler status capability', () => {
  let handler: DhdHandler;
  let findOne: jest.Mock;
  let fetchMock: jest.Mock;
  let settings: Record<string, string>;

  function buildHandler(configValue: any, values: Record<string, string> = {}) {
    findOne = jest.fn(() => ({
      lean: () => ({ exec: async () => configValue }),
    }));
    settings = values;
    handler = new DhdHandler(
      { findOne } as any,
      {} as any,
      { get: (key: string) => settings[key] ?? '' } as any,
    );
  }

  beforeEach(() => {
    buildHandler(config());
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('queries 100 trackings per call and maps the result', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const ids = new URL(url).searchParams.getAll('trackings[]');
      return response(200, {
        data: Object.fromEntries(ids.map((id, index) => [id, parcel(id)])),
      });
    });
    const ids = Array.from({ length: 250 }, (_, i) => `TRACK-${i}`);

    const result = await handler.searchStatusParcels({
      storeId: STORE_ID,
      parcelIds: ids,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer token-secret',
    });
    expect(result.parcels).toHaveLength(250);
    expect(result.totalCount).toBe(250);
    expect(result.hasNext).toBe(false);
    expect(result.parcels[0]).toMatchObject({
      parcelId: 'TRACK-0',
      externalId: 'ORD-1',
      deliveryStatus: 'out_for_delivery',
      carrierStateDescription: 'En livraison',
    });
  });

  it('reads the live top-level keyed response shape with nested OrderInfo', async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        DHD69ZW26102320961808: {
          OrderInfo: {
            tracking: 'DHD69ZW26102320961808',
            reference: '000911',
            client: 'test dhd',
            wilaya_id: 5,
          },
          recipientName: 'test dhd',
          status: 'Vers hub',
          activity: [
            {
              date: '2026-10-23',
              time: '17:23:57',
              status: 'order_information_received_by_carrier',
              station: '',
            },
          ],
        },
      }),
    );

    const result = await handler.searchStatusParcels({
      storeId: STORE_ID,
      parcelIds: ['DHD69ZW26102320961808'],
    });

    expect(result.missingParcelIds).toEqual([]);
    expect(result.parcels[0]).toMatchObject({
      parcelId: 'DHD69ZW26102320961808',
      externalId: '000911',
      deliveryStatus: 'dispatch_local',
    });
  });

  it('pages discovery and reports more work', async () => {
    fetchMock.mockResolvedValue(
      response(200, { data: { 'TRACK-1': parcel('TRACK-1') } }),
    );

    const result = await handler.searchStatusParcels({
      storeId: STORE_ID,
      parcelIds: ['TRACK-0', 'TRACK-1', 'TRACK-2'],
      page: 1,
      limit: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.getAll('trackings[]')).toEqual([
      'TRACK-0',
      'TRACK-1',
    ]);
    expect(result.missingParcelIds).toEqual(['TRACK-0']);
    expect(result.hasNext).toBe(true);
  });

  it('refreshes by parcel id, not only the order reference', async () => {
    buildHandler(config(), { 'dhdStatusSync.apiBase': 'https://dhd.test' });
    fetchMock.mockResolvedValue(response(200, { data: { DHD123: parcel() } }));

    await handler.searchStatusParcels({
      storeId: STORE_ID,
      parcelIds: ['DHD123'],
      page: 1,
      limit: 2,
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.origin).toBe('https://dhd.test');
    expect(url.pathname).toBe('/api/v1/get/trackings/info');
    expect(url.searchParams.getAll('trackings[]')).toEqual(['DHD123']);
  });

  it('marks trackings the carrier does not return as missing', async () => {
    fetchMock.mockResolvedValue(response(200, { data: {} }));

    const result = await handler.searchStatusParcels({
      storeId: STORE_ID,
      parcelIds: ['DHD123', 'DHD999'],
    });

    expect(result.parcels).toEqual([]);
    expect(result.missingParcelIds).toEqual(['DHD123', 'DHD999']);
  });

  it('isolates an invalid tracking from a batch with a 422', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const ids = new URL(url).searchParams.getAll('trackings[]');
      if (ids.includes('BAD')) return response(422, { message: 'Invalid tracking' });
      return response(200, {
        data: Object.fromEntries(ids.map((id) => [id, parcel(id)])),
      });
    });

    const result = await handler.searchStatusParcels({
      storeId: STORE_ID,
      parcelIds: ['GOOD-1', 'BAD', 'GOOD-2'],
    });

    expect(result.parcels.map((row) => row.parcelId).sort()).toEqual([
      'GOOD-1',
      'GOOD-2',
    ]);
    expect(result.missingParcelIds).toEqual(['BAD']);
  });

  it('reuses discovery activity instead of per-parcel history requests', async () => {
    fetchMock.mockResolvedValue(response(200, { data: { DHD123: parcel() } }));

    await handler.searchStatusParcels({ storeId: STORE_ID, parcelIds: ['DHD123'] });
    const history = await handler.fetchStatusHistory({ storeId: STORE_ID }, 'DHD123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(history.map((entry) => entry.toStatus)).toEqual([
      'dispatch_local',
      'out_for_delivery',
    ]);
    expect(history[0].providerEntryId).toMatch(/^[a-f0-9]{40}$/);
  });

  it('fetches a single tracking history when discovery had no activity', async () => {
    fetchMock
      .mockResolvedValueOnce(
        response(200, { data: { DHD123: { tracking: 'DHD123', status: 'Livre non encaissé' } } }),
      )
      .mockResolvedValueOnce(response(200, { tracking: 'DHD123', activity: parcel().activity }));

    await handler.searchStatusParcels({ storeId: STORE_ID, parcelIds: ['DHD123'] });
    const history = await handler.fetchStatusHistory({ storeId: STORE_ID }, 'DHD123');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchMock.mock.calls[1][0]).pathname).toBe('/api/v1/get/tracking/info');
    expect(history).toHaveLength(2);
  });

  it('maps a missing batch history to an empty timeline and continues', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const tracking = new URL(url).searchParams.get('tracking');
      if (tracking === 'MISSING') return response(204, {});
      return response(200, { tracking, activity: parcel(tracking ?? '').activity });
    });

    const histories = await handler.fetchStatusHistories(
      { storeId: STORE_ID },
      ['DHD123', 'MISSING'],
    );

    expect(histories.DHD123).toHaveLength(2);
    expect(histories.MISSING).toEqual([]);
  });

  it('resolves the tenant as a stable fingerprint and never exposes the token', async () => {
    const first = await handler.resolveStatusTenant({ storeId: STORE_ID });
    const second = await handler.resolveStatusTenant({ storeId: STORE_ID });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(first).not.toContain('token-secret');
  });

  it('queries storeId before the legacy vendorEmail', async () => {
    fetchMock.mockResolvedValue(response(200, { data: {} }));

    await handler.searchStatusParcels({ storeId: STORE_ID, parcelIds: ['DHD123'] });

    expect(findOne).toHaveBeenCalledWith({ storeId: expect.anything() });
  });

  it('refuses a configuration owned by another store', async () => {
    buildHandler(config({ storeId: OTHER_STORE_ID }));

    await expect(
      handler.searchStatusParcels({ storeId: STORE_ID, parcelIds: ['DHD123'] }),
    ).rejects.toBeInstanceOf(AppException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a store with no token', async () => {
    buildHandler(
      config({
        companies: { dhd: { status: 'enabled', credentials: {} } },
      }),
    );

    await expect(handler.resolveStatusTenant({ storeId: STORE_ID })).rejects.toMatchObject({
      errorCode: 'DELIVERY_CREDENTIALS_NOT_CONFIGURED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('supports the api_token query auth mode', async () => {
    buildHandler(config(), { 'dhdStatusSync.authMode': 'query' });
    fetchMock.mockResolvedValue(response(200, { data: { DHD123: parcel() } }));

    await handler.searchStatusParcels({ storeId: STORE_ID, parcelIds: ['DHD123'] });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('api_token')).toBe('token-secret');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('maps 429 with Retry-After and does not retry the rate limit', async () => {
    fetchMock.mockResolvedValue(response(429, {}, { 'retry-after': '27' }));

    await expect(
      handler.searchStatusParcels({ storeId: STORE_ID, parcelIds: ['DHD123'] }),
    ).rejects.toMatchObject({
      errorCode: 'DELIVERY_API_RATE_LIMITED',
      errorParams: expect.objectContaining({ retryAfterSeconds: 27 }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps malformed successful bodies to DELIVERY_API_ERROR', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '<html>not json</html>',
    } as unknown as Response);

    await expect(
      handler.searchStatusParcels({ storeId: STORE_ID, parcelIds: ['DHD123'] }),
    ).rejects.toMatchObject({ errorCode: 'DELIVERY_API_ERROR' });
  });

  it('never logs the API token', async () => {
    const log = jest.spyOn((handler as any).logger, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn((handler as any).logger, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn((handler as any).logger, 'error').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(response(200, { data: { DHD123: parcel() } }));

    await handler.searchStatusParcels({ storeId: STORE_ID, parcelIds: ['DHD123'] });

    const logged = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
      .flat()
      .join(' ');
    expect(logged).not.toContain('token-secret');
  });
});
