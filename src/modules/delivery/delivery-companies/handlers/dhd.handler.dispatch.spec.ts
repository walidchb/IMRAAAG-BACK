import { AppErrorCode } from '../../../../common/errors/error-codes.enum';
import { DhdHandler } from './dhd.handler';

const STORE_ID = '6ac400e26b1b2c3d4e5f6a71';
const OTHER_STORE_ID = '6ac400e26b1b2c3d4e5f6a72';

function config() {
  return {
    storeId: STORE_ID,
    vendorEmail: 'vendor@example.com',
    companies: {
      dhd: {
        status: 'enabled',
        credentials: { apiToken: 'token-secret' },
      },
    },
  };
}

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function order(overrides: Record<string, any> = {}) {
  return {
    _id: 'order-1',
    orderNo: '000001',
    storeId: STORE_ID,
    vendorEmail: 'vendor@example.com',
    deliveryCompanyId: 'dhd',
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
    hasStopDesk: true,
    ...overrides,
  } as any;
}

describe('DhdHandler commune-mapping dispatch', () => {
  let handler: DhdHandler;
  let fetchMock: jest.Mock;
  let enabled = true;
  /** The platform commune document the location registry returns for any single lookup. */
  let communeDoc: Record<string, any> | null = null;

  beforeEach(() => {
    enabled = true;
    communeDoc = null;
    handler = new DhdHandler(
      {
        findOne: () => ({
          lean: () => ({ exec: async () => config() }),
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
          if (key === 'dhdCommuneMapping.enabled') return enabled;
          if (key === 'dhdStatusSync.apiBase') return 'https://platform.dhd-dz.com';
          if (key === 'dhdStatusSync.authMode') return 'bearer';
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

  describe('assertDispatchable', () => {
    it('refuses a DHD order whose commune has no dhd_uuid and no selection', async () => {
      await expect(handler.assertDispatchable(order())).rejects.toThrow(
        expect.objectContaining({ errorCode: AppErrorCode.DELIVERY_COMMUNE_NOT_MAPPED }),
      );
    });

    it('distinguishes a selection from another wilaya', async () => {
      await expect(
        handler.assertDispatchable(order({ dhdCommune: selection({ wilayaId: '16' }) })),
      ).rejects.toThrow(expect.objectContaining({ errorCode: AppErrorCode.DELIVERY_COMMUNE_INVALID }));
    });

    it('refuses a stop-desk order whose commune does not support stop desk', async () => {
      await expect(
        handler.assertDispatchable(
          order({ shippingMethod: 'stopdesk', dhdCommune: selection({ hasStopDesk: false }) }),
        ),
      ).rejects.toThrow(expect.objectContaining({ errorCode: AppErrorCode.DELIVERY_COMMUNE_NOT_MAPPED }));
    });

    it('accepts a valid explicit selection for home and stop-desk delivery', async () => {
      await expect(
        handler.assertDispatchable(order({ dhdCommune: selection() })),
      ).resolves.toBeUndefined();
      await expect(
        handler.assertDispatchable(
          order({ shippingMethod: 'stopdesk', dhdCommune: selection({ hasStopDesk: true }) }),
        ),
      ).resolves.toBeUndefined();
    });

    it('accepts an order whose platform commune already carries a dhd_uuid', async () => {
      communeDoc = { dhd_uuid: 'Batna', post_code: '05001' };

      await expect(handler.assertDispatchable(order())).resolves.toBeUndefined();
      await expect(
        handler.assertDispatchable(order({ shippingMethod: 'stopdesk' })),
      ).resolves.toBeUndefined();
    });

    it('does not silently replace an invalid explicit selection with the registry mapping', async () => {
      communeDoc = { dhd_uuid: 'Batna', post_code: '05001' };

      await expect(
        handler.assertDispatchable(order({ dhdCommune: selection({ wilayaId: '16' }) })),
      ).rejects.toThrow(expect.objectContaining({ errorCode: AppErrorCode.DELIVERY_COMMUNE_INVALID }));
    });

    it('is a no-op for other carriers and while the feature is disabled', async () => {
      await expect(
        handler.assertDispatchable(order({ deliveryCompanyId: 'zr-express' })),
      ).resolves.toBeUndefined();

      enabled = false;
      await expect(handler.assertDispatchable(order())).resolves.toBeUndefined();
    });
  });

  describe('createOrder', () => {
    it('sends the selected DHD commune, wilaya and postal code', async () => {
      fetchMock.mockResolvedValueOnce(response(200, { success: true, tracking: 'TRK-123' }));

      const result = await handler.createOrder(order({ dhdCommune: selection() }));

      expect(result).toEqual({ parcelId: 'TRK-123' });
      const [url] = fetchMock.mock.calls[0];
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/api/v1/create/order');
      expect(parsed.searchParams.get('commune')).toBe('Batna');
      expect(parsed.searchParams.get('code_wilaya')).toBe('5');
      expect(parsed.searchParams.get('code_postal')).toBe('05001');
      expect(parsed.searchParams.get('stop_desk')).toBe('0');
    });

    it('sends the platform commune dhd_uuid when no explicit selection is saved', async () => {
      communeDoc = { dhd_uuid: 'Batna', post_code: '05001' };
      fetchMock.mockResolvedValueOnce(response(200, { success: true, tracking: 'TRK-REGISTRY' }));

      await handler.createOrder(order());

      const [url] = fetchMock.mock.calls[0];
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get('commune')).toBe('Batna');
      expect(parsed.searchParams.get('code_wilaya')).toBe('5');
      expect(parsed.searchParams.get('code_postal')).toBe('05001');
    });

    it('keeps the legacy commune resolution for an unmapped order while disabled', async () => {
      enabled = false;
      fetchMock.mockResolvedValueOnce(response(200, { success: true, tracking: 'TRK-LEGACY' }));

      await handler.createOrder(order());

      const [url] = fetchMock.mock.calls[0];
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get('commune')).toBe('Batna Ville');
      expect(parsed.searchParams.get('code_postal')).toBeNull();
    });

    it('uses the saved DHD selection even while the rollout flag is off', async () => {
      // Regression for live order 001016: the operator picked DHD "Ben Badis", but dispatch sent
      // the platform commune name ("Ben Badis El haria") because the flag was off.
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
          dhdCommune: selection({
            name: 'Ben Badis',
            wilayaId: '25',
            postalCode: '25030',
            hasStopDesk: false,
          }),
        }),
      );

      const [url] = fetchMock.mock.calls[0];
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get('commune')).toBe('Ben Badis');
      expect(parsed.searchParams.get('code_wilaya')).toBe('25');
      expect(parsed.searchParams.get('code_postal')).toBe('25030');
    });

    it('falls back to the legacy name when the saved selection is for another wilaya', async () => {
      enabled = false;
      fetchMock.mockResolvedValueOnce(response(200, { success: true, tracking: 'TRK-STALE' }));

      await handler.createOrder(order({ dhdCommune: selection({ wilayaId: '16' }) }));

      const [url] = fetchMock.mock.calls[0];
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get('commune')).toBe('Batna Ville');
      expect(parsed.searchParams.get('code_wilaya')).toBe('5');
    });
  });

  describe('createBulkOrders', () => {
    it('partitions unmapped orders out and dispatches only the valid ones', async () => {
      fetchMock.mockResolvedValueOnce(
        response(200, {
          results: {
            '000001': { success: true, tracking: 'TRK-1' },
          },
        }),
      );

      const results = await handler.createBulkOrders([
        order({ orderNo: '000001', dhdCommune: selection() }),
        order({ orderNo: '000002' }),
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0];
      const sent = JSON.parse(String(init.body));
      expect(Object.keys(sent.orders)).toHaveLength(1);
      expect(results).toEqual([
        {
          orderNo: '000002',
          success: false,
          code: AppErrorCode.DELIVERY_COMMUNE_NOT_MAPPED,
          error: 'DHD commune not selected or invalid for this wilaya',
        },
        { orderNo: '000001', success: true, parcelId: 'TRK-1' },
      ]);
    });

    it('dispatches a commune that already carries a dhd_uuid without a manual selection', async () => {
      communeDoc = { dhd_uuid: 'Batna', post_code: '05001' };
      fetchMock.mockResolvedValueOnce(
        response(200, { results: { '000001': { success: true, tracking: 'TRK-1' } } }),
      );

      const results = await handler.createBulkOrders([order({ orderNo: '000001' })]);

      expect(results).toEqual([{ orderNo: '000001', success: true, parcelId: 'TRK-1' }]);
      const [, init] = fetchMock.mock.calls[0];
      const sent = JSON.parse(String(init.body));
      expect(sent.orders['0'].commune).toBe('Batna');
      expect(sent.orders['0'].code_postal).toBe('05001');
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
          order({ dhdCommune: selection() }),
          order({ storeId: OTHER_STORE_ID, dhdCommune: selection() }),
        ]),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.VALIDATION_INVALID_VALUE });
    });

    it('uses saved selections in legacy mode instead of resolving the platform commune', async () => {
      enabled = false;
      fetchMock.mockResolvedValueOnce(
        response(200, { results: { '000001': { success: true, tracking: 'TRK-1' } } }),
      );

      await handler.createBulkOrders([
        order({
          customer: {
            name: 'Karim Benali',
            phone: '0550123456',
            wilaya: '25',
            commune: '6a4cd74fbabdf95b0dcc686f',
            address: 'Ben Badis El haria',
          },
          dhdCommune: selection({ name: 'Ben Badis', wilayaId: '25', postalCode: '25030' }),
        }),
      ]);

      const [, init] = fetchMock.mock.calls[0];
      const sent = JSON.parse(String(init.body));
      expect(sent.orders['0'].commune).toBe('Ben Badis');
      expect(sent.orders['0'].code_wilaya).toBe('25');
      expect(sent.orders['0'].code_postal).toBe('25030');
    });
  });
});
