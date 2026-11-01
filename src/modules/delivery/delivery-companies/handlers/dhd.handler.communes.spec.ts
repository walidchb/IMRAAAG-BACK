import { AppException } from '../../../../common/errors/app-exception';
import { AppErrorCode } from '../../../../common/errors/error-codes.enum';
import { DhdHandler, normalizeDhdCommunes } from './dhd.handler';

const STORE_ID = '6ac400e26b1b2c3d4e5f6a71';

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

describe('normalizeDhdCommunes', () => {
  it('normalizes array envelope, sorts by name, and filters inactive', () => {
    const raw = [
      { nom: 'Batna', wilaya_id: 5, code_postal: '05001', has_stop_desk: 1, is_active: 1 },
      { nom: 'Ain Djasser', wilaya_id: 5, code_postal: '05018', has_stop_desk: 0, is_active: 1 },
      { nom: 'Inactive Commune', wilaya_id: 5, code_postal: '05999', has_stop_desk: 0, is_active: 0 },
      { nom: 'Alger Centre', wilaya_id: 16, code_postal: '16000', has_stop_desk: 1, is_active: 1 },
    ];

    const result = normalizeDhdCommunes(raw, '5');

    expect(result).toEqual([
      { name: 'Ain Djasser', wilayaId: '5', postalCode: '05018', hasStopDesk: false },
      { name: 'Batna', wilayaId: '5', postalCode: '05001', hasStopDesk: true },
    ]);
  });

  it('normalizes object envelope and wrapped data envelope', () => {
    const raw = {
      data: {
        '0': { nom: 'Oran', wilaya_id: 31, code_postal: '31000', has_stop_desk: 1, is_active: 1 },
        '1': { nom: 'Arzew', wilaya_id: 31, code_postal: null, has_stop_desk: 0, is_active: true },
      },
    };

    const result = normalizeDhdCommunes(raw, '31');

    expect(result).toEqual([
      { name: 'Arzew', wilayaId: '31', postalCode: null, hasStopDesk: false },
      { name: 'Oran', wilayaId: '31', postalCode: '31000', hasStopDesk: true },
    ]);
  });

  it('deduplicates entries by case-insensitive name, keeping first', () => {
    const raw = [
      { nom: 'Batna', wilaya_id: 5, code_postal: '05001', has_stop_desk: 1, is_active: 1 },
      { nom: 'batna', wilaya_id: 5, code_postal: '05002', has_stop_desk: 1, is_active: 1 },
      { nom: 'BATNA', wilaya_id: 5, code_postal: '05003', has_stop_desk: 1, is_active: 1 },
    ];

    const result = normalizeDhdCommunes(raw, '5');

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'Batna',
      wilayaId: '5',
      postalCode: '05001',
      hasStopDesk: true,
    });
  });
});

describe('DhdHandler.listCommunes', () => {
  let handler: DhdHandler;
  let findOne: jest.Mock;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    findOne = jest.fn(() => ({
      lean: () => ({ exec: async () => config() }),
    }));
    handler = new DhdHandler(
      { findOne } as any,
      {} as any,
      { get: (key: string) => '' } as any,
    );
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches communes for a wilaya and returns normalized list', async () => {
    fetchMock.mockResolvedValueOnce(
      response(200, [
        { nom: 'Batna', wilaya_id: 5, code_postal: '05001', has_stop_desk: 1, is_active: 1 },
        { nom: 'Barika', wilaya_id: 5, code_postal: '05002', has_stop_desk: 1, is_active: 1 },
      ]),
    );

    const result = await handler.listCommunes('5', { storeId: STORE_ID });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, req] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/get/communes?wilaya_id=5');
    expect(req.headers.Authorization).toBe('Bearer token-secret');
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Barika');
    expect(result[1].name).toBe('Batna');
  });

  it('unwraps 422 error from carrier into DELIVERY_API_ERROR', async () => {
    fetchMock.mockResolvedValueOnce(
      response(422, { message: 'Wilaya not found' }),
    );

    await expect(
      handler.listCommunes('99', { storeId: STORE_ID }),
    ).rejects.toMatchObject({
      errorCode: AppErrorCode.DELIVERY_API_ERROR,
    });
  });

  it('throws DELIVERY_CREDENTIALS_NOT_CONFIGURED when store has no DHD credentials', async () => {
    findOne.mockReturnValueOnce({
      lean: () => ({ exec: async () => null }),
    });

    await expect(
      handler.listCommunes('5', { storeId: STORE_ID }),
    ).rejects.toMatchObject({
      errorCode: AppErrorCode.DELIVERY_CREDENTIALS_NOT_CONFIGURED,
    });
  });
});
