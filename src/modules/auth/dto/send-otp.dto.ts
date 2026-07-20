import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SendOtpDto {
  @ApiProperty({ example: '+213555123456' })
  @IsString()
  phoneNumber: string;
}
