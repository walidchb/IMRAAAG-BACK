import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AtLeastOneImage,
  AtLeastOneLanguage,
} from '../../../common/validators/at-least-one-language.validator';

export class BoxEligibleItemDto {
  @ApiProperty({ description: 'Product id' })
  @IsString()
  @IsNotEmpty()
  @IsMongoId()
  productId: string;

  @ApiProperty({ description: 'Eligible variant ids', type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsMongoId({ each: true })
  variantIds: string[];
}

/**
 * A Box is created as a draft unless `published` is explicitly true. Ownership (`storeId`,
 * `vendorEmail`), `slug` and archive fields are server-derived and deliberately absent — the
 * global `forbidNonWhitelisted` pipe rejects a client that sends them.
 */
export class CreateBoxDto {
  @AtLeastOneLanguage(['nameEn', 'nameAr', 'nameFr'], {
    message: 'At least one Box name is required (English, Arabic, or French)',
  })
  @ApiPropertyOptional({ description: 'Box name (English)' })
  @IsOptional()
  @IsString()
  nameEn?: string;

  @ApiPropertyOptional({ description: 'Box name (Arabic)' })
  @IsOptional()
  @IsString()
  nameAr?: string;

  @ApiPropertyOptional({ description: 'Box name (French)' })
  @IsOptional()
  @IsString()
  nameFr?: string;

  @AtLeastOneLanguage(['descriptionEn', 'descriptionAr', 'descriptionFr'], {
    message: 'At least one Box description is required (English, Arabic, or French)',
  })
  @ApiPropertyOptional({ description: 'Box description (English)' })
  @IsOptional()
  @IsString()
  descriptionEn?: string;

  @ApiPropertyOptional({ description: 'Box description (Arabic)' })
  @IsOptional()
  @IsString()
  descriptionAr?: string;

  @ApiPropertyOptional({ description: 'Box description (French)' })
  @IsOptional()
  @IsString()
  descriptionFr?: string;

  @AtLeastOneImage({ message: 'At least one Box image is required' })
  @ApiPropertyOptional({ description: 'Primary image' })
  @IsOptional()
  @IsString()
  image?: string;

  @ApiPropertyOptional({ description: 'Gallery images', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @ApiProperty({ description: 'Fixed integer DZD price per complete Box' })
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  price: number;

  @ApiProperty({ description: 'Exactly how many items one Box contains (1–50)' })
  @IsInt()
  @Min(1)
  @Max(50)
  requiredQuantity: number;

  @ApiPropertyOptional({ default: true, description: 'Allow one variant to fill several units' })
  @IsOptional()
  @IsBoolean()
  allowDuplicates?: boolean;

  @ApiPropertyOptional({ default: false, description: 'Publish immediately' })
  @IsOptional()
  @IsBoolean()
  published?: boolean;

  @ApiProperty({ description: 'Explicit variant-level eligibility', type: [BoxEligibleItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BoxEligibleItemDto)
  eligibleItems: BoxEligibleItemDto[];
}
