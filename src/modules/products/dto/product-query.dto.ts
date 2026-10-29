import { IsOptional, IsInt, Min, Max, IsString, IsNumber, IsIn, IsMongoId, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CursorDto {
  @ApiPropertyOptional({ description: 'createdAt of the last item' })
  @IsString()
  createdAt: string;

  @ApiPropertyOptional({ description: '_id of the last item' })
  @IsString()
  _id: string;
}

export class ProductQueryDto {
  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'JSON stringified cursor object { createdAt, _id }' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subCategory?: string;

  @ApiPropertyOptional({ description: 'Legacy. Prefer storeId.' })
  @IsOptional()
  @IsString()
  vendorEmail?: string;

  @ApiPropertyOptional({ description: 'Preferred. Stable store identifier.' })
  @IsOptional()
  @IsString()
  @IsMongoId()
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({ enum: ['price_asc', 'price_desc', 'newest', 'name'] })
  @IsOptional()
  @IsIn(['price_asc', 'price_desc', 'newest', 'name'])
  sortBy?: string;
}

export class VendorProductQueryDto {
  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  // Offset pagination, mirroring `GET /orders`: the vendor product page renders a page
  // selector and a "showing X–Y of Z" total, which a cursor cannot express.
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subCategory?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({ enum: ['price_asc', 'price_desc', 'newest', 'name'] })
  @IsOptional()
  @IsIn(['price_asc', 'price_desc', 'newest', 'name'])
  sortBy?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  published?: string;
}

/**
 * Query for the inventory search box's product suggestions (autocomplete).
 *
 * `q` is required rather than optional: a suggestion request with nothing to match is a
 * mistake, and answering it with the whole catalogue is exactly the expensive shape this
 * endpoint exists to avoid. A blank-but-present `q` is allowed through and answered with
 * an empty list instead of a 400, so a race between clearing the box and cancelling the
 * request cannot surface as an error in the UI.
 *
 * `limit` is capped at 20 because the consumer is a dropdown, never a page.
 */
export class ProductSuggestionQueryDto {
  @ApiProperty({ description: 'Text matched against product names (any language) and slug' })
  @IsString()
  @MaxLength(120)
  q: string;

  @ApiPropertyOptional({ default: 8, minimum: 1, maximum: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number = 8;
}
