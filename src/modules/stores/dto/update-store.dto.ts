import { StoreStatus } from '../schemas/store-status.enum';
import {
  IsString,
  IsOptional,
  IsEmail,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  IsIn,
  MaxLength,
  IsUrl,
  IsBoolean,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Treats an empty/whitespace-only string as "not provided".
 *
 * `@IsOptional()` only skips validators for `null`/`undefined` - an empty string still runs
 * them, so the vendor edit form (which posts `storeLogo: ''`/`coverImage: ''` for a store
 * that has no image yet) was rejected by `@IsUrl()`/`@IsEmail()` with a 400. Optional
 * fields must tolerate being cleared.
 */
const EmptyToUndefined = () =>
  Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? undefined : value));

export class SocialMediaDto {
  @ApiPropertyOptional()
  @EmptyToUndefined()
  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  instagram?: string;

  @ApiPropertyOptional()
  @EmptyToUndefined()
  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  facebook?: string;

  @ApiPropertyOptional()
  @EmptyToUndefined()
  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  tiktok?: string;
}

class UpdateAddressDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  street?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  postalCode?: string;
}

export class UpdateStoreDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  storeName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @EmptyToUndefined()
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  contactPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  contactPhones?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  commune?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => SocialMediaDto)
  socialMedia?: SocialMediaDto;

  @ApiPropertyOptional({ enum: StoreStatus })
  @IsOptional()
  @IsString()
  @IsIn(Object.values(StoreStatus))
  status?: string;

  @ApiPropertyOptional({
    description: 'Opt this store into variant inventory. Default false.',
  })
  @IsOptional()
  @IsBoolean()
  inventoryEnabled?: boolean;

  @ApiPropertyOptional()
  @EmptyToUndefined()
  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  storeLogo?: string;

  @ApiPropertyOptional()
  @EmptyToUndefined()
  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  coverImage?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  wilaya?: string;

  @ApiPropertyOptional({ description: 'Store categories (max 3)' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(3)
  categories?: string[];

  @ApiPropertyOptional({ description: 'Store tagline (one phrase)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  tagline?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateAddressDto)
  address?: UpdateAddressDto;
}
