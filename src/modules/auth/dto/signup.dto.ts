import { IsEmail, IsString, MinLength, MaxLength, Matches, IsOptional, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MESSAGE,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REGEX,
} from '../../../common/constants/password.const';
import { IsNotCommonPassword } from '../../../common/validators/is-not-common-password.validator';

export class SignupDto {
  @ApiProperty({ example: 'Fatima El Kahia' })
  @IsString()
  fullName: string;

  @ApiProperty({ example: 'fatima@imraaah-vendors.ma' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: '+212665890044', required: false })
  @IsString()
  @IsOptional()
  phoneNumber?: string;

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
