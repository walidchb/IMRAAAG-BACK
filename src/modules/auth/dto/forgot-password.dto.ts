import { IsEmail } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'fatima@imraaah-vendors.ma' })
  @IsEmail()
  email: string;
}
