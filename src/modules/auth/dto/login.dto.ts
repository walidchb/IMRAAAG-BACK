import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'fatima@imraaah-vendors.ma' })
  @IsString()
  identifier: string;

  @ApiProperty({ example: 'securePassword123' })
  @IsString()
  password: string;
}
