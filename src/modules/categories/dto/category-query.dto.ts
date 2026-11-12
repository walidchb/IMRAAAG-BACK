import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Public category lookup requires exactly one store reference. Priority is
 * `storeId` → `storeSlug` → `vendorEmail`; with none the controller returns `[]`
 * (there is no marketplace-wide category list any more).
 */
export class CategoryQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  storeSlug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  vendorEmail?: string;
}
