import { IsString, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MESSAGE,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REGEX,
} from '../../../common/constants/password.const';
import { IsNotCommonPassword } from '../../../common/validators/is-not-common-password.validator';

export class ResetPasswordPhoneDto {
  @ApiProperty()
  @IsString()
  otpVerificationToken: string;

  @ApiProperty({ example: 'newSecurePassword123', minLength: PASSWORD_MIN_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_MESSAGE })
  @MaxLength(PASSWORD_MAX_LENGTH)
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  @IsNotCommonPassword()
  newPassword: string;
}
