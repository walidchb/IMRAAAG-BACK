import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SetOnHandDto {
  @ApiProperty({ description: 'Absolute units on hand after the change', minimum: 0 })
  @IsInt()
  @Min(0)
  quantity: number;

  @ApiProperty({
    description: 'Seller-supplied reason, stored on the movement. Required by spec.',
    example: 'Initial stock count',
  })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiPropertyOptional({ description: 'Optional seller note. Must not contain customer PII.' })
  @IsOptional()
  @IsString()
  note?: string;

  @ApiPropertyOptional({ description: 'Makes a retried request a no-op instead of a double count' })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class AdjustDeltaDto {
  @ApiProperty({ description: 'Signed change to on-hand. May be negative.', example: -3 })
  @IsInt()
  delta: number;

  @ApiProperty({ example: 'Damaged in transit' })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class BulkAdjustItemDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  variantId: string;

  @ApiPropertyOptional({ description: 'Absolute set. Mutually exclusive with delta.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  quantity?: number;

  @ApiPropertyOptional({ description: 'Signed delta. Mutually exclusive with quantity.' })
  @IsOptional()
  @IsInt()
  delta?: number;
}

export class BulkAdjustDto {
  @ApiProperty({ type: [BulkAdjustItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkAdjustItemDto)
  items: BulkAdjustItemDto[];

  @ApiProperty({ example: 'Weekly stock count' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class ListMovementsQueryDto {
  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ description: 'Movement id to page backwards from' })
  @IsOptional()
  @IsString()
  cursor?: string;
}