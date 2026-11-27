import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { AdminPlansController } from './admin-plans.controller';

describe('AdminPlansController image upload', () => {
  const admin = { id: 'admin1', email: 'admin@imraaah.com' } as any;

  function makeController() {
    const plansService = {};
    const uploadService = {
      uploadPlanImage: jest.fn().mockResolvedValue({
        url: 'https://cdn.test/plan.webp',
        key: 'store/admin/admin1/plans/plan.webp',
      }),
    };
    const controller = new AdminPlansController(
      plansService as any,
      uploadService as any,
    );
    return { controller, uploadService };
  }

  it('namespaces a plan icon under the admin scope', async () => {
    const { controller, uploadService } = makeController();
    const file = { buffer: Buffer.from(''), mimetype: 'image/png' } as any;

    const result = await controller.uploadImage(admin, file);

    expect(uploadService.uploadPlanImage).toHaveBeenCalledWith(file, 'admin/admin1');
    expect(result).toEqual({
      url: 'https://cdn.test/plan.webp',
      key: 'store/admin/admin1/plans/plan.webp',
    });
  });

  it('refuses a request with no file', async () => {
    const { controller, uploadService } = makeController();

    await expect(controller.uploadImage(admin, undefined as any)).rejects.toMatchObject({
      errorCode: AppErrorCode.UPLOAD_NO_FILE_PROVIDED,
    });
    expect(uploadService.uploadPlanImage).not.toHaveBeenCalled();
  });
});
