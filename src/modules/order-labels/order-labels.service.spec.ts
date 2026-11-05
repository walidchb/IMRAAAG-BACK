import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { OrderStatus } from '../../common/constants/order-statuses.const';
import { Role } from '../../common/constants/roles.enum';
import { OrderLabelsService } from './order-labels.service';

const STORE_ID = '6ac400e26b1b2c3d4e5f6a71';
const OTHER_STORE_ID = '6ac400e26b1b2c3d4e5f6a72';
const JOB_ID = '7c1f2a50-1234-4abc-8def-1234567890ab';

function orderId(index: number): string {
  return `6ac400e26b1b2c3d4e5f${index.toString(16).padStart(4, '0')}`;
}

function order(index: number, overrides: Record<string, unknown> = {}) {
  return {
    _id: orderId(index),
    orderNo: `ORD-${index}`,
    storeId: STORE_ID,
    vendorEmail: 'vendor@example.com',
    deliveryCompanyId: 'dhd',
    deliveryParcelId: `DHD${index}`,
    status: { slug: OrderStatus.DISPATCHED },
    ...overrides,
  };
}

function labelDocument(orderNo: string, trackingNumber: string) {
  return {
    orderNo,
    orderNos: [orderNo],
    trackingNumber,
    trackingNumbers: [trackingNumber],
    contentType: 'application/pdf' as const,
    bytes: Buffer.from('%PDF-1.7'),
    widthMm: 100,
    heightMm: 150,
  };
}

function labelsHandler() {
  return {
    createLabels: jest.fn(async (orders: Array<{ orderNo: string; trackingNumber: string }>) => ({
      documents: orders.map((item) => labelDocument(item.orderNo, item.trackingNumber)),
    })),
  };
}

interface Harness {
  service: OrderLabelsService;
  orderModel: { find: jest.Mock };
  stores: {
    findByVendorIdOrThrow: jest.Mock;
    findOne: jest.Mock;
    resolveStoreIdByEmail: jest.Mock;
  };
  registry: {
    getHandler: jest.Mock;
    getLabelCapableCompanyIds: jest.Mock;
  };
  renderer: { render: jest.Mock };
  composer: { compose: jest.Mock };
  artifact: { assertConfigured: jest.Mock; put: jest.Mock; stream: jest.Mock };
  handlers: Record<string, any>;
  configValues: Record<string, unknown>;
}

function setup(docs: any[] = [], harnessHandlers: Record<string, any> = {}): Harness {
  const orderModel = {
    find: jest.fn(() => ({
      lean: () => ({ exec: async () => docs }),
    })),
  };
  const stores = {
    findByVendorIdOrThrow: jest.fn(async () => ({
      _id: STORE_ID,
      vendorEmail: 'vendor@example.com',
    })),
    findOne: jest.fn(async () => ({ _id: STORE_ID, vendorEmail: 'vendor@example.com' })),
    resolveStoreIdByEmail: jest.fn(async () => STORE_ID),
  };
  const handlers: Record<string, any> = {
    dhd: labelsHandler(),
    ecom: labelsHandler(),
    'zr-express': labelsHandler(),
    noest: labelsHandler(),
    ...harnessHandlers,
  };
  const registry = {
    getHandler: jest.fn((id: string) => handlers[id] ?? null),
    getLabelCapableCompanyIds: jest.fn(() =>
      Object.entries(handlers)
        .filter(([, handler]) => typeof (handler as any).createLabels === 'function')
        .map(([id]) => id)
        .sort(),
    ),
  };
  const renderer = {
    render: jest.fn(async (document: { orderNo: string }) => ({
      bytes: Buffer.from('%PDF-1.7'),
      pageCount: 1,
      pageWidthPt: 283,
      pageHeightPt: 425,
      orderNo: document.orderNo,
    })),
  };
  const composer = {
    compose: jest.fn(async (_format: string, labels: Array<{ orderNo: string }>) => ({
      bytes: Buffer.from('%PDF-1.7'),
      pageCount: labels.length,
      pagesByOrder: new Map(labels.map((label) => [label.orderNo, 1])),
      warnings: [],
    })),
  };
  const artifact = {
    assertConfigured: jest.fn(),
    put: jest.fn(async () => 'key'),
    stream: jest.fn(async () => ({
      body: Buffer.from('%PDF-1.7'),
      contentType: 'application/pdf',
      contentLength: 8,
      contentDisposition: 'attachment',
    })),
  };
  const configValues: Record<string, unknown> = {
    'orderLabels.enabled': true,
    'orderLabels.maxOrders': 100,
    'orderLabels.renderConcurrency': 2,
    'orderLabels.jobTimeoutMs': 90000,
    'orderLabels.artifactTtlHours': 24,
  };
  const config = {
    get: jest.fn((key: string) => configValues[key]),
  };
  const service = new OrderLabelsService(
    orderModel as any,
    stores as any,
    registry as any,
    renderer as any,
    composer as any,
    artifact as any,
    config as any,
  );
  return {
    service,
    orderModel,
    stores,
    registry,
    renderer,
    composer,
    artifact,
    handlers,
    configValues,
  };
}

const vendor = { id: 'vendor-1', email: 'vendor@example.com', role: Role.VENDOR, fullName: 'V' };
const admin = { id: 'admin-1', email: 'admin@example.com', role: Role.ADMIN, fullName: 'A' };
const LABEL_CARRIERS = ['dhd', 'ecom', 'noest', 'zr-express'];

describe('OrderLabelsService.availability', () => {
  it('does not resolve a store when the feature is globally disabled', async () => {
    const harness = setup();
    harness.configValues['orderLabels.enabled'] = false;

    await expect(harness.service.availability(vendor)).resolves.toEqual({
      enabled: false,
      carriers: [],
    });
    expect(harness.stores.findByVendorIdOrThrow).not.toHaveBeenCalled();
  });

  it('enables label printing for every vendor when the global flag is on', async () => {
    const harness = setup();

    await expect(harness.service.availability(vendor)).resolves.toEqual({
      enabled: true,
      carriers: LABEL_CARRIERS,
    });
    expect(harness.stores.findByVendorIdOrThrow).not.toHaveBeenCalled();
  });

  it('reports availability and label-capable carriers to an admin', async () => {
    const harness = setup();

    await expect(harness.service.availability(admin)).resolves.toEqual({
      enabled: true,
      carriers: LABEL_CARRIERS,
    });
    expect(harness.stores.findByVendorIdOrThrow).not.toHaveBeenCalled();
  });
});

describe('OrderLabelsService.generate', () => {
  it('resolves the store from the vendor session and scopes the order query', async () => {
    const harness = setup([order(1)]);
    const response = await harness.service.generate(
      { ids: [orderId(1)], format: '10x15', grouping: 'combined' },
      vendor,
    );

    expect(harness.stores.findByVendorIdOrThrow).toHaveBeenCalledWith('vendor-1');
    expect(harness.orderModel.find).toHaveBeenCalledWith({
      _id: { $in: [expect.anything()] },
      isDeleted: { $ne: true },
      $or: [{ storeId: STORE_ID }, { vendorEmail: 'vendor@example.com' }],
    });
    expect(response.summary).toMatchObject({ requested: 1, printed: 1, failed: 0, skipped: 0 });
    expect(response.downloadUrl).toBe(`/api/orders/labels/${response.jobId}/labels.pdf`);
    expect(harness.artifact.put).toHaveBeenCalledWith(
      STORE_ID,
      response.jobId,
      'labels.pdf',
      expect.any(Buffer),
      'application/pdf',
    );
  });

  it('passes a Noest crop box through rendering and composition unchanged', async () => {
    const cropBox = { x: 7.5, y: 427.714, width: 285.837, height: 406.676 };
    const handler = {
      createLabels: jest.fn(async () => ({
        documents: [
          {
            orderNo: 'ORD-1',
            trackingNumber: '5RD-35A-21799830',
            contentType: 'application/pdf',
            bytes: Buffer.from('%PDF-1.7'),
            cropBox,
            widthMm: 100.8,
            heightMm: 143.5,
          },
        ],
        failures: [],
      })),
    };
    const harness = setup(
      [order(1, { deliveryCompanyId: 'noest', deliveryParcelId: '5RD-35A-21799830' })],
      { noest: handler },
    );

    const response = await harness.service.generate(
      { ids: [orderId(1)], format: '10x15', grouping: 'combined' },
      vendor,
    );

    expect(handler.createLabels).toHaveBeenCalledWith(
      [
        {
          orderNo: 'ORD-1',
          parcelId: '5RD-35A-21799830',
          trackingNumber: '5RD-35A-21799830',
        },
      ],
      expect.objectContaining({ storeId: STORE_ID, format: '10x15' }),
    );
    expect(harness.composer.compose).toHaveBeenCalledWith(
      '10x15',
      [
        expect.objectContaining({
          orderNo: 'ORD-1',
          companyId: 'noest',
          document: expect.objectContaining({
            cropBox,
            widthMm: 100.8,
            heightMm: 143.5,
          }),
        }),
      ],
    );
    expect(response.summary).toMatchObject({ printed: 1, failed: 0 });
  });

  it('rejects an admin batch that spans more than one store', async () => {
    const harness = setup([
      order(1),
      order(2, { storeId: OTHER_STORE_ID, vendorEmail: 'other@example.com' }),
    ]);

    await expect(
      harness.service.generate(
        { ids: [orderId(1), orderId(2)], format: '10x15', grouping: 'combined' },
        admin,
      ),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.ORDER_LABEL_MIXED_STORES });
    expect(harness.registry.getHandler).not.toHaveBeenCalled();
    expect(harness.artifact.put).not.toHaveBeenCalled();
  });

  it('reports every ineligible order and throws when nothing can be printed', async () => {
    const harness = setup([
      order(1, { status: { slug: OrderStatus.PLACED } }),
      order(2, { status: { slug: OrderStatus.CANCELLED } }),
      order(3, { deliveryCompanyId: null }),
      order(4, { deliveryCompanyId: 'unsupported-carrier' }),
      order(5, { deliveryParcelId: null }),
    ]);

    let error: AppException | undefined;
    try {
      await harness.service.generate(
        {
          ids: [orderId(1), orderId(2), orderId(3), orderId(4), orderId(5)],
          format: '10x15',
          grouping: 'combined',
        },
        vendor,
      );
    } catch (err) {
      error = err as AppException;
    }

    expect(error?.errorCode).toBe(AppErrorCode.ORDER_LABEL_NOTHING_ELIGIBLE);
    expect((error?.errorParams.skipped as any[]).map((item) => item.code)).toEqual([
      'ORDER_LABEL_PRE_DISPATCH',
      'ORDER_LABEL_CANCELLED',
      'ORDER_LABEL_NO_DELIVERY_COMPANY',
      'ORDER_LABEL_UNSUPPORTED_CARRIER',
      'ORDER_LABEL_MISSING_PARCEL',
    ]);
    expect(harness.artifact.put).not.toHaveBeenCalled();
  });

  it('collapses duplicate tracking numbers and prints only the first order', async () => {
    const harness = setup([
      order(1, { deliveryParcelId: 'SAME' }),
      order(2, { deliveryParcelId: 'SAME' }),
    ]);
    const response = await harness.service.generate(
      { ids: [orderId(1), orderId(2)], format: '10x15', grouping: 'combined' },
      vendor,
    );

    expect(response.summary).toMatchObject({ requested: 2, printed: 1, skipped: 1 });
    expect(response.skipped[0]).toMatchObject({
      orderNo: 'ORD-2',
      code: 'ORDER_LABEL_DUPLICATE_TRACKING',
      printedByOrderNo: 'ORD-1',
    });
    expect(harness.handlers.dhd.createLabels).toHaveBeenCalledTimes(1);
    expect(harness.handlers.dhd.createLabels.mock.calls[0][0]).toHaveLength(1);
  });

  it('asks a carrier to prepare printable references before requesting labels', async () => {
    const acme = {
      createLabels: labelsHandler().createLabels,
      prepareLabels: jest.fn(async (orders: Array<{ parcelId: string }>) => ({
        orders: orders.map((item) => ({
          ...item,
          trackingNumber: item.parcelId === 'A1' ? 'TRACK-A1' : null,
        })),
      })),
    };
    const harness = setup(
      [
        order(1, { deliveryCompanyId: 'acme', deliveryParcelId: 'A1' }),
        order(2, { deliveryCompanyId: 'acme', deliveryParcelId: 'A2' }),
      ],
      { acme },
    );

    const response = await harness.service.generate(
      { ids: [orderId(1), orderId(2)], format: '10x15', grouping: 'combined' },
      vendor,
    );

    expect(acme.prepareLabels).toHaveBeenCalledWith(
      [
        { orderNo: 'ORD-1', parcelId: 'A1', trackingNumber: null },
        { orderNo: 'ORD-2', parcelId: 'A2', trackingNumber: null },
      ],
      {
        storeId: STORE_ID,
        vendorEmail: 'vendor@example.com',
        timeoutMs: expect.any(Number),
      },
    );
    expect(acme.createLabels.mock.calls[0][0]).toEqual([
      { orderNo: 'ORD-1', parcelId: 'A1', trackingNumber: 'TRACK-A1' },
    ]);
    expect(response.summary).toMatchObject({ printed: 1, skipped: 1 });
    expect(response.skipped[0]).toMatchObject({
      orderNo: 'ORD-2',
      code: 'ORDER_LABEL_TRACKING_UNAVAILABLE',
    });
  });

  it('isolates a per-order preparation failure and still prints the rest', async () => {
    const acme = {
      createLabels: labelsHandler().createLabels,
      prepareLabels: jest.fn(async () => ({
        orders: [{ orderNo: 'ORD-1', parcelId: 'A1', trackingNumber: 'TRACK-A1' }],
        failures: [
          {
            orderNo: 'ORD-2',
            trackingNumber: null,
            code: 'ORDER_LABEL_CARRIER_FAILED',
            message: 'Carrier rejected this parcel.',
            retryable: false,
          },
        ],
      })),
    };
    const harness = setup(
      [
        order(1, { deliveryCompanyId: 'acme', deliveryParcelId: 'A1' }),
        order(2, { deliveryCompanyId: 'acme', deliveryParcelId: 'A2' }),
      ],
      { acme },
    );

    const response = await harness.service.generate(
      { ids: [orderId(1), orderId(2)], format: '10x15', grouping: 'combined' },
      vendor,
    );

    expect(acme.createLabels.mock.calls[0][0]).toEqual([
      { orderNo: 'ORD-1', parcelId: 'A1', trackingNumber: 'TRACK-A1' },
    ]);
    expect(response.summary).toMatchObject({ requested: 2, printed: 1, failed: 1 });
    expect(response.failed[0]).toMatchObject({
      orderNo: 'ORD-2',
      code: 'ORDER_LABEL_CARRIER_FAILED',
      retryable: false,
    });
    expect(response.downloadUrl).not.toBeNull();
  });

  it('returns a 200-style failure response when carrier preparation fails', async () => {
    const acme = {
      createLabels: jest.fn(),
      prepareLabels: jest.fn(async () => {
        throw new AppException(AppErrorCode.DELIVERY_API_TIMEOUT);
      }),
    };
    const harness = setup(
      [order(1, { deliveryCompanyId: 'acme', deliveryParcelId: 'A1' })],
      { acme },
    );

    const response = await harness.service.generate(
      { ids: [orderId(1)], format: '10x15', grouping: 'combined' },
      vendor,
    );

    expect(response.downloadUrl).toBeNull();
    expect(response.fileName).toBeNull();
    expect(response.summary).toMatchObject({ requested: 1, printed: 0, failed: 1 });
    expect(response.failed[0]).toMatchObject({
      orderNo: 'ORD-1',
      code: 'ORDER_LABEL_CARRIER_FAILED',
      retryable: true,
    });
    expect(acme.createLabels).not.toHaveBeenCalled();
    expect(harness.artifact.put).not.toHaveBeenCalled();
  });

  it('keeps successful orders when the carrier reports a partial failure', async () => {
    const handler = {
      createLabels: jest.fn(async () => ({
        documents: [labelDocument('ORD-1', 'DHD1')],
        failures: [
          {
            orderNo: 'ORD-2',
            trackingNumber: 'DHD2',
            code: 'ORDER_LABEL_NOT_FOUND_AT_CARRIER',
            message: 'Parcel not found.',
            retryable: false,
          },
        ],
      })),
    };
    const harness = setup([order(1), order(2)], { dhd: handler });

    const response = await harness.service.generate(
      { ids: [orderId(1), orderId(2)], format: '10x15', grouping: 'combined' },
      vendor,
    );

    expect(response.summary).toMatchObject({ printed: 1, failed: 1 });
    expect(response.printed[0]).toMatchObject({ orderNo: 'ORD-1', trackingNumber: 'DHD1' });
    expect(response.failed[0]).toMatchObject({
      orderNo: 'ORD-2',
      code: 'ORDER_LABEL_NOT_FOUND_AT_CARRIER',
    });
    expect(harness.composer.compose).toHaveBeenCalledTimes(1);
  });

  it('marks an order failed when the carrier returns no document and no failure for it', async () => {
    const harness = setup([order(1)], {
      dhd: { createLabels: jest.fn(async () => ({ documents: [] })) },
    });

    const response = await harness.service.generate(
      { ids: [orderId(1)], format: '10x15', grouping: 'combined' },
      vendor,
    );

    expect(response.downloadUrl).toBeNull();
    expect(response.failed[0]).toMatchObject({
      orderNo: 'ORD-1',
      code: 'ORDER_LABEL_CARRIER_FAILED',
      retryable: true,
    });
  });

  it('isolates a render failure to the affected order', async () => {
    const harness = setup([order(1), order(2)]);
    harness.renderer.render.mockImplementation(async (document: { orderNo: string }) => {
      if (document.orderNo === 'ORD-2') throw new Error('render exploded');
      return {
        bytes: Buffer.from('%PDF-1.7'),
        pageCount: 1,
        pageWidthPt: 283,
        pageHeightPt: 425,
      };
    });

    const response = await harness.service.generate(
      { ids: [orderId(1), orderId(2)], format: '10x15', grouping: 'combined' },
      vendor,
    );

    expect(response.summary).toMatchObject({ printed: 1, failed: 1 });
    expect(response.failed[0]).toMatchObject({
      orderNo: 'ORD-2',
      code: 'ORDER_LABEL_RENDER_FAILED',
    });
  });

  it('marks every rendered order failed when composition fails', async () => {
    const harness = setup([order(1), order(2)]);
    harness.composer.compose.mockRejectedValueOnce(new Error('bad layout'));

    const response = await harness.service.generate(
      { ids: [orderId(1), orderId(2)], format: '10x15', grouping: 'combined' },
      vendor,
    );

    expect(response.downloadUrl).toBeNull();
    expect(response.summary).toMatchObject({ printed: 0, failed: 2 });
    expect(response.failed.map((item) => item.code)).toEqual([
      'ORDER_LABEL_RENDER_FAILED',
      'ORDER_LABEL_RENDER_FAILED',
    ]);
  });

  it('creates a ZIP with one PDF per carrier for per_carrier grouping', async () => {
    const harness = setup([
      order(1),
      order(2, { deliveryCompanyId: 'ecom', deliveryParcelId: 'ECOM1' }),
    ]);
    const response = await harness.service.generate(
      { ids: [orderId(1), orderId(2)], format: '10x15', grouping: 'per_carrier' },
      vendor,
    );

    expect(harness.composer.compose).toHaveBeenCalledTimes(2);
    expect(response.downloadUrl).toBe(`/api/orders/labels/${response.jobId}/labels.zip`);
    expect(response.contentType).toBe('application/zip');
    const zip = harness.artifact.put.mock.calls[0][3] as Buffer;
    expect(zip.subarray(0, 2).toString()).toBe('PK');
    expect(harness.artifact.put).toHaveBeenCalledWith(
      STORE_ID,
      response.jobId,
      'labels.zip',
      expect.any(Buffer),
      'application/zip',
    );
  });

  it('adds the store query parameter to the download URL for an admin', async () => {
    const harness = setup([order(1)]);
    const response = await harness.service.generate(
      { ids: [orderId(1)], format: '10x15', grouping: 'combined' },
      admin,
    );

    expect(response.downloadUrl).toBe(
      `/api/orders/labels/${response.jobId}/labels.pdf?storeId=${STORE_ID}`,
    );
  });

  it('marks unfetched groups failed when the job deadline has passed', async () => {
    const harness = setup([
      order(1),
      order(2, { deliveryCompanyId: 'ecom', deliveryParcelId: 'ECOM1' }),
    ]);
    harness.configValues['orderLabels.jobTimeoutMs'] = 1000;
    harness.handlers.dhd.createLabels.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return { documents: [labelDocument('ORD-1', 'DHD1')] };
    });

    const response = await harness.service.generate(
      { ids: [orderId(1), orderId(2)], format: '10x15', grouping: 'combined' },
      vendor,
    );

    expect(response.downloadUrl).toBeNull();
    expect(response.summary).toMatchObject({ printed: 0, failed: 2 });
    expect(response.failed.map((item) => item.code)).toEqual([
      'ORDER_LABEL_JOB_TIMEOUT',
      'ORDER_LABEL_JOB_TIMEOUT',
    ]);
  }, 10000);

  it('refuses a batch above the configured maximum before reading orders', async () => {
    const harness = setup([]);
    const ids = Array.from({ length: 101 }, (_, index) => orderId(index + 1));

    await expect(
      harness.service.generate({ ids, format: '10x15', grouping: 'combined' }, vendor),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.ORDER_LABEL_TOO_MANY_ORDERS });
    expect(harness.orderModel.find).not.toHaveBeenCalled();
  });

  it('refuses to generate only when the global flag is disabled', async () => {
    const harness = setup([order(1)]);
    harness.configValues['orderLabels.enabled'] = false;

    await expect(
      harness.service.generate(
        { ids: [orderId(1)], format: '10x15', grouping: 'combined' },
        vendor,
      ),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.ORDER_LABEL_DISABLED });
    expect(harness.stores.findByVendorIdOrThrow).not.toHaveBeenCalled();

    harness.configValues['orderLabels.enabled'] = true;
    await expect(
      harness.service.generate(
        { ids: [orderId(1)], format: '10x15', grouping: 'combined' },
        vendor,
      ),
    ).resolves.toMatchObject({ summary: { requested: 1, printed: 1 } });
  });
});

describe('OrderLabelsService.download', () => {
  it('requires a valid store id for an admin and streams from that store', async () => {
    const harness = setup();

    await expect(
      harness.service.download(JOB_ID, 'labels.pdf', admin),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.ORDER_LABEL_ARTIFACT_NOT_FOUND });
    await expect(
      harness.service.download(JOB_ID, 'labels.pdf', admin, 'not-an-object-id'),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.ORDER_LABEL_ARTIFACT_NOT_FOUND });
    expect(harness.artifact.stream).not.toHaveBeenCalled();

    await harness.service.download(JOB_ID, 'labels.pdf', admin, STORE_ID);
    expect(harness.stores.findOne).toHaveBeenCalledWith(STORE_ID, {
      skipStatusCheck: true,
    });
    expect(harness.artifact.stream).toHaveBeenCalledWith(STORE_ID, JOB_ID, 'labels.pdf');
  });

  it('ignores a client store id for a vendor and uses the session store', async () => {
    const harness = setup();

    await harness.service.download(JOB_ID, 'labels.zip', vendor, OTHER_STORE_ID);

    expect(harness.stores.findByVendorIdOrThrow).toHaveBeenCalledWith('vendor-1');
    expect(harness.stores.findOne).not.toHaveBeenCalled();
    expect(harness.artifact.stream).toHaveBeenCalledWith(STORE_ID, JOB_ID, 'labels.zip');
  });
});
