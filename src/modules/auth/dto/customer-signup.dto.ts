import { IsString, MinLength, MaxLength, IsOptional, IsIn, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ALGERIAN_PHONE_REGEX, ALGERIAN_PHONE_MESSAGE } from '../../../common/constants/regex.const';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MESSAGE,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REGEX,
} from '../../../common/constants/password.const';
import { IsNotCommonPassword } from '../../../common/validators/is-not-common-password.validator';

export class CustomerSignupDto {
  @ApiProperty({ example: '+213555123456' })
  @IsString()
  @Matches(ALGERIAN_PHONE_REGEX, { message: ALGERIAN_PHONE_MESSAGE })
  phoneNumber: string;

  @ApiProperty({ example: 'Fatima El Kahia' })
  @IsString()
  fullName: string;

  @ApiProperty({ example: 'securePassword123', minLength: PASSWORD_MIN_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_MESSAGE })
  @MaxLength(PASSWORD_MAX_LENGTH)
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  @IsNotCommonPassword()
  password: string;

  @ApiPropertyOptional({ enum: ['Male', 'Female'] })
  @IsOptional()
  @IsIn(['Male', 'Female'])
  gender?: string;
}
