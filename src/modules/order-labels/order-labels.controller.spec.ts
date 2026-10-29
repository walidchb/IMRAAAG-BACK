import { StreamableFile } from '@nestjs/common';
import { Readable } from 'node:stream';
import { Role } from '../../common/constants/roles.enum';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { OrderLabelsController } from './order-labels.controller';

const JOB_ID = '7c1f2a50-1234-4abc-8def-1234567890ab';
const STORE_ID = '6ac400e26b1b2c3d4e5f6a71';

function setup() {
  const service = {
    generate: jest.fn(async () => ({ jobId: JOB_ID })),
    download: jest.fn(async () => ({
      body: Readable.from([Buffer.from('%PDF-1.7')]),
      contentType: 'application/pdf',
      contentLength: 8,
      contentDisposition: `attachment; filename="order-labels-${JOB_ID}.pdf"`,
    })),
  };
  return {
    service,
    controller: new OrderLabelsController(service as any),
  };
}

function response() {
  return { setHeader: jest.fn() } as any;
}

const user = {
  id: 'vendor-1',
  email: 'vendor@example.com',
  role: Role.VENDOR,
  fullName: 'V',
};

describe('OrderLabelsController', () => {
  it('passes the validated DTO and session user to the service', async () => {
    const { controller, service } = setup();
    const dto = { ids: [STORE_ID], format: '10x15', grouping: 'combined' } as any;
    const req = { user };

    await controller.generate(dto, req);

    expect(service.generate).toHaveBeenCalledWith(dto, user);
  });

  it('sets private, non-sniffable download headers and streams the artifact', async () => {
    const { controller, service } = setup();
    const res = response();

    const result = await controller.download(JOB_ID, 'labels.pdf', STORE_ID, { user }, res);

    expect(service.download).toHaveBeenCalledWith(
      JOB_ID,
      'labels.pdf',
      user,
      STORE_ID,
    );
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      `attachment; filename="order-labels-${JOB_ID}.pdf"`,
    );
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Length', '8');
    expect(result).toBeInstanceOf(StreamableFile);
  });

  it('omits Content-Length when the artifact has no known size', async () => {
    const { controller, service } = setup();
    service.download.mockResolvedValueOnce({
      body: Readable.from([Buffer.from('zip')]),
      contentType: 'application/zip',
      contentLength: null,
      contentDisposition: 'attachment',
    } as any);
    const res = response();

    await controller.download(JOB_ID, 'labels.zip', undefined, { user }, res);

    expect(service.download).toHaveBeenCalledWith(JOB_ID, 'labels.zip', user, undefined);
    expect(res.setHeader).not.toHaveBeenCalledWith('Content-Length', expect.anything());
  });

  it('declares the vendor/admin contract and the generation throttle', () => {
    const proto = OrderLabelsController.prototype;

    expect(Reflect.getMetadata(ROLES_KEY, OrderLabelsController)).toEqual([
      Role.VENDOR,
      Role.ADMIN,
    ]);
    expect(
      Reflect.getMetadata('THROTTLER:LIMITdefault', proto.generate as never),
    ).toBe(6);
    expect(
      Reflect.getMetadata('THROTTLER:TTLdefault', proto.generate as never),
    ).toBe(60000);
  });
});
