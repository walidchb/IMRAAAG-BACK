import { IsString, MinLength, IsOptional, IsIn, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ALGERIAN_PHONE_REGEX, ALGERIAN_PHONE_MESSAGE } from '../../../common/constants/regex.const';

export class CustomerSignupDto {
  @ApiProperty({ example: '+213555123456' })
  @IsString()
  @Matches(ALGERIAN_PHONE_REGEX, { message: ALGERIAN_PHONE_MESSAGE })
  phoneNumber: string;

  @ApiProperty({ example: 'Fatima El Kahia' })
  @IsString()
  fullName: string;

  @ApiProperty({ example: 'securePassword123' })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiPropertyOptional({ enum: ['Male', 'Female'] })
  @IsOptional()
  @IsIn(['Male', 'Female'])
  gender?: string;
}
