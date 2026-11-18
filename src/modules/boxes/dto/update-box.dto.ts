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
import { ApiPropertyOptional } from '@nestjs/swagger';
import { BoxEligibleItemDto } from './create-box.dto';

/**
 * Explicit partial update. Deliberately does NOT extend `CreateBoxDto`: the create DTO's
 * cross-field `AtLeastOneLanguage`/`AtLeastOneImage` validators would otherwise fire on a
 * price-only save. Name-family fallback and image presence are validated in the service
 * against the *merged* values.
 *
 * `storeId`, `vendorEmail`, `slug` and the archive fields are never accepted here.
 */
export class UpdateBoxDto {
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
  descriptionEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  descriptionAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  descriptionFr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  image?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  price?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  requiredQuantity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowDuplicates?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  published?: boolean;

  @ApiPropertyOptional({ type: [BoxEligibleItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BoxEligibleItemDto)
  eligibleItems?: BoxEligibleItemDto[];

  @ApiPropertyOptional({ description: 'Optimistic concurrency guard (ISO timestamp)' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  expectedUpdatedAt?: string;
}
