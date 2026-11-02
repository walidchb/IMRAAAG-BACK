import { JwtStrategy } from './jwt.strategy';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { Types } from 'mongoose';

/**
 * H3 — access-token revocation and OTP-token scope.
 *
 * Before this, a password reset only cleared the refresh token (already-issued 7-day access
 * tokens stayed valid), and an OTP-verification token was accepted as a session by every route
 * without an explicit `@Roles`.
 */
describe('JwtStrategy.validate', () => {
  const USER_ID = new Types.ObjectId().toString();

  function makeStrategy(user: Record<string, unknown> | null) {
    const userModel = {
      findById: jest.fn().mockResolvedValue(user),
    };
    const configService = { get: jest.fn().mockReturnValue('test-secret') };
    const strategy = new JwtStrategy(configService as any, userModel as any);
    return { strategy, userModel };
  }

  const activeUser = (over: Record<string, unknown> = {}) => ({
    _id: USER_ID,
    email: 'vendor@test.com',
    role: 'VENDOR',
    fullName: 'Vendor',
    phoneNumber: '0550000000',
    isActive: true,
    tokenVersion: 0,
    ...over,
  });

  it('accepts a token whose generation matches the user', async () => {
    const { strategy } = makeStrategy(activeUser({ tokenVersion: 3 }));

    const principal: any = await strategy.validate({ sub: USER_ID, tokenVersion: 3 });

    expect(principal.id).toBe(USER_ID);
    expect(principal.role).toBe('VENDOR');
  });

  it('rejects an access token issued before a password reset', async () => {
    const { strategy } = makeStrategy(activeUser({ tokenVersion: 4 }));

    await expect(strategy.validate({ sub: USER_ID, tokenVersion: 3 })).rejects.toMatchObject({
      errorCode: AppErrorCode.AUTH_TOKEN_INVALID,
    });
  });

  it('treats tokens issued before the field existed as generation 0', async () => {
    const { strategy } = makeStrategy(activeUser({ tokenVersion: 0 }));

    await expect(strategy.validate({ sub: USER_ID })).resolves.toBeDefined();
  });

  it('refuses an OTP-verification token as a session', async () => {
    const { strategy, userModel } = makeStrategy(activeUser());

    await expect(
      strategy.validate({ sub: '0550000000', type: 'otp_verification' }),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.AUTH_TOKEN_INVALID });

    // It must never even be looked up as a user id.
    expect(userModel.findById).not.toHaveBeenCalled();
  });

  it('refuses a deactivated account', async () => {
    const { strategy } = makeStrategy(activeUser({ isActive: false }));

    await expect(strategy.validate({ sub: USER_ID })).rejects.toBeInstanceOf(AppException);
  });
});
