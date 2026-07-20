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

class VariantOptionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  id?: string;

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
  value?: string;
}

class VariantDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  id?: string;

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

  @ApiPropertyOptional({ enum: ['generic', 'color'] })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({ type: [VariantOptionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VariantOptionDto)
  options?: VariantOptionDto[];
}

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

  @ApiProperty({ description: 'Stock quantity', default: 0 })
  @IsNumber()
  @Min(0)
  stock: number;

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

  @ApiPropertyOptional({ enum: ['Active', 'Draft'], default: 'Active' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ default: false, description: 'Whether the product is publicly visible' })
  @IsOptional()
  @IsBoolean()
  published?: boolean;

  @ApiPropertyOptional({ type: [VariantDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VariantDto)
  variants?: VariantDto[];
}
