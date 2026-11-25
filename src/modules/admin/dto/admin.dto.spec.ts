import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminLoginDto } from './admin-login.dto';
import { CreateAdminDto } from './create-admin.dto';
import { AdminQueryDto } from './admin-query.dto';
import { UpdateAdminStatusDto } from './update-admin-status.dto';
import { ChangeAdminPasswordDto } from './change-admin-password.dto';
import { AdminStatus } from '../../../common/constants/admin-status.enum';

async function validateDto<T extends object>(cls: new () => T, plain: Record<string, unknown>) {
  const instance = plainToInstance(cls, plain);
  const errors = await validate(instance);
  return { instance, errors };
}

describe('Admin DTOs', () => {
  it('trims and lowercases the login email', async () => {
    const { instance, errors } = await validateDto(AdminLoginDto, {
      email: '  ADMIN@IMRAAAH.COM ',
      password: 'anything',
    });
    expect(errors).toHaveLength(0);
    expect((instance as AdminLoginDto).email).toBe('admin@imraaah.com');
  });

  it('rejects an invalid login email', async () => {
    const { errors } = await validateDto(AdminLoginDto, { email: 'nope', password: 'x' });
    expect(errors.some((e) => e.property === 'email')).toBe(true);
  });

  it('normalizes create fields and applies the password policy', async () => {
    const { instance, errors } = await validateDto(CreateAdminDto, {
      firstName: ' Amina ',
      lastName: ' Bensalem ',
      email: ' AMINA@IMRAAAH.COM ',
      password: 'strongPassword123',
    });
    expect(errors).toHaveLength(0);
    expect(instance.firstName).toBe('Amina');
    expect(instance.lastName).toBe('Bensalem');
    expect(instance.email).toBe('amina@imraaah.com');
    expect(instance.status).toBe(AdminStatus.ACTIVE);
  });

  it('rejects a weak or common create password', async () => {
    for (const password of ['short1', 'onlyletters', 'password123']) {
      const { errors } = await validateDto(CreateAdminDto, {
        firstName: 'A',
        lastName: 'B',
        email: 'a@b.co',
        password,
      });
      expect(errors.some((e) => e.property === 'password')).toBe(true);
    }
  });

  it('rejects an unknown status', async () => {
    const create = await validateDto(CreateAdminDto, {
      firstName: 'A',
      lastName: 'B',
      email: 'a@b.co',
      password: 'strongPassword123',
      status: 'owner',
    });
    expect(create.errors.some((e) => e.property === 'status')).toBe(true);

    const update = await validateDto(UpdateAdminStatusDto, { status: 'deleted' });
    expect(update.errors.some((e) => e.property === 'status')).toBe(true);
  });

  it('coerces and bounds list query values', async () => {
    const { instance, errors } = await validateDto(AdminQueryDto, {
      page: '2',
      limit: '50',
      sort: 'name',
      order: 'asc',
    });
    expect(errors).toHaveLength(0);
    expect(instance.page).toBe(2);
    expect(instance.limit).toBe(50);

    const tooLarge = await validateDto(AdminQueryDto, { limit: '500' });
    expect(tooLarge.errors.some((e) => e.property === 'limit')).toBe(true);
  });

  it('applies the policy to a password change', async () => {
    const { errors } = await validateDto(ChangeAdminPasswordDto, {
      currentPassword: 'current123',
      newPassword: 'short',
      confirmPassword: 'short',
    });
    expect(errors.some((e) => e.property === 'newPassword')).toBe(true);
  });
});
