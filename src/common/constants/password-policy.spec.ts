import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SignupDto } from '../../modules/auth/dto/signup.dto';
import { CustomerSignupDto } from '../../modules/auth/dto/customer-signup.dto';
import { ResetPasswordDto } from '../../modules/auth/dto/reset-password.dto';
import { ChangePasswordDto } from '../../modules/profile/dto/change-password.dto';
import { PASSWORD_MIN_LENGTH, isCommonPassword } from './password.const';

/**
 * H4 — password creation/change used to accept any 6-character string. These DTOs are the
 * enforcement point (there is no `@Roles`-style runtime check for a password).
 */
const dtoErrorPaths = async (dto: object) => (await validate(dto)).map((e) => e.property);

describe('password policy (H4)', () => {
  it('requires at least the configured minimum length', async () => {
    const errors = await dtoErrorPaths(
      plainToInstance(SignupDto, {
        fullName: 'Vendor',
        email: 'vendor@test.com',
        password: 'Ab1',
      }),
    );

    expect(typeof PASSWORD_MIN_LENGTH).toBe('number');
    expect(PASSWORD_MIN_LENGTH).toBeGreaterThanOrEqual(10);
    expect(errors).toContain('password');
  });

  it('requires a number as well as a letter', async () => {
    const errors = await dtoErrorPaths(
      plainToInstance(SignupDto, {
        fullName: 'Vendor',
        email: 'vendor@test.com',
        password: 'onlylettershere',
      }),
    );

    expect(errors).toContain('password');
  });

  it('rejects a common password even when it satisfies the shape rules', async () => {
    const errors = await dtoErrorPaths(
      plainToInstance(ResetPasswordDto, { token: 'token', password: 'password123' }),
    );

    expect(errors).toContain('password');
  });

  it('accepts a strong password', async () => {
    const errors = await dtoErrorPaths(
      plainToInstance(SignupDto, {
        fullName: 'Vendor',
        email: 'vendor@test.com',
        password: 'Imraaah2026!x',
      }),
    );

    expect(errors).not.toContain('password');
  });

  it('applies the same rule to customer signup and password change', async () => {
    const customer = await dtoErrorPaths(
      plainToInstance(CustomerSignupDto, {
        phoneNumber: '0550000000',
        fullName: 'Customer',
        password: 'short1',
      }),
    );
    const change = await dtoErrorPaths(
      plainToInstance(ChangePasswordDto, {
        currentPassword: 'whatever',
        newPassword: 'short1',
        confirmPassword: 'short1',
      }),
    );

    expect(customer).toContain('password');
    expect(change).toContain('newPassword');
  });

  it('caps the length at bcrypt’s 72-byte limit', async () => {
    const errors = await dtoErrorPaths(
      plainToInstance(SignupDto, {
        fullName: 'Vendor',
        email: 'vendor@test.com',
        password: `Aa1${'x'.repeat(80)}`,
      }),
    );

    expect(errors).toContain('password');
  });

  it('matches common passwords case-insensitively', () => {
    expect(isCommonPassword('Admin123')).toBe(true);
    expect(isCommonPassword('a-very-unlikely-secret-42')).toBe(false);
  });
});
