import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsInt,
  ValidateNested,
  IsArray,
  Min,
  Max,
  ArrayMinSize,
  MaxLength,
  IsMongoId,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One line of an in-store sale. Only `variantId` and `quantity` are trusted: the variant
 * identifies the SKU and the server prices it (variant override, then product price) exactly
 * as `CreateOrderDto` does, so a tampered `price` can never change what is charged.
 */
class PosSaleItemDto {
  @ApiProperty({ description: 'Ordered variant id' })
  @IsString()
  @IsNotEmpty()
  @IsMongoId()
  variantId: string;

  @ApiProperty({ description: 'Quantity', minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(100000)
  quantity: number;

  /**
   * Accepted only so a client that echoes the catalog price is not rejected by the
   * `forbidNonWhitelisted` pipe. Deliberately ignored server-side.
   */
  @ApiPropertyOptional({ description: 'Ignored — the server prices the line' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;
}

/**
 * The buyer of a walk-in sale. All fields optional: a POS sale is often anonymous, so the
 * order falls back to a "Walk-in" placeholder. There is deliberately no wilaya/commune —
 * a POS sale is `pickup` and never shipped.
 */
class PosSaleCustomerDto {
  @ApiPropertyOptional({ description: 'Customer name' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: 'Customer phone' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ description: 'Customer email' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  email?: string;

  @ApiPropertyOptional({ description: 'Customer note' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class CreatePosSaleDto {
  @ApiProperty({ description: 'Sale items', type: [PosSaleItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PosSaleItemDto)
  items: PosSaleItemDto[];

  @ApiPropertyOptional({ description: 'Optional buyer details', type: PosSaleCustomerDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PosSaleCustomerDto)
  customer?: PosSaleCustomerDto;

  @ApiPropertyOptional({ description: 'Sale note' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
