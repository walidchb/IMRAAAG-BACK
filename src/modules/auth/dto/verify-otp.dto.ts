import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyOtpDto {
  @ApiProperty({ example: '+213555123456' })
  @IsString()
  phoneNumber: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  code: string;
}
