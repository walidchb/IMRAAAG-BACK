import {
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Public storefront listing: one store at a time, cursor-paginated, newest-first. */
export class BoxQueryDto {
  @ApiProperty({ description: 'Store id' })
  @IsMongoId()
  storeId: string;

  @ApiPropertyOptional({ default: 20, description: 'Items per page (1–100)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from the previous page' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ description: 'Match against the localized Box names' })
  @IsOptional()
  @IsString()
  search?: string;
}

/** Vendor listing: offset pagination plus a status filter. */
export class VendorBoxQueryDto {
  @ApiPropertyOptional({ default: 20, description: 'Items per page (1–100)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: ['active', 'draft', 'archived'] })
  @IsOptional()
  @IsIn(['active', 'draft', 'archived'])
  status?: 'active' | 'draft' | 'archived';
}
