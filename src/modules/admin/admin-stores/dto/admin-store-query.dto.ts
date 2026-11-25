import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  StoreAdminStatus,
  StoreOwnerStatus,
} from '../../../stores/schemas/store-status.enum';

export const ADMIN_STORE_STATUSES = [
  StoreAdminStatus.ACTIVE,
  StoreAdminStatus.SUSPENDED,
] as const;
export const ADMIN_STORE_OWNER_STATUSES = [
  StoreOwnerStatus.ENABLED,
  StoreOwnerStatus.DISABLED,
] as const;
export const ADMIN_STORE_SORTS = ['createdAt', 'storeName'] as const;

export class AdminStoreQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ enum: ADMIN_STORE_STATUSES })
  @IsOptional()
  @IsIn(ADMIN_STORE_STATUSES)
  adminStatus?: (typeof ADMIN_STORE_STATUSES)[number];

  @ApiPropertyOptional({ enum: ADMIN_STORE_OWNER_STATUSES })
  @IsOptional()
  @IsIn(ADMIN_STORE_OWNER_STATUSES)
  ownerStatus?: (typeof ADMIN_STORE_OWNER_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  wilaya?: string;

  @ApiPropertyOptional({ enum: ADMIN_STORE_SORTS, default: 'createdAt' })
  @IsOptional()
  @IsIn(ADMIN_STORE_SORTS)
  sort?: (typeof ADMIN_STORE_SORTS)[number] = 'createdAt';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc' = 'desc';
}
