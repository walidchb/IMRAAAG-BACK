import { IsMongoId } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AdminIdParamDto {
  @ApiProperty()
  @IsMongoId()
  id: string;
}
