import { Controller, Post, Body } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { CustomerSignupDto } from './dto/customer-signup.dto';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResetPasswordPhoneDto } from './dto/reset-password-phone.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { RefreshDto } from './dto/refresh.dto';
import { Public } from './decorators/public.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 3, ttl: 3600000 } })
  @Post('register')
  @ApiOperation({ summary: 'Register a new vendor user' })
  @ApiResponse({ status: 201, description: 'User registered successfully' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  signup(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 300000 } })
  @Post('forgot-password')
  @ApiOperation({ summary: 'Request a password reset email' })
  @ApiResponse({ status: 201, description: 'If an account exists, a password reset email has been sent.' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 300000 } })
  @Post('reset-password')
  @ApiOperation({ summary: 'Reset password using token' })
  @ApiResponse({ status: 201, description: 'Password has been reset successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid or expired reset token' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 3600000 } })
  @Post('customer/register')
  @ApiOperation({ summary: 'Register a new customer user' })
  @ApiResponse({ status: 201, description: 'Customer registered successfully' })
  @ApiResponse({ status: 409, description: 'Phone number already registered' })
  customerRegister(@Body() dto: CustomerSignupDto) {
    return this.authService.customerRegister(dto);
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 300000 } })
  @Post('send-otp')
  @ApiOperation({ summary: 'Send OTP code to phone number' })
  @ApiResponse({ status: 201, description: 'OTP sent if account exists' })
  sendOtp(@Body() dto: SendOtpDto) {
    return this.authService.sendOtp(dto);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('verify-otp')
  @ApiOperation({ summary: 'Verify OTP code' })
  @ApiResponse({ status: 201, description: 'OTP verified, returns verification token' })
  @ApiResponse({ status: 400, description: 'Invalid or expired OTP' })
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 300000 } })
  @Post('reset-password-phone')
  @ApiOperation({ summary: 'Reset password using OTP verification token' })
  @ApiResponse({ status: 201, description: 'Password has been reset successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid or expired verification token' })
  resetPasswordPhone(@Body() dto: ResetPasswordPhoneDto) {
    return this.authService.resetPasswordPhone(dto);
  }

  @Public()
  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token using refresh token' })
  @ApiResponse({ status: 200, description: 'Tokens refreshed successfully' })
  @ApiResponse({ status: 401, description: 'Invalid refresh token' })
  refreshToken(@Body() dto: RefreshDto) {
    return this.authService.refreshAccessToken(dto);
  }
}
