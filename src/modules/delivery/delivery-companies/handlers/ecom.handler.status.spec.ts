import { AppException } from '../../../../common/errors/app-exception';
import { EcomHandler } from './ecom.handler';

const STORE_ID = '6ac400e26b1b2c3d4e5f6a71';
const OTHER_STORE_ID = '6ac400e26b1b2c3d4e5f6a72';

function config(overrides: Record<string, any> = {}) {
  return {
    storeId: STORE_ID,
    vendorEmail: 'vendor@example.com',
    companies: {
      'ecom-delivery': {
        status: 'enabled',
        credentials: { key: 'key-123', token: 'token-456' },
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

function parcel(overrides: Record<string, unknown> = {}) {
  return {
    tracking: 'ECBGE309',
    id_externe: 'ORD-1',
    trouve: true,
    situation: 'Livrée',
    id_situation: 7,
    etat_logistique: 'Livré',
    id_etat_logistique: 9,
    date_action: '2026-06-10T16:45:00.000Z',
    ...overrides,
  };
}

describe('EcomHandler status capability', () => {
  let handler: EcomHandler;
  let findOne: jest.Mock;
  let fetchMock: jest.Mock;

  function buildHandler(configValue: any) {
    findOne = jest.fn(() => ({
      lean: () => ({ exec: async () => configValue }),
    }));
    handler = new EcomHandler(
      { findOne } as any,
      {} as any,
      { get: () => '' } as any,
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

  it('queries by tracking in 100-item chunks with both auth headers', async () => {
    fetchMock.mockResolvedValue(response(200, { trackings: [parcel()] }));
    const ids = Array.from({ length: 250 }, (_, i) => `TRACK-${i}`);

    const result = await handler.searchStatusParcels({ storeId: STORE_ID, parcelIds: ids });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers).toMatchObject({
      'X-API-Key': 'key-123',
      'X-API-Token': 'token-456',
    });
    expect(JSON.parse(init.body).trackings).toHaveLength(100);
    expect(result.parcels).toHaveLength(3);
    expect(result.parcels[0].deliveryStatus).toBe('delivered');
    expect(result.missingParcelIds).toHaveLength(250);
  });

  it('flattens external-id results and marks not-found trackings missing', async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        id_externes: [
          {
            id_externe: 'ORD-1',
            trouve: true,
            colis: [parcel()],
          },
        ],
      }),
    );

    const result = await handler.searchStatusParcels({
      storeId: STORE_ID,
      externalIds: ['ORD-1'],
    });

    expect(result.parcels.map((p) => p.parcelId)).toEqual(['ECBGE309']);
    expect(result.missingParcelIds).toEqual([]);
  });

  it('returns no requests when the poller supplies no identifiers', async () => {
    const result = await handler.searchStatusParcels({ storeId: STORE_ID });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.parcels).toEqual([]);
  });

  it('resolves the tenant as a stable fingerprint, never the credentials', async () => {
    const first = await handler.resolveStatusTenant({ storeId: STORE_ID });
    const second = await handler.resolveStatusTenant({ storeId: STORE_ID });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(first).not.toContain('key-123');
    expect(first).not.toContain('token-456');
  });

  it('queries storeId before the legacy vendorEmail', async () => {
    buildHandler(config());
    fetchMock.mockResolvedValue(response(200, { trackings: [parcel()] }));

    await handler.searchStatusParcels({ storeId: STORE_ID, parcelIds: ['ECBGE309'] });

    expect(findOne).toHaveBeenCalledWith({ storeId: expect.anything() });
  });

  it('refuses a configuration owned by another store', async () => {
    buildHandler(config({ storeId: OTHER_STORE_ID }));

    await expect(handler.resolveStatusTenant({ storeId: STORE_ID })).resolves.toBeNull();
    await expect(
      handler.searchStatusParcels({ storeId: STORE_ID, parcelIds: ['ECBGE309'] }),
    ).rejects.toBeInstanceOf(AppException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches histories in 40-item chunks and keys the result by tracking', async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        resultats: [
          {
            tracking: 'ECBGE309',
            trouve: true,
            historique: [
              { date: '2026-06-10T10:00:00.000Z', situation: 'En livraison' },
              { date: '2026-06-10T16:45:00.000Z', situation: 'Livrée' },
            ],
          },
        ],
      }),
    );
    const ids = ['ECBGE309', ...Array.from({ length: 44 }, (_, i) => `TRACK-${i}`)];

    const result = await handler.fetchStatusHistories({ storeId: STORE_ID }, ids);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result['ECBGE309']).toHaveLength(2);
    expect(result['TRACK-0']).toEqual([]);
  });

  it('maps 429 onto the rate-limited code with Retry-After', async () => {
    fetchMock.mockResolvedValue(response(429, {}, { 'retry-after': '27' }));

    await expect(
      handler.searchStatusParcels({ storeId: STORE_ID, parcelIds: ['ECBGE309'] }),
    ).rejects.toMatchObject({
      errorCode: 'DELIVERY_API_RATE_LIMITED',
      errorParams: expect.objectContaining({ retryAfterSeconds: 27 }),
    });
  });

  it.each([401, 422, 500, 503])('maps HTTP %s onto DELIVERY_API_ERROR', async (status) => {
    fetchMock.mockResolvedValue(response(status, { error: 'nope' }));

    await expect(
      handler.searchStatusParcels({ storeId: STORE_ID, parcelIds: ['ECBGE309'] }),
    ).rejects.toMatchObject({ errorCode: 'DELIVERY_API_ERROR' });
  });

  it('refuses a bulk creation that mixes stores before resolving credentials', async () => {
    const orders = [
      { orderNo: 'ORD-1', storeId: STORE_ID, vendorEmail: 'a@example.com' },
      { orderNo: 'ORD-2', storeId: OTHER_STORE_ID, vendorEmail: 'b@example.com' },
    ];

    const result = await handler.createBulkOrders(orders as any);

    expect(result).toEqual([
      { orderNo: 'ORD-1', success: false, error: 'Ecom bulk requests cannot mix stores' },
      { orderNo: 'ORD-2', success: false, error: 'Ecom bulk requests cannot mix stores' },
    ]);
    expect(findOne).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a legacy bulk creation that mixes vendor emails', async () => {
    const result = await handler.createBulkOrders([
      { orderNo: 'ORD-1', vendorEmail: 'a@example.com' },
      { orderNo: 'ORD-2', vendorEmail: 'b@example.com' },
    ] as any);

    expect(result.every((row) => row.success === false)).toBe(true);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('resolves creation credentials store-first', async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        resultats: [{ index: 0, ok: true, tracking: 'ECBGE1', erreur: null }],
      }),
    );

    const result = await handler.createBulkOrders([
      {
        orderNo: 'ORD-1',
        storeId: STORE_ID,
        vendorEmail: 'vendor@example.com',
        shippingMethod: 'home',
        customer: { name: 'Ali', phone: '0550000000', wilaya: '16', commune: 'Bab Ezzouar' },
        items: [{ productName: 'Shoe', quantity: 1 }],
        total: 1000,
      } as any,
    ]);

    expect(findOne).toHaveBeenCalledWith({ storeId: expect.anything() });
    expect(result[0]).toMatchObject({ success: true, parcelId: 'ECBGE1' });
  });

  it('never logs the API key or token', async () => {
    const log = jest.spyOn((handler as any).logger, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn((handler as any).logger, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn((handler as any).logger, 'error').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(response(200, { trackings: [parcel()] }));

    await handler.searchStatusParcels({ storeId: STORE_ID, parcelIds: ['ECBGE309'] });

    const logged = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
      .flat()
      .join(' ');
    expect(logged).not.toContain('key-123');
    expect(logged).not.toContain('token-456');
  });
});
