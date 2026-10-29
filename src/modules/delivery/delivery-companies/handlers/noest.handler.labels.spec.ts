import { PDFDocument } from 'pdf-lib';
import { NoestHandler } from './noest.handler';

const STORE_ID = '6abd12d59676e6a09f1e7ad2';
const BASE = 'https://noest.test';
const A4 = { width: 595.28, height: 841.89 };
const PT_TO_MM = 25.4 / 72;

async function pdfPage(width: number, height: number): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([width, height]);
  return Buffer.from(await pdf.save());
}

function response(
  status: number,
  body: Buffer,
  headers: Record<string, string> = {},
) {
  const merged: Record<string, string> = {
    'content-type': 'application/pdf',
    ...headers,
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => merged[name.toLowerCase()] ?? null,
    },
    text: async () => body.toString('utf8'),
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

function errorResponse(status: number) {
  return response(
    status,
    Buffer.from('{"message":"The given data was invalid."}'),
    { 'content-type': 'application/json' },
  );
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

describe('NoestHandler label capability', () => {
  let handler: NoestHandler;
  let fetchMock: jest.Mock;
  let configValue: any;
  let settings: Record<string, any>;
  let a4Pdf: Buffer;
  let labelPdf: Buffer;

  beforeAll(async () => {
    a4Pdf = await pdfPage(A4.width, A4.height);
    labelPdf = await pdfPage(100 / PT_TO_MM, 150 / PT_TO_MM);
  });

  beforeEach(() => {
    configValue = {
      storeId: STORE_ID,
      vendorEmail: 'vendor@example.com',
      companies: {
        noest: {
          status: 'enabled',
          credentials: { apiToken: 'noest-token', guid: 'noest-guid' },
        },
      },
    };
    settings = {
      deliveryEncryptionKey: '',
      'orderLabels.noestLabelApiBase': BASE,
      'orderLabels.carrierConcurrency': 2,
    };
    handler = new NoestHandler(
      {
        findOne: jest.fn(() => ({
          lean: async () => configValue,
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

  it('downloads a PDF with bearer auth and crops the verified A4 slip region', async () => {
    fetchMock.mockResolvedValueOnce(response(200, a4Pdf));

    const result = await handler.createLabels([order('000950', '5RD-35A-21799830')], context);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/public/get/order/label?tracking=5RD-35A-21799830`);
    expect(url).not.toContain('user_guid');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer noest-token',
      Accept: 'application/pdf',
    });
    expect(result.failures).toEqual([]);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({
      orderNo: '000950',
      trackingNumber: '5RD-35A-21799830',
      contentType: 'application/pdf',
      widthMm: 100.8,
      heightMm: 143.5,
      cropBox: {
        x: 7.5,
        y: 427.714,
        width: 285.837,
        height: 406.676,
      },
    });
  });

  it('passes a non-A4 label through uncropped and reports its size', async () => {
    fetchMock.mockResolvedValueOnce(response(200, labelPdf));

    const result = await handler.createLabels([order('A', 'NOE-1')], context);

    expect(result.documents[0].cropBox).toBeUndefined();
    expect(result.documents[0].widthMm).toBeCloseTo(100, 1);
    expect(result.documents[0].heightMm).toBeCloseTo(150, 1);
  });

  it('trims and URL-encodes the tracking number', async () => {
    fetchMock.mockResolvedValueOnce(response(200, labelPdf));

    await handler.createLabels([order('A', '  A B&123  ')], context);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('tracking=A+B%26123');
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
        retryable: true,
      }),
    ]);
  });

  it('maps missing credentials to a non-retryable failure for every printable order', async () => {
    configValue = null;

    const result = await handler.createLabels(
      [order('A', 'NOE-1'), order('B', 'NOE-2')],
      context,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toMatchObject({
      orderNo: 'A',
      code: 'ORDER_LABEL_CARRIER_FAILED',
      retryable: false,
      message: 'Noest credentials are not configured for this store.',
    });
  });

  it.each([404, 400, 422])(
    'maps HTTP %s to a non-retryable not-found failure',
    async (status) => {
      fetchMock.mockResolvedValueOnce(errorResponse(status));

      const result = await handler.createLabels([order('A', 'NOE-1')], context);

      expect(result.documents).toEqual([]);
      expect(result.failures).toEqual([
        expect.objectContaining({
          orderNo: 'A',
          code: 'ORDER_LABEL_NOT_FOUND_AT_CARRIER',
          retryable: false,
        }),
      ]);
    },
  );

  it('keeps 429 retryable and reports the rate limit', async () => {
    fetchMock.mockResolvedValueOnce(
      response(429, Buffer.from('{}'), {
        'content-type': 'application/json',
        'retry-after': '120',
      }),
    );

    const result = await handler.createLabels([order('A', 'NOE-1')], context);

    expect(result.failures).toEqual([
      expect.objectContaining({
        code: 'ORDER_LABEL_CARRIER_FAILED',
        retryable: true,
        message: 'The carrier rate limit was reached. Retry in a few minutes.',
      }),
    ]);
  });

  it('rejects a non-PDF body without leaking it', async () => {
    fetchMock.mockResolvedValueOnce(
      response(200, Buffer.from('<html>not a pdf</html>')),
    );

    const result = await handler.createLabels([order('A', 'NOE-1')], context);

    expect(result.failures).toEqual([
      expect.objectContaining({
        code: 'ORDER_LABEL_RENDER_FAILED',
        retryable: false,
        message: 'The carrier returned an invalid label file.',
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('not a pdf');
  });

  it('rejects an unreadable PDF that only carries the magic bytes', async () => {
    fetchMock.mockResolvedValueOnce(response(200, Buffer.from('%PDF-1.7 broken')));

    const result = await handler.createLabels([order('A', 'NOE-1')], context);

    expect(result.failures).toEqual([
      expect.objectContaining({
        code: 'ORDER_LABEL_RENDER_FAILED',
        retryable: false,
      }),
    ]);
  });

  it('rejects an oversized declared label before reading it', async () => {
    fetchMock.mockResolvedValueOnce(
      response(200, a4Pdf, { 'content-length': String(11 * 1024 * 1024) }),
    );

    const result = await handler.createLabels([order('A', 'NOE-1')], context);

    expect(result.failures).toEqual([
      expect.objectContaining({ code: 'ORDER_LABEL_RENDER_FAILED' }),
    ]);
  });

  it('keeps one bad parcel isolated from a successful sibling', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('NOE-BAD')
        ? errorResponse(404)
        : response(200, a4Pdf),
    );

    const result = await handler.createLabels(
      [order('A', 'NOE-OK'), order('B', 'NOE-BAD')],
      context,
    );

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].orderNo).toBe('A');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ orderNo: 'B', code: 'ORDER_LABEL_NOT_FOUND_AT_CARRIER' });
  });

  it('never returns the API token in the result', async () => {
    fetchMock.mockResolvedValueOnce(response(200, a4Pdf));

    const result = await handler.createLabels([order('A', 'NOE-1')], context);

    expect(JSON.stringify(result)).not.toContain('noest-token');
    expect(JSON.stringify(result)).not.toContain('noest-guid');
  });
});
