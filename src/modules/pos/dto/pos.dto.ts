import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Query for the POS catalog (roadmap Phase 1).
 *
 * `q` spans three fields across two collections — the product name (any language), the
 * variant SKU and the variant barcode — because a cashier has one box and may type any of
 * them. `cursor` is the last `productId` of the previous page rather than a timestamp:
 * the catalog is grouped by product, so paging on anything finer would split a product's
 * variants across two pages.
 */
export class PosProductQueryDto {
  @ApiPropertyOptional({ description: 'Matches product name (any language), SKU or barcode' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Product id to page forward from (exclusive)' })
  @IsOptional()
  @IsMongoId()
  cursor?: string;
}
