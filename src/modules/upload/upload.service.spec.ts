import sharp from 'sharp';
import { UploadService } from './upload.service';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { IMAGE_CONFIG } from './image.config';

/**
 * Focused coverage for the image pipeline itself. The Tenancy spec already proves the
 * namespace/ownership rules; these tests protect the expensive, failure-prone part:
 * every accepted upload becomes a bounded WebP and invalid bytes become a clean 400.
 */
describe('UploadService image pipeline', () => {
  const storeId = '6a5ac33e2274da4958b72fc7';

  function makeService(): UploadService {
    const config = {
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          'r2.bucket': 'test-bucket',
          'r2.publicUrl': 'https://cdn.test',
          'r2.endpoint': 'https://r2.test',
          'r2.accessKeyId': 'key',
          'r2.secretAccessKey': 'secret',
        };
        return values[key];
      }),
    };
    const service = new UploadService(config as any);
    (service as any).uploadToR2 = jest.fn().mockResolvedValue(undefined);
    return service;
  }

  function file(buffer: Buffer, mimetype = 'image/jpeg'): Express.Multer.File {
    return {
      buffer,
      mimetype,
      size: buffer.length,
      originalname: 'image',
      fieldname: 'file',
      encoding: '7bit',
      destination: '',
      filename: '',
      path: '',
      stream: null as any,
    } as Express.Multer.File;
  }

  it('converts a JPEG Box image to a bounded WebP before upload', async () => {
    const source = await sharp({
      create: { width: 2000, height: 600, channels: 3, background: '#ff0000' },
    })
      .jpeg()
      .toBuffer();

    const service = makeService();
    const result = await service.uploadBoxImage(file(source), storeId);

    expect(result.key).toMatch(
      new RegExp(`^store/${storeId}/boxes/[0-9a-f-]+\\.webp$`),
    );
    expect(result.url).toMatch(/^https:\/\/cdn\.test\/store\/.+\/boxes\/.+\.webp$/);

    const upload = (service as any).uploadToR2 as jest.Mock;
    expect(upload).toHaveBeenCalledTimes(1);
    const [key, buffer, contentType] = upload.mock.calls[0];
    expect(key).toBe(result.key);
    expect(contentType).toBe('image/webp');
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('RIFF');

    const metadata = await sharp(buffer).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(IMAGE_CONFIG.maxWidths.box);
  });

  it('rejects corrupt/unsupported bytes with UPLOAD_INVALID_FILE_TYPE and writes nothing', async () => {
    const corrupt = Buffer.from('this is not an image', 'utf8');
    const service = makeService();

    await expect(
      service.uploadBoxImage(file(corrupt, 'image/jpeg'), storeId),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.UPLOAD_INVALID_FILE_TYPE });

    expect((service as any).uploadToR2).not.toHaveBeenCalled();
  });

  it('rejects a file above the configured per-file ceiling', async () => {
    const source = Buffer.alloc(IMAGE_CONFIG.maxFileSize + 1, 1);
    const service = makeService();

    await expect(
      service.uploadBoxImage(file(source, 'image/jpeg'), storeId),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.UPLOAD_FILE_TOO_LARGE });

    expect((service as any).uploadToR2).not.toHaveBeenCalled();
  });
});
