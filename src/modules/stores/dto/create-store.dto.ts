import { StoreStatus } from '../schemas/store-status.enum';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  IsIn,
  MaxLength,
  IsMongoId,
  IsUrl,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Treats an empty/whitespace-only string as "not provided".
 *
 * `@IsOptional()` only skips validators for `null`/`undefined` - an empty string still runs
 * them, so a blank optional field sent by the client (e.g. a store with no logo posting
 * `storeLogo: ''`) was rejected by `@IsUrl()`/`@IsEmail()` with a 400. Optional fields must
 * tolerate being cleared.
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

class AddressDto {
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

export class CreateStoreDto {
  @ApiProperty({ description: 'Vendor email address' })
  @IsEmail()
  @IsNotEmpty()
  vendorEmail: string;

  // NOTE: `vendorId` is deliberately NOT part of this DTO.
  //
  // It used to be an optional client-supplied field, which meant any caller could
  // create a store claiming another vendor's user id. `findByVendorIdOrThrow()` is what
  // resolves ownership for tracking settings (and anything else keyed on the session),
  // so claiming a victim's `vendorId` handed the caller that victim's store.
  // Ownership is now always derived from the session by the controller - see
  // `StoresController.createMine()`. Do not re-add this field.

  @ApiProperty({ description: 'Store name' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  storeName: string;

  @ApiPropertyOptional({ description: 'Store slug (auto-generated if not provided)' })
  @IsOptional()
  @IsString()
  storeSlug?: string;

  @ApiPropertyOptional({ description: 'Store description' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ description: 'Contact email (required)' })
  @EmptyToUndefined()
  @IsEmail()
  contactEmail: string;

  @ApiProperty({ description: 'Contact phone' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  contactPhone: string;

  @ApiPropertyOptional({ description: 'Contact phones array' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  contactPhones?: string[];

  @ApiPropertyOptional({ description: 'Commune' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  commune?: string;

  @ApiPropertyOptional({ description: 'Social media links' })
  @IsOptional()
  @ValidateNested()
  @Type(() => SocialMediaDto)
  socialMedia?: SocialMediaDto;

  @ApiPropertyOptional({ description: 'Store status', enum: StoreStatus })
  @IsOptional()
  @IsString()
  @IsIn(Object.values(StoreStatus))
  status?: string;

  @ApiPropertyOptional({ description: 'Store logo URL' })
  @EmptyToUndefined()
  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  storeLogo?: string;

  @ApiPropertyOptional({ description: 'Cover image URL' })
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

  @ApiPropertyOptional({ description: 'Address' })
  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;
}
