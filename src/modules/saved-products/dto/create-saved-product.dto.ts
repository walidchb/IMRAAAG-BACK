import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateSavedProductDto {
  @ApiProperty({ description: 'Product ID to save' })
  @IsString()
  @IsNotEmpty()
  productId: string;
}
