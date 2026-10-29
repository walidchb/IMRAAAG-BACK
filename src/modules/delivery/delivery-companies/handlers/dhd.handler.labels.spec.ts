import { DhdHandler } from './dhd.handler';

const STORE_ID = '6ac400e26b1b2c3d4e5f6a71';
const BASE = 'https://dhd.test/api/v1';
const PDF = Buffer.from('%PDF-1.7\ndhd-label');

function config(overrides: Record<string, any> = {}) {
  return {
    storeId: STORE_ID,
    vendorEmail: 'vendor@example.com',
    companies: {
      dhd: {
        status: 'enabled',
        credentials: { apiToken: 'dhd-token' },
      },
    },
    ...overrides,
  };
}

function pdfResponse(
  status: number,
  body = PDF,
  headers: Record<string, string> = {},
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === 'content-type') return 'application/pdf';
        return headers[name.toLowerCase()] ?? null;
      },
    },
    text: async () => body.toString('utf8'),
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

function errorResponse(status: number) {
  return pdfResponse(status, Buffer.from(''), { 'content-type': 'application/json' });
}

function order(orderNo: string, trackingNumber: string | null) {
  return { orderNo, parcelId: `P-${orderNo}`, trackingNumber };
}

const context = {
  storeId: STORE_ID,
  vendorEmail: 'vendor@example.com',
  format: '10x15' as const,
  timeoutMs: 1000,
  allOrdersSameCarrier: true,
};

describe('DhdHandler label capability', () => {
  let handler: DhdHandler;
  let fetchMock: jest.Mock;
  let configValue: any;
  let settings: Record<string, string>;

  beforeEach(() => {
    configValue = config();
    settings = {
      deliveryEncryptionKey: '',
      'orderLabels.dhdLabelApiBase': BASE,
      'orderLabels.dhdLabelAuthMode': 'bearer',
    };
    handler = new DhdHandler(
      {
        findOne: jest.fn(() => ({
          lean: () => ({ exec: async () => configValue }),
        })),
      } as any,
      {} as any,
      { get: jest.fn((key: string) => settings[key] ?? '') } as any,
    );
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('downloads a raw PDF with bearer auth and preserves its geometry', async () => {
    fetchMock.mockResolvedValueOnce(pdfResponse(200));

    const result = await handler.createLabels([order('A', 'DHD123')], context);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/get/order/label?tracking=DHD123`);
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer dhd-token',
      Accept: 'application/pdf',
    });
    expect(result.documents).toEqual([
      expect.objectContaining({
        orderNo: 'A',
        trackingNumber: 'DHD123',
        contentType: 'application/pdf',
        bytes: PDF,
      }),
    ]);
    expect(result.documents[0].widthMm).toBeUndefined();
    expect(result.documents[0].cropBox).toBeUndefined();
    expect(result.failures).toEqual([]);
  });

  it('uses the opt-in query-token auth mode without a bearer header', async () => {
    settings['orderLabels.dhdLabelAuthMode'] = 'query';
    fetchMock.mockResolvedValueOnce(pdfResponse(200));

    const result = await handler.createLabels([order('A', 'DHD123')], context);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('api_token=dhd-token');
    expect(init.headers.Authorization).toBeUndefined();
    expect(result.documents).toHaveLength(1);
  });

  it('URL-encodes the tracking number', async () => {
    fetchMock.mockResolvedValueOnce(pdfResponse(200));

    await handler.createLabels([order('A', 'A B&123')], context);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('tracking=A+B%26123');
  });

  it('maps 404 to a non-retryable not-found failure', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(404));

    const result = await handler.createLabels([order('A', 'DHD123')], context);

    expect(result.documents).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({
        orderNo: 'A',
        code: 'ORDER_LABEL_NOT_FOUND_AT_CARRIER',
        retryable: false,
      }),
    ]);
  });

  it('rejects a non-PDF or empty response without leaking the body', async () => {
    fetchMock.mockResolvedValueOnce(
      pdfResponse(200, Buffer.from('<html>not a pdf</html>')),
    );

    const result = await handler.createLabels([order('A', 'DHD123')], context);

    expect(result.failures).toEqual([
      expect.objectContaining({
        code: 'ORDER_LABEL_RENDER_FAILED',
        retryable: false,
        message: 'The carrier returned an invalid label file.',
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('not a pdf');
  });

  it('rejects an oversized declared label before reading it', async () => {
    fetchMock.mockResolvedValueOnce(
      pdfResponse(200, PDF, { 'content-length': String(21 * 1024 * 1024) }),
    );

    const result = await handler.createLabels([order('A', 'DHD123')], context);

    expect(result.failures).toEqual([
      expect.objectContaining({ code: 'ORDER_LABEL_RENDER_FAILED' }),
    ]);
  });

  it('reports a missing tracking number without contacting the carrier', async () => {
    const result = await handler.createLabels(
      [{ orderNo: 'A', parcelId: 'P-A', trackingNumber: null }],
      context,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.failures).toEqual([
      expect.objectContaining({
        code: 'ORDER_LABEL_TRACKING_UNAVAILABLE',
        retryable: true,
      }),
    ]);
  });

  it('maps missing credentials to a carrier failure for every printable order', async () => {
    configValue = null;

    const result = await handler.createLabels(
      [order('A', 'DHD123'), order('B', 'DHD456')],
      context,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toMatchObject({
      orderNo: 'A',
      code: 'ORDER_LABEL_CARRIER_FAILED',
      retryable: false,
    });
  });

  it('keeps one bad parcel isolated from a successful sibling', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('DHD-BAD')
        ? errorResponse(404)
        : pdfResponse(200),
    );

    const result = await handler.createLabels(
      [order('A', 'DHD-OK'), order('B', 'DHD-BAD')],
      context,
    );

    expect(result.documents.map((document) => document.orderNo)).toEqual(['A']);
    expect(result.failures).toEqual([
      expect.objectContaining({
        orderNo: 'B',
        code: 'ORDER_LABEL_NOT_FOUND_AT_CARRIER',
      }),
    ]);
  });

  it('never returns the token or URL in the result', async () => {
    fetchMock.mockResolvedValueOnce(pdfResponse(200));

    const result = await handler.createLabels([order('A', 'DHD123')], context);

    expect(JSON.stringify(result)).not.toContain('dhd-token');
    expect(JSON.stringify(result)).not.toContain(BASE);
  });
});
