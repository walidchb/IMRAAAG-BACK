import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AdminStatus } from '../../../common/constants/admin-status.enum';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MESSAGE,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REGEX,
} from '../../../common/constants/password.const';
import { IsNotCommonPassword } from '../../../common/validators/is-not-common-password.validator';

export class CreateAdminDto {
  @ApiProperty({ example: 'Amina' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 80)
  firstName: string;

  @ApiProperty({ example: 'Bensalem' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 80)
  lastName: string;

  @ApiProperty({ example: 'amina@imraaah.com' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ example: 'securePassword123', minLength: PASSWORD_MIN_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_MESSAGE })
  @MaxLength(PASSWORD_MAX_LENGTH)
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  @IsNotCommonPassword()
  password: string;

  @ApiPropertyOptional({ enum: [AdminStatus.ACTIVE, AdminStatus.DISABLED] })
  @IsOptional()
  @IsIn([AdminStatus.ACTIVE, AdminStatus.DISABLED])
  status?: AdminStatus = AdminStatus.ACTIVE;
}
