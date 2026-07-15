import { IsEmail, IsString, MinLength, IsOptional, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  @ApiProperty({ example: 'securePassword123' })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiPropertyOptional({ enum: ['Male', 'Female'] })
  @IsOptional()
  @IsIn(['Male', 'Female'])
  gender?: string;
}
