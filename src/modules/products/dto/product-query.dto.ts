import { IsOptional, IsInt, Min, Max, IsString, IsNumber, IsIn, IsMongoId, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CursorDto {
  @ApiPropertyOptional({ description: 'createdAt of the last item' })
  @IsString()
  createdAt: string;

  @ApiPropertyOptional({ description: '_id of the last item' })
  @IsString()
  _id: string;
}

export class ProductQueryDto {
  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'JSON stringified cursor object { createdAt, _id }' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subCategory?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vendorEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({ enum: ['price_asc', 'price_desc', 'newest', 'name'] })
  @IsOptional()
  @IsIn(['price_asc', 'price_desc', 'newest', 'name'])
  sortBy?: string;
}
