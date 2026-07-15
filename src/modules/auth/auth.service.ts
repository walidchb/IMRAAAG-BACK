import { Injectable, UnauthorizedException, ConflictException, BadRequestException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { User, UserDocument } from '../users/schemas/user.schema';
import { PasswordResetToken, PasswordResetTokenDocument } from './schemas/password-reset-token.schema';
import { Role } from '../../common/constants/roles.enum';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
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
    await this.userModel.findByIdAndUpdate(userId, { refreshToken: tokenHash });
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

    await this.userModel.findByIdAndUpdate(user._id, { lastLogin: new Date() });

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
}
