import { EcomHandler } from './ecom.handler';

const STORE_ID = '6ac400e26b1b2c3d4e5f6a71';
const BASE = 'https://ecom.test/api_v2';

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
    ...overrides,
  };
}

function htmlResponse(status: number, body = '<html>label</html>') {
  const bytes = Buffer.from(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? 'text/html' : null,
    },
    text: async () => body,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

function pdfResponse(status: number, body = '%PDF-1.7\n%test\n') {
  const bytes = Buffer.from(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? 'application/pdf' : null,
    },
    text: async () => body,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

function emptyResponse(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ message: `HTTP ${status}` }),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
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

describe('EcomHandler label capability', () => {
  let handler: EcomHandler;
  let fetchMock: jest.Mock;
  let configValue: any;
  let settings: Record<string, string>;

  beforeEach(() => {
    configValue = config();
    settings = {
      deliveryEncryptionKey: '',
      'orderLabels.ecomLabelApiBase': BASE,
    };
    handler = new EcomHandler(
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

  it('maps 10x15 to the 10x13 endpoint and records the physical size', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(200));

    const result = await handler.createLabels([order('A', 'TRK-1')], context);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/colis/TRK-1/bordereau?format=10x13`);
    expect(init.headers).toMatchObject({
      'X-API-Key': 'key-123',
      'X-API-Token': 'token-456',
      Accept: 'application/pdf, text/html, */*',
    });
    expect(init.headers).not.toHaveProperty('Content-Type');
    expect(result.documents).toEqual([
      expect.objectContaining({
        orderNo: 'A',
        trackingNumber: 'TRK-1',
        contentType: 'text/html',
        widthMm: 100,
        heightMm: 130,
      }),
    ]);
    expect(result.failures).toEqual([]);
  });

  it('detects a PDF single-label response instead of treating it as HTML', async () => {
    fetchMock.mockResolvedValueOnce(pdfResponse(200));

    const result = await handler.createLabels([order('A', 'TRK-1')], context);

    expect(result.documents).toEqual([
      expect.objectContaining({
        orderNo: 'A',
        trackingNumber: 'TRK-1',
        contentType: 'application/pdf',
      }),
    ]);
  });

  it('maps 10x10 to a 100mm page', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(200));

    const result = await handler.createLabels([order('A', 'TRK-1')], {
      ...context,
      format: '10x10',
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE}/colis/TRK-1/bordereau?format=10x10`,
    );
    expect(result.documents[0]).toMatchObject({ widthMm: 100, heightMm: 100 });
  });

  it('falls back to parcelId when a tracking number is absent', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(200));

    const result = await handler.createLabels([order('A', null)], context);

    expect(fetchMock.mock.calls[0][0]).toContain('/colis/P-A/bordereau');
    expect(result.documents[0].trackingNumber).toBe('P-A');
  });

  it('uses the bulk endpoint only for native and passes page order through', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(200, '<html>pages</html>'));

    const result = await handler.createLabels(
      [order('A', 'TRK-1'), order('B', 'TRK-2')],
      { ...context, format: 'native' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/colis/bordereaux`);
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Accept: 'application/pdf, text/html, */*',
    });
    expect(JSON.parse(init.body)).toEqual({
      trackings: ['TRK-1', 'TRK-2'],
      format: '10x13',
    });
    expect(result.documents).toEqual([
      expect.objectContaining({
        orderNo: 'A',
        orderNos: ['A', 'B'],
        trackingNumbers: ['TRK-1', 'TRK-2'],
        sheet: true,
        contentType: 'text/html',
      }),
    ]);
  });

  it('detects a PDF bulk response', async () => {
    fetchMock.mockResolvedValueOnce(pdfResponse(200));

    const result = await handler.createLabels(
      [order('A', 'TRK-1'), order('B', 'TRK-2')],
      { ...context, format: 'native' },
    );

    expect(result.documents).toEqual([
      expect.objectContaining({
        orderNos: ['A', 'B'],
        sheet: true,
        contentType: 'application/pdf',
      }),
    ]);
  });

  it('falls back to singles when the native bulk endpoint is refused', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(400))
      .mockResolvedValueOnce(htmlResponse(200, '<html>A</html>'))
      .mockResolvedValueOnce(htmlResponse(200, '<html>B</html>'));

    const result = await handler.createLabels(
      [order('A', 'TRK-1'), order('B', 'TRK-2')],
      { ...context, format: 'native' },
    );

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/colis/bordereaux`);
    expect(result.documents.map((document) => document.orderNo)).toEqual([
      'A',
      'B',
    ]);
    expect(result.documents.every((document) => !document.sheet)).toBe(true);
  });

  it('maps a 404 to a non-retryable missing-label failure', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(404));

    const result = await handler.createLabels([order('A', 'TRK-1')], context);

    expect(result.documents).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({
        orderNo: 'A',
        code: 'ORDER_LABEL_NOT_FOUND_AT_CARRIER',
        retryable: false,
      }),
    ]);
  });

  it('maps a 422 to an unsupported-layout failure', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(422));

    const result = await handler.createLabels([order('A', 'TRK-1')], context);

    expect(result.failures).toEqual([
      expect.objectContaining({
        code: 'ORDER_LABEL_LAYOUT_UNSUPPORTED',
        retryable: false,
      }),
    ]);
  });

  it('reports missing tracking without contacting the carrier', async () => {
    const result = await handler.createLabels(
      [{ orderNo: 'A', parcelId: '', trackingNumber: null }],
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

  it('maps missing credentials to a carrier failure for every printable order', async () => {
    configValue = config();
    configValue.companies['ecom-delivery'].credentials = {};

    const result = await handler.createLabels(
      [order('A', 'TRK-1'), order('B', 'TRK-2')],
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
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('TRK-BAD')) return emptyResponse(404);
      return htmlResponse(200);
    });

    const result = await handler.createLabels(
      [order('A', 'TRK-OK'), order('B', 'TRK-BAD')],
      context,
    );

    expect(result.documents.map((document) => document.orderNo)).toEqual(['A']);
    expect(result.failures).toEqual([
      expect.objectContaining({ orderNo: 'B', code: 'ORDER_LABEL_NOT_FOUND_AT_CARRIER' }),
    ]);
  });
});
