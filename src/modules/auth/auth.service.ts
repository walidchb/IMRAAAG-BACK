import { Injectable, UnauthorizedException, ConflictException, BadRequestException, Logger } from '@nestjs/common';
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
import { EmailService } from './email.service';
import { StoresService } from '../stores/stores.service';

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
      throw new ConflictException('Email already registered');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const created = await this.userModel.create({
      fullName: dto.fullName,
      firstName: dto.fullName,
      lastName: '',
      email: dto.email.toLowerCase(),
      phoneNumber: dto.phoneNumber || '',
      password: hashedPassword,
      role: Role.VENDOR,
    });
    const user = created.toObject();

    const token = this.jwtService.sign({ sub: user._id.toString(), email: user.email, role: user.role });
    const refreshToken = await this.storeRefreshToken(user._id.toString());

    try {
      await this.storesService.create({
        vendorEmail: user.email,
        storeName: `${user.fullName} Store`,
        description: `Welcome to ${user.fullName}'s artisan store.`,
        contactEmail: user.email,
        contactPhone: user.phoneNumber || '',
        storeLogo: '',
        coverImage: '',
        wilaya: '',
        categories: [],
      });
    } catch (err) {
      this.logger.error(`Failed to auto-create store for ${user.email}: ${err instanceof Error ? err.message : err}`);
    }

    return {
      token,
      refreshToken,
      user: {
        id: user._id.toString(),
        fullName: user.fullName,
        email: user.email,
        phoneNumber: user.phoneNumber,
        role: user.role,
        gender: user.gender || null,
      },
    };
  }

  async login(dto: LoginDto) {
    const isEmail = dto.identifier.includes('@');
    const filter = isEmail
      ? { email: dto.identifier.toLowerCase() }
      : { phoneNumber: dto.identifier };

    const user = await this.userModel.findOne(filter);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.userModel.findByIdAndUpdate(user._id, {
      lastLogin: new Date(),
      ...(user.refreshTokenExpiresAt && user.refreshTokenExpiresAt < new Date()
        ? { refreshToken: null, refreshTokenExpiresAt: null }
        : {}),
    });

    const token = this.jwtService.sign({ sub: user._id, email: user.email, role: user.role });
    const refreshToken = await this.storeRefreshToken(user._id.toString());

    return {
      token,
      refreshToken,
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        phoneNumber: user.phoneNumber,
        role: user.role,
        gender: user.gender || null,
      },
    };
  }

  async refreshAccessToken(dto: RefreshDto) {
    const tokenHash = crypto.createHash('sha256').update(dto.refreshToken).digest('hex');
    const user = await this.userModel.findOne({ refreshToken: tokenHash });
    if (!user) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (user.refreshTokenExpiresAt && user.refreshTokenExpiresAt < new Date()) {
      await this.userModel.findByIdAndUpdate(user._id, {
        refreshToken: null,
        refreshTokenExpiresAt: null,
      });
      throw new UnauthorizedException('Refresh token expired. Please log in again.');
    }

    const token = this.jwtService.sign({ sub: user._id, email: user.email, role: user.role });
    const newRefreshToken = await this.storeRefreshToken(user._id.toString());

    return {
      token,
      refreshToken: newRefreshToken,
    };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.userModel.findOne({ email: dto.email.toLowerCase() });

    if (user) {
      await this.resetTokenModel.deleteMany({ userId: user._id, usedAt: null });

      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      this.logger.log(`[FORGOT_PASSWORD] userId=${user._id} email=${user.email} rawToken=${rawToken.substring(0,16)}... tokenHash=${tokenHash.substring(0,16)}...`);

      await this.resetTokenModel.create({
        userId: user._id,
        email: user.email,
        tokenHash,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });

      const frontendUrl = this.configService.get<string>('frontendUrl') || 'http://localhost:3001';
      const resetUrl = `${frontendUrl}/en/reset-password?token=${rawToken}&email=${encodeURIComponent(user.email)}`;

      this.logger.log(`[FORGOT_PASSWORD] resetUrl=${resetUrl}`);

      await this.emailService.sendPasswordResetEmail(user.email, resetUrl, 30);
    } else {
      this.logger.log(`[FORGOT_PASSWORD] No user found for email=${dto.email}`);
    }

    return { message: 'If an account exists, a password reset email has been sent.' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const tokenHash = crypto.createHash('sha256').update(dto.token).digest('hex');
    this.logger.log(`[RESET_PASSWORD] received token=${dto.token.substring(0,16)}... computed hash=${tokenHash.substring(0,16)}...`);

    const resetToken = await this.resetTokenModel.findOne({ tokenHash });
    this.logger.log(`[RESET_PASSWORD] found in DB: ${resetToken ? `userId=${resetToken.userId} usedAt=${resetToken.usedAt} expiresAt=${resetToken.expiresAt}` : 'NONE'}`);

    if (!resetToken) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    if (resetToken.usedAt) {
      throw new BadRequestException('Reset token has already been used');
    }

    if (resetToken.expiresAt < new Date()) {
      throw new BadRequestException('Reset token has expired');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    await this.userModel.findByIdAndUpdate(resetToken.userId, { password: hashedPassword });
    await this.resetTokenModel.findByIdAndUpdate(resetToken._id, { usedAt: new Date() });

    this.logger.log(`[RESET_PASSWORD] SUCCESS for userId=${resetToken.userId}`);

    return { message: 'Password has been reset successfully.' };
  }

  // --- Customer Auth ---

  async customerRegister(dto: CustomerSignupDto) {
    const existing = await this.userModel.findOne({ phoneNumber: dto.phoneNumber });
    if (existing) {
      throw new ConflictException('Phone number already registered');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const created = await this.userModel.create({
      fullName: dto.fullName,
      firstName: dto.fullName,
      lastName: '',
      email: `${dto.phoneNumber}@customer.imraaah`,
      phoneNumber: dto.phoneNumber,
      password: hashedPassword,
      role: Role.CUSTOMER,
      gender: dto.gender,
    });
    const user = created.toObject();

    const token = this.jwtService.sign({ sub: user._id.toString(), email: user.email, role: user.role });
    const refreshToken = await this.storeRefreshToken(user._id.toString());

    return {
      token,
      refreshToken,
      user: {
        id: user._id.toString(),
        fullName: user.fullName,
        email: user.email,
        phoneNumber: user.phoneNumber,
        role: user.role,
        gender: user.gender || null,
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

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');

    await this.otpModel.create({
      phoneNumber: dto.phoneNumber,
      code: codeHash,
      type: 'password_reset',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    this.logger.log(`[SEND_OTP] To ${dto.phoneNumber}: Your OTP code is ${code}`);

    const smsSender: SmsSender = new ConsoleSmsSender(this.logger);
    await smsSender.send(dto.phoneNumber, `Your Imraaah verification code is: ${code}. It expires in 5 minutes.`);

    return { message: 'If an account exists, an OTP has been sent.' };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const codeHash = crypto.createHash('sha256').update(dto.code).digest('hex');
    this.logger.log(`[VERIFY_OTP] phone=${dto.phoneNumber} codeHash=${codeHash.substring(0, 16)}...`);

    const otp = await this.otpModel.findOne({
      phoneNumber: dto.phoneNumber,
      code: codeHash,
      verifiedAt: null,
      usedAt: null,
    });

    if (!otp) {
      throw new BadRequestException('Invalid OTP code');
    }

    if (otp.expiresAt < new Date()) {
      throw new BadRequestException('OTP has expired');
    }

    if (otp.attempts >= 5) {
      throw new BadRequestException('Too many failed attempts. Request a new OTP.');
    }

    await this.otpModel.findByIdAndUpdate(otp._id, { verifiedAt: new Date() });

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
      throw new BadRequestException('Invalid or expired verification token');
    }

    if (payload.type !== 'otp_verification') {
      throw new BadRequestException('Invalid token type');
    }

    const phoneNumber = payload.sub;
    const user = await this.userModel.findOne({ phoneNumber });
    if (!user) {
      throw new BadRequestException('User not found');
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, 10);
    await this.userModel.findByIdAndUpdate(user._id, { password: hashedPassword });

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
    this.logger.log(`[SMS to ${phoneNumber}]: ${message}`);
  }
}
