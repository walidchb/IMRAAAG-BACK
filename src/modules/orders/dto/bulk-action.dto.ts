import { IsString, IsNotEmpty, IsArray, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class BulkActionDto {
  @ApiProperty({ description: 'Array of order IDs' })
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  ids: string[];

  @ApiProperty({ enum: ['confirm', 'cancel', 'delete'], description: 'Action to perform' })
  @IsString()
  @IsIn(['confirm', 'cancel', 'delete'])
  action: 'confirm' | 'cancel' | 'delete';
}
