import { ZrExpressHandler } from './zr-express.handler';

const STORE_ID = '6ac400e26b1b2c3d4e5f6a71';
const BASE = 'https://zr.test/api/v1';
const PDF = Buffer.from('%PDF-1.7\nlabel');

function config(overrides: Record<string, any> = {}) {
  return {
    storeId: STORE_ID,
    vendorEmail: 'vendor@example.com',
    companies: {
      'zr-express': {
        status: 'enabled',
        credentials: { apiKey: 'zr-key', tenantId: 'tenant-1' },
      },
    },
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)).buffer,
  } as unknown as Response;
}

function binaryResponse(
  status: number,
  body: Buffer,
  contentType: string,
  headers: Record<string, string> = {},
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === 'content-type') return contentType;
        return headers[name.toLowerCase()] ?? null;
      },
    },
    text: async () => body.toString('utf8'),
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

function order(orderNo: string, trackingNumber: string) {
  return { orderNo, parcelId: `P-${orderNo}`, trackingNumber };
}

const context = {
  storeId: STORE_ID,
  vendorEmail: 'vendor@example.com',
  format: 'native' as const,
  timeoutMs: 1000,
  allOrdersSameCarrier: true,
};

describe('ZrExpressHandler label capability', () => {
  let handler: ZrExpressHandler;
  let fetchMock: jest.Mock;
  let configValue: any;
  let settings: Record<string, string>;

  beforeEach(() => {
    configValue = config();
    settings = {
      deliveryEncryptionKey: '',
      'orderLabels.zrLabelApiBase': BASE,
    };
    handler = new ZrExpressHandler(
      {
        findOne: jest.fn(() => ({
          lean: () => ({ exec: async () => configValue }),
        })),
      } as any,
      {} as any,
      {} as any,
      { get: jest.fn((key: string) => settings[key] ?? '') } as any,
    );
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('prepares tracking numbers from status discovery', async () => {
    const search = jest.spyOn(handler, 'searchStatusParcels').mockResolvedValue({
      parcels: [
        {
          parcelId: 'P-A',
          trackingNumber: 'TRACK-A',
        } as any,
        {
          parcelId: 'P-B',
          trackingNumber: null,
        } as any,
      ],
      totalCount: 2,
      hasNext: false,
    });

    const result = await handler.prepareLabels(
      [
        { orderNo: 'A', parcelId: 'P-A', trackingNumber: null },
        { orderNo: 'B', parcelId: 'P-B', trackingNumber: null },
      ],
      { storeId: STORE_ID, vendorEmail: 'vendor@example.com', timeoutMs: 1000 },
    );

    expect(search).toHaveBeenCalledWith({
      storeId: STORE_ID,
      vendorEmail: 'vendor@example.com',
      parcelIds: ['P-A', 'P-B'],
      limit: 2,
    });
    expect(result.orders).toEqual([
      { orderNo: 'A', parcelId: 'P-A', trackingNumber: 'TRACK-A' },
      { orderNo: 'B', parcelId: 'P-B', trackingNumber: null },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requests the multiple sheet with bearer auth and maps failed trackings', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          fileUrl: 'https://files.test/zr-sheet.pdf',
          failedTrackingNumbers: [{ trackingNumber: 'TRK-2' }],
        }),
      )
      .mockResolvedValueOnce(binaryResponse(200, PDF, 'application/pdf'));

    const result = await handler.createLabels(
      [order('A', 'TRK-1'), order('B', 'TRK-2')],
      context,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/parcels/labels/multiple`);
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer zr-key',
      'X-Tenant': 'tenant-1',
    });
    expect(JSON.parse(init.body)).toEqual({ trackingNumbers: ['TRK-1', 'TRK-2'] });
    expect(fetchMock.mock.calls[1][0]).toBe('https://files.test/zr-sheet.pdf');

    expect(result.documents).toEqual([
      expect.objectContaining({
        orderNo: 'A',
        orderNos: ['A'],
        trackingNumbers: ['TRK-1'],
        contentType: 'application/pdf',
        sheet: true,
      }),
    ]);
    expect(result.failures).toEqual([
      expect.objectContaining({ orderNo: 'B', trackingNumber: 'TRK-2' }),
    ]);
    expect(result.warnings?.[0]).toMatchObject({ code: 'ORDER_LABEL_NATIVE_SHEET' });
  });

  it('retries once with X-Api-Key when bearer auth is rejected', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { message: 'unauthorized' }))
      .mockResolvedValueOnce(
        jsonResponse(200, { fileUrl: 'https://files.test/zr.html' }),
      )
      .mockResolvedValueOnce(binaryResponse(200, Buffer.from('<html>'), 'text/html'));

    const result = await handler.createLabels([order('A', 'TRK-1')], context);

    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer zr-key',
    });
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
      'X-Api-Key': 'zr-key',
      'X-Tenant': 'tenant-1',
    });
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBeUndefined();
    expect(result.documents[0].contentType).toBe('text/html');
  });

  it('requests individual labels, downloads each file, and crops the sheet', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/parcels/labels/individual')) {
        const trackings = JSON.parse(String(init?.body)).trackingNumbers as string[];
        return jsonResponse(200, {
          parcelLabelFiles: trackings.map((tracking) => ({
            trackingNumber: tracking,
            fileUrl: `https://files.test/${tracking}.html`,
          })),
        });
      }
      return binaryResponse(200, Buffer.from(`<html>${url}</html>`), 'text/html');
    });

    const result = await handler.createLabels([order('A', 'TRK-1')], {
      ...context,
      format: '10x15',
    });

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/parcels/labels/individual`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      trackingNumbers: ['TRK-1'],
    });
    expect(result.documents[0]).toMatchObject({
      orderNo: 'A',
      trackingNumber: 'TRK-1',
      widthMm: 105,
      heightMm: 148.5,
      sheet: true,
      cropBox: expect.objectContaining({ x: 0, width: expect.any(Number) }),
    });
    expect((result.documents[0] as any).cropBox.height).toBeCloseTo(148.5 * (72 / 25.4), 2);
  });

  it('chunks individual requests at 50 and preserves requested order', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/parcels/labels/individual')) {
        const trackings = JSON.parse(String(init?.body)).trackingNumbers as string[];
        return jsonResponse(200, {
          files: trackings
            .slice()
            .reverse()
            .map((tracking) => ({
              trackingNumber: tracking,
              url: `https://files.test/${tracking}.pdf`,
            })),
        });
      }
      return binaryResponse(200, PDF, 'application/pdf');
    });
    const orders = Array.from({ length: 51 }, (_, index) =>
      order(`ORD-${index + 1}`, `TRK-${index + 1}`),
    );

    const result = await handler.createLabels(orders, { ...context, format: '10x13' });

    const posts = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/parcels/labels/individual'),
    );
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[0][1].body).trackingNumbers).toHaveLength(50);
    expect(JSON.parse(posts[1][1].body).trackingNumbers).toEqual(['TRK-51']);
    expect(result.documents).toHaveLength(51);
    expect(result.documents.map((document) => document.orderNo)).toEqual(
      orders.map((item) => item.orderNo),
    );
    expect(result.failures).toEqual([]);
  });

  it('reports a missing tracking number without contacting the carrier', async () => {
    const result = await handler.createLabels(
      [{ orderNo: 'A', parcelId: 'P-A', trackingNumber: null }],
      context,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.failures).toEqual([
      expect.objectContaining({
        orderNo: 'A',
        code: 'ORDER_LABEL_TRACKING_UNAVAILABLE',
      }),
    ]);
  });

  it('maps missing credentials to a non-retryable carrier failure', async () => {
    configValue = config();
    delete configValue.companies['zr-express'].credentials.apiKey;

    const result = await handler.createLabels([order('A', 'TRK-1')], context);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.failures).toEqual([
      expect.objectContaining({
        orderNo: 'A',
        code: 'ORDER_LABEL_CARRIER_FAILED',
        retryable: false,
      }),
    ]);
  });

  it('does not leak a SAS URL or token into the returned document', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { fileUrl: 'https://files.test/secret-sas?token=abc' }),
      )
      .mockResolvedValueOnce(binaryResponse(200, PDF, 'application/pdf'));

    const result = await handler.createLabels([order('A', 'TRK-1')], context);

    expect(JSON.stringify(result)).not.toContain('secret-sas');
    expect(JSON.stringify(result)).not.toContain('zr-key');
  });
});
