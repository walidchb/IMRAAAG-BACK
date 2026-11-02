import { UploadController } from './upload.controller';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { Role } from '../../common/constants/roles.enum';

/**
 * H7 — uploads are tenant-scoped.
 *
 * Every object now lives under `store/<storeId>/<folder>/<uuid>...`, resolved from the session.
 * A delete must prove the key belongs to the caller, otherwise any authenticated vendor could
 * remove another vendor's images just by knowing the key.
 */
describe('UploadController tenancy', () => {
  const STORE_A = '6a5ac33e2274da4958b72fc7';
  const STORE_B = '6a5ac33e2274da4958b72fc8';
  const FILE_ID = '2f8a1d5c-3b7e-4c9a-8d1f-6e5b4a3c2d1e';

  function makeController(storeId = STORE_A) {
    const uploadService = {
      deleteFile: jest.fn().mockResolvedValue(undefined),
      uploadProductImage: jest.fn().mockResolvedValue({ key: `store/${storeId}/products/${FILE_ID}.webp` }),
    };
    const storesService = {
      findByVendorIdOrThrow: jest.fn().mockResolvedValue({ _id: storeId }),
    };
    const controller = new UploadController(uploadService as any, storesService as any);
    return { controller, uploadService, storesService };
  }

  const vendorReq = { user: { id: 'user-1', role: Role.VENDOR, email: 'vendor@test.com' } };

  it('deletes a key inside the caller’s own store namespace', async () => {
    const { controller, uploadService } = makeController();

    await expect(
      controller.deleteFile(vendorReq, `store/${STORE_A}/products/${FILE_ID}.webp`),
    ).resolves.toEqual({ message: 'File deleted' });

    expect(uploadService.deleteFile).toHaveBeenCalledWith(
      `store/${STORE_A}/products/${FILE_ID}.webp`,
    );
  });

  it('refuses a valid-looking key from another store', async () => {
    const { controller, uploadService } = makeController();

    await expect(
      controller.deleteFile(vendorReq, `store/${STORE_B}/products/${FILE_ID}.webp`),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.UPLOAD_KEY_FORBIDDEN });

    expect(uploadService.deleteFile).not.toHaveBeenCalled();
  });

  it('refuses legacy unscoped keys (they cannot be attributed to a tenant)', async () => {
    const { controller } = makeController();

    await expect(
      controller.deleteFile(vendorReq, `products/${FILE_ID}.webp`),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('namespaces new uploads under the session store', async () => {
    const { controller, uploadService } = makeController();

    await controller.uploadProductImage({} as any, vendorReq);

    expect(uploadService.uploadProductImage).toHaveBeenCalledWith({}, STORE_A);
  });
});
