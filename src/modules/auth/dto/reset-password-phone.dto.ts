import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ResetPasswordPhoneDto {
  @ApiProperty()
  @IsString()
  otpVerificationToken: string;

  @ApiProperty({ example: 'newSecurePassword123' })
  @IsString()
  @MinLength(6)
  newPassword: string;
}
