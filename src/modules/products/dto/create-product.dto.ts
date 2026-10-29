import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsBoolean,
  Min,
  IsArray,
  ValidateNested,
  IsMongoId,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AtLeastOneLanguage, AtLeastOneImage } from '../../../common/validators/at-least-one-language.validator';

/**
 * Variants are deliberately absent from this DTO.
 *
 * This DTO used to accept a `variants` array of option groups and persist it straight onto the
 * product, which was how a product ended up holding variant data while `hasVariants` stayed
 * `false`. Options and values are created through `POST /products/:productId/options` and
 * `/options/:optionId/values`, and the sellable combinations plus their stock are created by
 * the option/value/variant/balance factories.
 *
 * Every product is a variant product. When no options are supplied, the server creates a
 * single "Default/One Size" variant whose balance opens at zero; stock is owned by the
 * inventory module and adjusted through `GET/PATCH /inventory` afterwards, so the create
 * payload carries no stock figure.
 */
export class CreateProductDto {
  @AtLeastOneLanguage(['nameEn', 'nameAr', 'nameFr'], { message: 'At least one product name is required (English, Arabic, or French)' })
  @ApiProperty({ description: 'Product name (English)' })
  @IsOptional()
  @IsString()
  nameEn?: string;

  @ApiProperty({ description: 'Product name (Arabic)' })
  @IsOptional()
  @IsString()
  nameAr?: string;

  @ApiProperty({ description: 'Product name (French)' })
  @IsOptional()
  @IsString()
  nameFr?: string;

  @AtLeastOneLanguage(['storyEn', 'storyAr', 'storyFr'], { message: 'At least one product description is required (English, Arabic, or French)' })
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

  @ApiProperty({ description: 'Category ID' })
  @IsMongoId()
  @IsNotEmpty()
  category: string;

  @ApiProperty({ description: 'SubCategory ID' })
  @IsMongoId()
  @IsNotEmpty()
  subCategory: string;

  @ApiProperty({ description: 'Original price before discount' })
  @IsNumber()
  @Min(0)
  originalPrice: number;

  @ApiProperty({ description: 'Current selling price (defaults to originalPrice)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @ApiProperty({ description: 'Weight in kg' })
  @IsNumber()
  @Min(0)
  weight: number;

  @AtLeastOneImage({ message: 'At least one product image is required' })
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  image?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @ApiPropertyOptional({ default: false, description: 'Whether the product is publicly visible' })
  @IsOptional()
  @IsBoolean()
  published?: boolean;
}
