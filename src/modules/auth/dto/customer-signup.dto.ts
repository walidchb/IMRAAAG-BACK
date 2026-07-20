import { IsString, MinLength, IsOptional, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CustomerSignupDto {
  @ApiProperty({ example: '+213555123456' })
  @IsString()
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
