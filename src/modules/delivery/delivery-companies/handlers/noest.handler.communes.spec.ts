import { AppErrorCode } from '../../../../common/errors/error-codes.enum';
import { NoestHandler } from './noest.handler';

const STORE_ID = '6ac400e26b1b2c3d4e5f6a71';
const OTHER_STORE_ID = '6ac400e26b1b2c3d4e5f6a72';

function config(overrides: Record<string, any> = {}) {
  return {
    storeId: STORE_ID,
    vendorEmail: 'vendor@example.com',
    companies: {
      noest: {
        status: 'enabled',
        credentials: { apiToken: 'token-secret', guid: 'guid-secret' },
      },
    },
    ...overrides,
  };
}

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function order(overrides: Record<string, any> = {}) {
  return {
    _id: 'order-1',
    orderNo: '000001',
    storeId: STORE_ID,
    vendorEmail: 'vendor@example.com',
    deliveryCompanyId: 'noest',
    shippingMethod: 'home',
    customer: {
      name: 'Karim Benali',
      phone: '0550123456',
      wilaya: '5',
      commune: 'Batna Ville',
      address: 'Rue de la Republique',
    },
    items: [{ productName: 'Robe', quantity: 1, price: 1200, weight: 1 }],
    total: 1200,
    ...overrides,
  } as any;
}

function selection(overrides: Record<string, any> = {}) {
  return {
    name: 'Batna',
    wilayaId: '5',
    postalCode: '05001',
    ...overrides,
  } as any;
}

describe('NoestHandler commune mapping', () => {
  let handler: NoestHandler;
  let fetchMock: jest.Mock;
  let enabled = true;
  /** The platform commune document the location registry returns for any single lookup. */
  let communeDoc: Record<string, any> | null = null;

  beforeEach(() => {
    enabled = true;
    communeDoc = null;
    handler = new NoestHandler(
      {
        // `resolveStatusCredentials` uses `.lean()`, `createOrder` uses `.exec()`.
        findOne: () => ({
          lean: async () => config(),
          exec: async () => config(),
        }),
      } as any,
      {
        // Used both by `communeFromRegistry` (`.lean().exec()`) and the legacy
        // `resolveCommuneName` (`.exec()`).
        findOne: () => ({
          lean: () => ({ exec: async () => communeDoc }),
          exec: async () => communeDoc,
        }),
      } as any,
      {
        get: (key: string) => {
          if (key === 'noestCommuneMapping.enabled') return enabled;
          return '';
        },
      } as any,
    );
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('listCommunes', () => {
    it('calls the wilaya-scoped endpoint with only the Bearer token and normalizes the array', async () => {
      fetchMock.mockResolvedValueOnce(
        response(200, [
          { nom: 'Batna', wilaya_id: 5, code_postal: '05001', is_active: 1 },
          { nom: 'Barika', wilaya_id: 5, code_postal: '05002', is_active: 1 },
          { nom: 'Retiree', wilaya_id: 5, is_active: 0 },
        ]),
      );

      const communes = await handler.listCommunes('5', { vendorEmail: 'vendor@example.com' });

      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('https://app.noest-dz.com/api/public/get/communes/5');
      expect(init.method).toBe('GET');
      expect(init.headers.Authorization).toBe('Bearer token-secret');
      expect(init.headers).not.toHaveProperty('user_guid');
      expect(communes).toEqual([
        { name: 'Barika', wilayaId: '5', postalCode: '05002' },
        { name: 'Batna', wilayaId: '5', postalCode: '05001' },
      ]);
    });

    it('maps 401 to DELIVERY_CREDENTIALS_NOT_CONFIGURED', async () => {
      // `mockResolvedValue`, not `…Once`: a retryable status is re-fetched by `fetchWithRetry`.
      fetchMock.mockResolvedValue(response(401, {}));
      await expect(
        handler.listCommunes('5', { vendorEmail: 'vendor@example.com' }),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED });
    });

    it('maps an exhausted 5xx to DELIVERY_API_ERROR', async () => {
      fetchMock.mockResolvedValue(response(503, { error: 'boom' }));
      await expect(
        handler.listCommunes('5', { vendorEmail: 'vendor@example.com' }),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.DELIVERY_API_ERROR });
    });

    it('maps 429 to RATE_LIMIT_EXCEEDED with the carrier retry hint', async () => {
      fetchMock.mockResolvedValue({
        ...response(429, {}),
        headers: { get: (name: string) => (name === 'retry-after' ? '30' : null) },
      } as unknown as Response);

      await expect(
        handler.listCommunes('5', { vendorEmail: 'vendor@example.com' }),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.RATE_LIMIT_EXCEEDED });
    });
  });

  describe('assertDispatchable', () => {
    it('refuses an order whose commune has no noestexpress_uuid and no selection', async () => {
      await expect(handler.assertDispatchable(order())).rejects.toMatchObject({
        errorCode: AppErrorCode.DELIVERY_COMMUNE_NOT_MAPPED,
      });
    });

    it('distinguishes a selection from another wilaya', async () => {
      await expect(
        handler.assertDispatchable(order({ noestCommune: selection({ wilayaId: '16' }) })),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.DELIVERY_COMMUNE_INVALID });
    });

    it('accepts a valid explicit selection', async () => {
      await expect(
        handler.assertDispatchable(order({ noestCommune: selection() })),
      ).resolves.toBeUndefined();
    });

    it('accepts an order whose platform commune already carries a noestexpress_uuid', async () => {
      communeDoc = { noestexpress_uuid: 'Batna', post_code: '05001' };

      await expect(handler.assertDispatchable(order())).resolves.toBeUndefined();
    });

    it('does not silently replace an invalid explicit selection with the registry mapping', async () => {
      communeDoc = { noestexpress_uuid: 'Batna', post_code: '05001' };

      await expect(
        handler.assertDispatchable(order({ noestCommune: selection({ wilayaId: '16' }) })),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.DELIVERY_COMMUNE_INVALID });
    });

    it('is a no-op for other carriers and while the feature is disabled', async () => {
      await expect(
        handler.assertDispatchable(order({ deliveryCompanyId: 'dhd' })),
      ).resolves.toBeUndefined();

      enabled = false;
      await expect(handler.assertDispatchable(order())).resolves.toBeUndefined();
    });

    it('needs no carrier credentials to evaluate the gate', async () => {
      // No `fetch` expectation: the gate is answered entirely from the platform registry.
      communeDoc = null;
      await expect(handler.assertDispatchable(order())).rejects.toMatchObject({
        errorCode: AppErrorCode.DELIVERY_COMMUNE_NOT_MAPPED,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('createOrder', () => {
    it('sends the selected commune and numeric wilaya, and never a postal code', async () => {
      fetchMock.mockResolvedValueOnce(response(200, { success: true, tracking: 'TRK-123' }));

      const result = await handler.createOrder(order({ noestCommune: selection() }));

      expect(result).toEqual({ parcelId: 'TRK-123' });
      const [, init] = fetchMock.mock.calls[0];
      const sent = JSON.parse(String(init.body));
      expect(sent.commune).toBe('Batna');
      expect(sent.wilaya_id).toBe(5);
      expect(sent).not.toHaveProperty('zip_code');
      expect(sent).not.toHaveProperty('postalCode');
      expect(sent).not.toHaveProperty('code_postal');
    });

    it('sends the platform commune noestexpress_uuid when no explicit selection is saved', async () => {
      communeDoc = { noestexpress_uuid: 'Batna', post_code: '05001' };
      fetchMock.mockResolvedValueOnce(response(200, { success: true, tracking: 'TRK-REGISTRY' }));

      await handler.createOrder(order());

      const [, init] = fetchMock.mock.calls[0];
      const sent = JSON.parse(String(init.body));
      expect(sent.commune).toBe('Batna');
      expect(sent.wilaya_id).toBe(5);
    });

    it('keeps the legacy commune resolution for an unmapped order while disabled', async () => {
      enabled = false;
      fetchMock.mockResolvedValueOnce(response(200, { success: true, tracking: 'TRK-LEGACY' }));

      await handler.createOrder(order());

      const [, init] = fetchMock.mock.calls[0];
      const sent = JSON.parse(String(init.body));
      expect(sent.commune).toBe('Batna Ville');
      expect(sent.wilaya_id).toBe(5);
    });

    it('uses the saved selection even while the rollout flag is off', async () => {
      enabled = false;
      fetchMock.mockResolvedValueOnce(response(200, { success: true, tracking: 'TRK-MAPPED' }));

      await handler.createOrder(
        order({
          customer: {
            name: 'Karim Benali',
            phone: '0550123456',
            wilaya: '25',
            commune: '6a4cd74fbabdf95b0dcc686f',
            address: 'Ben Badis El haria',
          },
          noestCommune: selection({ name: 'Ben Badis', wilayaId: '25', postalCode: '25030' }),
        }),
      );

      const [, init] = fetchMock.mock.calls[0];
      const sent = JSON.parse(String(init.body));
      expect(sent.commune).toBe('Ben Badis');
      expect(sent.wilaya_id).toBe(25);
      expect(sent).not.toHaveProperty('zip_code');
    });
  });

  describe('createBulkOrders', () => {
    it('partitions unmapped orders out and dispatches only the valid ones', async () => {
      fetchMock.mockResolvedValueOnce(
        response(200, { passed: { 0: { success: true, tracking: 'TRK-1' } }, failed: {} }),
      );

      const results = await handler.createBulkOrders([
        order({ orderNo: '000001', noestCommune: selection() }),
        order({ orderNo: '000002' }),
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0];
      const sent = JSON.parse(String(init.body));
      expect(sent.orders).toHaveLength(1);
      expect(sent.orders[0].commune).toBe('Batna');
      expect(results).toEqual([
        {
          orderNo: '000002',
          success: false,
          code: AppErrorCode.DELIVERY_COMMUNE_NOT_MAPPED,
          error: 'Noest commune not selected or not mapped for this wilaya',
        },
        { orderNo: '000001', success: true, parcelId: 'TRK-1' },
      ]);
    });

    it('maps response indices back to the orders actually sent', async () => {
      // The second order is dropped by the partition, so response index 0 must resolve to the
      // first *valid* order, never to the caller's index 0 by accident.
      fetchMock.mockResolvedValueOnce(
        response(200, { passed: { 0: { success: true, tracking: 'TRK-B' } }, failed: {} }),
      );

      const results = await handler.createBulkOrders([
        order({ orderNo: '000001' }),
        order({ orderNo: '000002', noestCommune: selection() }),
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(String(init.body)).orders).toHaveLength(1);
      expect(results).toEqual([
        expect.objectContaining({ orderNo: '000001', code: AppErrorCode.DELIVERY_COMMUNE_NOT_MAPPED }),
        { orderNo: '000002', success: true, parcelId: 'TRK-B' },
      ]);
    });

    it('dispatches a commune that already carries a noestexpress_uuid without a selection', async () => {
      communeDoc = { noestexpress_uuid: 'Batna', post_code: '05001' };
      fetchMock.mockResolvedValueOnce(
        response(200, { passed: { 0: { success: true, tracking: 'TRK-1' } }, failed: {} }),
      );

      const results = await handler.createBulkOrders([order({ orderNo: '000001' })]);

      expect(results).toEqual([{ orderNo: '000001', success: true, parcelId: 'TRK-1' }]);
      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(String(init.body)).orders[0].commune).toBe('Batna');
    });

    it('makes zero HTTP calls when every order is unmapped', async () => {
      const results = await handler.createBulkOrders([
        order({ orderNo: '000001' }),
        order({ orderNo: '000002' }),
      ]);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.code === AppErrorCode.DELIVERY_COMMUNE_NOT_MAPPED)).toBe(true);
    });

    it('refuses a mixed-store batch', async () => {
      await expect(
        handler.createBulkOrders([
          order({ noestCommune: selection() }),
          order({ storeId: OTHER_STORE_ID, noestCommune: selection() }),
        ]),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.VALIDATION_INVALID_VALUE });
    });
  });
});
