import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshDto {
  @ApiProperty({ example: 'a1b2c3d4e5f6...' })
  @IsString()
  refreshToken: string;
}
