import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { User, UserDocument } from '../users/schemas/user.schema';
import { PasswordResetToken, PasswordResetTokenDocument } from './schemas/password-reset-token.schema';
import { Otp, OtpDocument } from './schemas/otp.schema';
import { Role } from '../../common/constants/roles.enum';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { CustomerSignupDto } from './dto/customer-signup.dto';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResetPasswordPhoneDto } from './dto/reset-password-phone.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { RefreshDto } from './dto/refresh.dto';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { EmailService } from '../email/email.service';
import { StoresService } from '../stores/stores.service';
import { StoreAccessService } from '../team/store-access.service';
import { InvitationsService } from '../team/invitations.service';
import { StoreRole } from '../../common/constants/store-roles.enum';

const FAKE_EMAIL_SUFFIX = '@customer.imraaah';

function sanitizeEmail(email?: string): string | null {
  if (!email) return null;
  if (email.endsWith(FAKE_EMAIL_SUFFIX)) return null;
  return email;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(PasswordResetToken.name) private resetTokenModel: Model<PasswordResetTokenDocument>,
    @InjectModel(Otp.name) private otpModel: Model<OtpDocument>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private emailService: EmailService,
    private storesService: StoresService,
    private storeAccessService: StoreAccessService,
    private invitationsService: InvitationsService,
  ) {}

  private generateRefreshToken(): { rawToken: string; tokenHash: string } {
    const rawToken = crypto.randomBytes(48).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    return { rawToken, tokenHash };
  }

  private async storeRefreshToken(userId: string): Promise<string> {
    const { rawToken, tokenHash } = this.generateRefreshToken();
    await this.userModel.findByIdAndUpdate(userId, {
      refreshToken: tokenHash,
      refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    return rawToken;
  }

  async signup(dto: SignupDto) {
    const existing = await this.userModel.findOne({ email: dto.email.toLowerCase() });
    if (existing) {
      throw new AppException(AppErrorCode.AUTH_EMAIL_ALREADY_REGISTERED);
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const created = await this.userModel.create({
      fullName: dto.fullName,
      email: dto.email.toLowerCase(),
      phoneNumber: dto.phoneNumber || '',
      password: hashedPassword,
      role: Role.VENDOR,
    });
    const user = created.toObject();
    const userId = user._id.toString();

    try {
      const store = await this.storesService.create(
        {
          vendorEmail: user.email,
          storeName: `${user.fullName} Store`,
          description: `Welcome to ${user.fullName}'s artisan store.`,
          contactEmail: user.email,
          contactPhone: user.phoneNumber || '',
          storeLogo: undefined,
          coverImage: undefined,
          wilaya: '',
          categories: [],
        },
        // Passed as an explicit argument rather than a field on the DTO: ownership is
        // never read from a request-shaped object. This is the path that created two
        // stores whose `vendorId` landed in the database as a BSON string, which
        // `findByVendorIdOrThrow()` could not match - see `vendorIdFilter()`.
        userId,
      );
      const storeId = String(store._id);
      return this.issueSession(user, storeId);
    } catch (err) {
      // Rollback user creation if store creation fails. No token has been issued yet.
      await this.userModel.findByIdAndDelete(userId).exec();
      throw err;
    }
  }

  /**
   * Issues a normal session for a user and resolves their store access.
   *
   * Used by login, refresh, signup and the invitation accept flows so the payload shape is
   * identical everywhere: `storeId`, `storeRole`, `isOwner` and `permissions` are always
   * present. A deactivated employee cannot obtain a session (`AUTH_STORE_ACCESS_REVOKED`);
   * a legacy vendor with no store at all is still allowed to sign in (storeId `null`).
   */
  async issueSession(user: any, knownStoreId?: string) {
    const userId = String(user._id ?? user.id);
    const access = await this.storeAccessService.resolveForUser(userId, user.role);

    if (user.role === Role.VENDOR && !access) {
      const revoked = await this.storeAccessService.hasDeactivatedMembership(userId);
      if (revoked) {
        throw new AppException(AppErrorCode.AUTH_STORE_ACCESS_REVOKED);
      }
    }

    const token = this.jwtService.sign({
      sub: userId,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion ?? 0,
    });
    const refreshToken = await this.storeRefreshToken(userId);

    return {
      token,
      refreshToken,
      user: this.buildUserPayload(user, access, knownStoreId),
    };
  }

  private buildUserPayload(
    user: any,
    access: Awaited<ReturnType<StoreAccessService['resolveForUser']>>,
    knownStoreId?: string,
  ) {
    return {
      id: user._id ?? user.id,
      fullName: user.fullName,
      email: sanitizeEmail(user.email),
      phoneNumber: user.phoneNumber,
      role: user.role,
      gender: user.gender ? user.gender.toLowerCase() : null,
      address: user.address || null,
      savedProductIds: (user.savedProductIds || []).map((id: any) => id.toString()),
      profileImage: user.profileImage || null,
      storeId: knownStoreId ?? (access?.storeId ? String(access.storeId) : null),
      storeRole: access?.storeRole ?? (knownStoreId ? StoreRole.OWNER : null),
      isOwner: access?.isOwner ?? !!knownStoreId,
      permissions: access?.permissions ?? (knownStoreId ? ['*'] : []),
    };
  }

  // --- Team invitation acceptance ---

  getInvitationInfo(token: string) {
    return this.invitationsService.validateToken(token);
  }

  /**
   * Accepts an invitation and creates the invitee's account. No store is created: the new
   * user is a `VENDOR` whose store access comes from the membership row.
   */
  async acceptInvitationNewAccount(dto: AcceptInvitationDto, token: string) {
    const info = await this.invitationsService.validateToken(token);
    if (!info.requiresAccount) {
      throw new AppException(AppErrorCode.TEAM_ACCOUNT_EXISTS_USE_LOGIN);
    }
    if (dto.password !== dto.confirmPassword) {
      throw new AppException(AppErrorCode.USER_PASSWORDS_DO_NOT_MATCH);
    }

    const existing = await this.userModel.findOne({ email: info.email }).select('_id').lean().exec();
    if (existing) {
      throw new AppException(AppErrorCode.TEAM_ACCOUNT_EXISTS_USE_LOGIN);
    }

    // Claim before creating anything: the atomic claim is what makes the token single-use.
    const claimed = await this.invitationsService.claim(token, info.email);

    let createdUserId: string | null = null;
    try {
      const hashedPassword = await bcrypt.hash(dto.password, 10);
      const created = await this.userModel.create({
        fullName: dto.fullName,
        email: info.email,
        phoneNumber: '',
        password: hashedPassword,
        role: Role.VENDOR,
        isActive: true,
      });
      createdUserId = created._id.toString();

      await this.invitationsService.join(claimed, createdUserId, {
        id: createdUserId,
        email: info.email,
        fullName: dto.fullName,
      });

      return this.issueSession(created.toObject());
    } catch (err) {
      // No orphan account and no burned token: undo both where possible.
      if (createdUserId) {
        await this.userModel.findByIdAndDelete(createdUserId).exec().catch(() => undefined);
      }
      await this.invitationsService.releaseClaim(claimed).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Accepts an invitation for an account that already exists. Email ownership is proven by
   * the authenticated session, and it must match the invitation email.
   */
  async acceptInvitationExisting(user: { id: string }, token: string) {
    const fresh = await this.userModel.findById(user.id);
    if (!fresh) {
      throw new AppException(AppErrorCode.USER_NOT_FOUND, { id: user.id });
    }

    const info = await this.invitationsService.validateToken(token);
    if ((fresh.email || '').toLowerCase() !== info.email.toLowerCase()) {
      throw new AppException(AppErrorCode.TEAM_INVITATION_EMAIL_MISMATCH);
    }

    const claimed = await this.invitationsService.claim(
      token,
      fresh.email,
      fresh._id.toString(),
    );
    await this.invitationsService.join(claimed, fresh._id.toString(), {
      id: fresh._id.toString(),
      email: fresh.email,
      fullName: fresh.fullName,
    });

    // Unresolved decision #6 default: a CUSTOMER accepting becomes a VENDOR on the same User.
    if (fresh.role === Role.CUSTOMER) {
      fresh.role = Role.VENDOR;
      await fresh.save();
    }

    return this.issueSession(fresh);
  }

  /** The current user, with the same session payload shape as login/refresh. */
  async getMe(userId: string) {
    const user = await this.userModel.findById(userId);
    if (!user) {
      throw new AppException(AppErrorCode.USER_NOT_FOUND, { id: userId });
    }
    const access = await this.storeAccessService.resolveForUser(
      user._id.toString(),
      user.role,
    );
    return this.buildUserPayload(user, access);
  }

  async login(dto: LoginDto) {
    const isEmail = dto.identifier.includes('@');
    const filter = isEmail
      ? { email: dto.identifier.toLowerCase() }
      : { phoneNumber: dto.identifier };

    const user = await this.userModel.findOne(filter).select('+password');
    if (!user) {
      throw new AppException(AppErrorCode.AUTH_INVALID_CREDENTIALS);
    }

    if (!user.isActive) {
      throw new AppException(AppErrorCode.AUTH_ACCOUNT_DISABLED);
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) {
      throw new AppException(AppErrorCode.AUTH_INVALID_CREDENTIALS);
    }

    await this.userModel.findByIdAndUpdate(user._id, {
      lastLogin: new Date(),
      ...(user.refreshTokenExpiresAt && user.refreshTokenExpiresAt < new Date()
        ? { refreshToken: null, refreshTokenExpiresAt: null }
        : {}),
    });

    return this.issueSession(user);
  }

  async refreshAccessToken(dto: RefreshDto) {
    const tokenHash = crypto.createHash('sha256').update(dto.refreshToken).digest('hex');
    const user = await this.userModel.findOne({ refreshToken: tokenHash });
    if (!user) {
      throw new AppException(AppErrorCode.AUTH_INVALID_REFRESH_TOKEN);
    }

    if (user.refreshTokenExpiresAt && user.refreshTokenExpiresAt < new Date()) {
      await this.userModel.findByIdAndUpdate(user._id, {
        refreshToken: null,
        refreshTokenExpiresAt: null,
      });
      throw new AppException(AppErrorCode.AUTH_REFRESH_TOKEN_EXPIRED);
    }

    return this.issueSession(user);
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.userModel.findOne({ email: dto.email.toLowerCase() });

    if (user) {
      await this.resetTokenModel.deleteMany({ userId: user._id, usedAt: null });

      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      // Never log the token, its hash, or the reset URL. Anything that ingests stdout (ops, a
      // log aggregator, a CI artifact, a shipped *.log file) could otherwise reset an arbitrary
      // account for the life of the token. The userId is enough to correlate the request.
      this.logger.log(`[FORGOT_PASSWORD] Reset link issued for userId=${user._id}`);

      await this.resetTokenModel.create({
        userId: user._id,
        email: user.email,
        tokenHash,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });

      const frontendUrl = this.configService.get<string>('frontendUrl') || 'http://localhost:3001';
      const resetUrl = `${frontendUrl}/en/reset-password?token=${rawToken}&email=${encodeURIComponent(user.email)}`;

      await this.emailService.sendPasswordResetEmail(user.email, resetUrl, 30);
    } else {
      // Deliberately does not echo the email back: the response is already uniform so the
      // endpoint cannot be used to enumerate accounts, and the log should not undo that.
      this.logger.log('[FORGOT_PASSWORD] No matching account');
    }

    return { message: 'If an account exists, a password reset email has been sent.' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    // The submitted token (and its hash) must never reach a log line — that is exactly the
    // value an attacker needs to take the account over.
    const tokenHash = crypto.createHash('sha256').update(dto.token).digest('hex');

    const resetToken = await this.resetTokenModel.findOne({ tokenHash });

    if (!resetToken) {
      throw new AppException(AppErrorCode.AUTH_RESET_TOKEN_INVALID);
    }

    if (resetToken.usedAt) {
      throw new AppException(AppErrorCode.AUTH_RESET_TOKEN_USED);
    }

    if (resetToken.expiresAt < new Date()) {
      throw new AppException(AppErrorCode.AUTH_RESET_TOKEN_EXPIRED);
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    // Resetting the password ends every existing session: the refresh token is cleared and the
    // token generation is bumped, which invalidates all already-issued access tokens (H3).
    await this.userModel.findByIdAndUpdate(resetToken.userId, {
      password: hashedPassword,
      refreshToken: null,
      refreshTokenExpiresAt: null,
      $inc: { tokenVersion: 1 },
    });
    await this.resetTokenModel.findByIdAndUpdate(resetToken._id, { usedAt: new Date() });

    this.logger.log('[RESET_PASSWORD] Password reset completed.');

    return { message: 'Password has been reset successfully.' };
  }

  // --- Customer Auth ---

  async customerRegister(dto: CustomerSignupDto) {
    const existing = await this.userModel.findOne({ phoneNumber: dto.phoneNumber });
    if (existing) {
      throw new AppException(AppErrorCode.AUTH_PHONE_ALREADY_REGISTERED);
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const created = await this.userModel.create({
      fullName: dto.fullName,
      email: `${dto.phoneNumber}@customer.imraaah`,
      phoneNumber: dto.phoneNumber,
      password: hashedPassword,
      role: Role.CUSTOMER,
      gender: dto.gender,
    });
    const user = created.toObject();

    const token = this.jwtService.sign({
      sub: user._id.toString(),
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion ?? 0,
    });
    const refreshToken = await this.storeRefreshToken(user._id.toString());

    return {
      token,
      refreshToken,
      user: {
        id: user._id.toString(),
        fullName: user.fullName,
        email: sanitizeEmail(user.email),
        phoneNumber: user.phoneNumber,
        role: user.role,
        gender: user.gender ? user.gender.toLowerCase() : null,
        address: user.address || null,
        savedProductIds: (user.savedProductIds || []).map((id) => id.toString()),
        profileImage: user.profileImage || null,
      },
    };
  }

  // --- OTP System ---

  async sendOtp(dto: SendOtpDto) {
    const user = await this.userModel.findOne({ phoneNumber: dto.phoneNumber });
    if (!user) {
      this.logger.log(`[SEND_OTP] No user found for phone=${dto.phoneNumber}`);
      return { message: 'If an account exists, an OTP has been sent.' };
    }

    await this.otpModel.deleteMany({ phoneNumber: dto.phoneNumber, verifiedAt: null, usedAt: null });

    const code = crypto.randomInt(100000, 999999).toString();
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');

    await this.otpModel.create({
      phoneNumber: dto.phoneNumber,
      code: codeHash,
      type: 'password_reset',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    const smsSender: SmsSender = new ConsoleSmsSender(this.logger);
    await smsSender.send(dto.phoneNumber, `Your Imraaah verification code is: ${code}. It expires in 5 minutes.`);

    return { message: 'If an account exists, an OTP has been sent.' };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const codeHash = crypto.createHash('sha256').update(dto.code).digest('hex');

    // Atomically find the latest unverified OTP and increment attempts
    const otp = await this.otpModel.findOneAndUpdate(
      {
        phoneNumber: dto.phoneNumber,
        verifiedAt: null,
        usedAt: null,
      },
      { $inc: { attempts: 1 } },
      { new: true, sort: { createdAt: -1 } },
    );

    if (!otp) {
      throw new AppException(AppErrorCode.AUTH_OTP_INVALID);
    }

    if (otp.expiresAt < new Date()) {
      throw new AppException(AppErrorCode.AUTH_OTP_EXPIRED);
    }

    if (otp.attempts > 5) {
      throw new AppException(AppErrorCode.AUTH_OTP_ATTEMPTS_EXCEEDED);
    }

    if (otp.code !== codeHash) {
      throw new AppException(AppErrorCode.AUTH_OTP_INVALID);
    }

    await this.otpModel.findByIdAndUpdate(otp._id, { verifiedAt: new Date(), attempts: 0 });

    const otpVerificationToken = this.jwtService.sign(
      { sub: dto.phoneNumber, type: 'otp_verification' },
      { expiresIn: '5m' },
    );

    return { otpVerificationToken };
  }

  async resetPasswordPhone(dto: ResetPasswordPhoneDto) {
    let payload: { sub: string; type: string };
    try {
      payload = this.jwtService.verify(dto.otpVerificationToken);
    } catch {
      throw new AppException(AppErrorCode.AUTH_VERIFICATION_TOKEN_INVALID);
    }

    if (payload.type !== 'otp_verification') {
      throw new AppException(AppErrorCode.AUTH_VERIFICATION_TOKEN_TYPE_INVALID);
    }

    const phoneNumber = payload.sub;
    const user = await this.userModel.findOne({ phoneNumber });
    if (!user) {
      throw new AppException(AppErrorCode.AUTH_USER_NOT_FOUND);
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, 10);
    await this.userModel.findByIdAndUpdate(user._id, {
      password: hashedPassword,
      refreshToken: null,
      refreshTokenExpiresAt: null,
      // Revoke every access token issued before this reset (H3).
      $inc: { tokenVersion: 1 },
    });

    await this.otpModel.updateMany(
      { phoneNumber, verifiedAt: { $ne: null }, usedAt: null },
      { usedAt: new Date() },
    );

    this.logger.log(`[RESET_PASSWORD_PHONE] SUCCESS for phone=${phoneNumber}`);

    return { message: 'Password has been reset successfully.' };
  }
}

// --- SMS Sender Interface ---

interface SmsSender {
  send(phoneNumber: string, message: string): Promise<void>;
}

class ConsoleSmsSender implements SmsSender {
  constructor(private readonly logger: Logger) {}

  async send(phoneNumber: string, message: string) {
    if (process.env.NODE_ENV === 'production') {
      // The fallback sender must never print an OTP in production: the message *is* the
      // credential. Without a configured SMS provider the code is simply not delivered — the
      // fix is a real provider, not a log line.
      this.logger.error(
        '[SMS] No SMS provider configured; the verification code was not delivered.',
      );
      return;
    }

    // Local development only: the console is the SMS channel, so the code has to be visible.
    this.logger.log(`[SMS to ${phoneNumber}]: ${message}`);
  }
}
