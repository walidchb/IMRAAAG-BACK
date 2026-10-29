import {
  IsString,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsMongoId,
  Min,
  IsArray,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AtLeastOneLanguage, AtLeastOneImage } from '../../../common/validators/at-least-one-language.validator';

/**
 * The embedded `variants` array that this DTO used to accept is gone, for the same reason it is
 * gone from `CreateProductDto`: it stored option groups with no stock, and writing it never
 * flipped `hasVariants`, so the product claimed to be simple while carrying variant data.
 *
 * `hasVariants` and `toggleVariants` are gone too. Every product is a variant product and its
 * stock is owned by the inventory balances, so a product update can no longer carry a `stock`
 * value or ask to change variant mode: those paths were how a simple product could hold a
 * competing stock number.
 */
export class UpdateProductDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  nameEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  nameAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  nameFr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  storyEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  storyAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  storyFr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  subCategory?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  originalPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @ApiPropertyOptional({ description: 'Low-stock alert threshold for the product' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  lowStockThreshold?: number;

  @ApiPropertyOptional({ description: 'Weight in kg' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  weight?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  image?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @ApiPropertyOptional({ description: 'Whether the product is publicly visible' })
  @IsOptional()
  @IsBoolean()
  published?: boolean;
}
