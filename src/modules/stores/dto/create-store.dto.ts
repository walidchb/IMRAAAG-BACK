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
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SocialMediaDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  instagram?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  facebook?: string;

  @ApiPropertyOptional()
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

  @ApiPropertyOptional({ description: 'Vendor user ID' })
  @IsOptional()
  @IsMongoId()
  vendorId?: string;

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

  @ApiPropertyOptional({ description: 'Contact email' })
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

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
  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  storeLogo?: string;

  @ApiPropertyOptional({ description: 'Cover image URL' })
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
