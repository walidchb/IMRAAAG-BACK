import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { LabelArtifactService } from './label-artifact.service';

const STORE_ID = '6ac400e26b1b2c3d4e5f6a71';
const JOB_ID = '7c1f2a50-1234-4abc-8def-1234567890ab';

function config(overrides: Record<string, string | undefined> = {}) {
  return {
    endpoint: 'https://r2.example.com',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    bucket: 'bucket',
    ...overrides,
  };
}

function build(overrides: Record<string, string | undefined> = {}) {
  const values = config(overrides);
  const upload = {
    putPrivateObject: jest.fn(async () => ({})),
    streamPrivateObject: jest.fn(async () => ({
      body: Buffer.from('%PDF-1.7'),
      contentType: 'application/pdf',
      contentLength: 8,
    })),
  };
  const service = new LabelArtifactService(upload as any, {
    get: jest.fn((key: string) => values[key.replace('r2.', '') as keyof typeof values]),
  } as any);
  return { service, upload };
}

describe('LabelArtifactService', () => {
  it('writes a store-prefixed private key with the requested content type', async () => {
    const { service, upload } = build();

    await expect(
      service.put(STORE_ID, JOB_ID, 'labels.pdf', Buffer.from('%PDF-1.7'), 'application/pdf'),
    ).resolves.toBe(`order-labels/${STORE_ID}/${JOB_ID}/labels.pdf`);

    expect(upload.putPrivateObject).toHaveBeenCalledWith(
      `order-labels/${STORE_ID}/${JOB_ID}/labels.pdf`,
      expect.any(Buffer),
      'application/pdf',
    );
  });

  it('refuses to put without complete R2 configuration', async () => {
    const { service, upload } = build({ bucket: '' });

    await expect(
      service.put(STORE_ID, JOB_ID, 'labels.pdf', Buffer.from('pdf'), 'application/pdf'),
    ).rejects.toMatchObject({
      errorCode: AppErrorCode.ORDER_LABEL_STORAGE_UNAVAILABLE,
    });
    expect(upload.putPrivateObject).not.toHaveBeenCalled();
  });

  it('maps a storage failure to ORDER_LABEL_STORAGE_UNAVAILABLE', async () => {
    const { service, upload } = build();
    upload.putPrivateObject.mockRejectedValueOnce(new Error('network down'));

    await expect(
      service.put(STORE_ID, JOB_ID, 'labels.zip', Buffer.from('zip'), 'application/zip'),
    ).rejects.toMatchObject({
      errorCode: AppErrorCode.ORDER_LABEL_STORAGE_UNAVAILABLE,
    });
  });

  it('streams a whitelisted file from the store/job key with an attachment name', async () => {
    const { service, upload } = build();

    const result = await service.stream(STORE_ID, JOB_ID, 'labels.zip');

    expect(upload.streamPrivateObject).toHaveBeenCalledWith(
      `order-labels/${STORE_ID}/${JOB_ID}/labels.zip`,
    );
    expect(result.contentDisposition).toBe(
      `attachment; filename="order-labels-${JOB_ID}.zip"`,
    );
  });

  it('rejects a non-whitelisted file or malformed job id before touching storage', async () => {
    const { service, upload } = build();

    await expect(
      service.stream(STORE_ID, JOB_ID, '../secret.pdf' as any),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.ORDER_LABEL_ARTIFACT_NOT_FOUND });
    await expect(
      service.stream(STORE_ID, 'not-a-uuid', 'labels.pdf'),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.ORDER_LABEL_ARTIFACT_NOT_FOUND });
    expect(upload.streamPrivateObject).not.toHaveBeenCalled();
    await expect(
      service.stream(STORE_ID, JOB_ID, '../secret.pdf' as any),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('maps a missing object to ORDER_LABEL_ARTIFACT_NOT_FOUND', async () => {
    const { service, upload } = build();
    upload.streamPrivateObject.mockRejectedValueOnce(new Error('NoSuchKey'));

    await expect(service.stream(STORE_ID, JOB_ID, 'labels.pdf')).rejects.toMatchObject({
      errorCode: AppErrorCode.ORDER_LABEL_ARTIFACT_NOT_FOUND,
    });
  });
});
