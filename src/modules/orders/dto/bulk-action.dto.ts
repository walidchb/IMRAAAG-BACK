import { IsString, IsNotEmpty, IsArray, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class BulkActionDto {
  @ApiProperty({ description: 'Array of order IDs' })
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  ids: string[];

  @ApiProperty({
    enum: ['confirm', 'cancel', 'delete', 'archive', 'restore'],
    description: 'Action to perform (delete is deprecated in favour of archive)',
  })
  @IsString()
  @IsIn(['confirm', 'cancel', 'delete', 'archive', 'restore'])
  action: 'confirm' | 'cancel' | 'delete' | 'archive' | 'restore';
}
