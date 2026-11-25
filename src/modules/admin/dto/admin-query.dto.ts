import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AdminStatus } from '../../../common/constants/admin-status.enum';

export const ADMIN_LIST_SORTS = ['createdAt', 'lastLoginAt', 'email', 'name'] as const;

export class AdminQueryDto {
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
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: [AdminStatus.ACTIVE, AdminStatus.DISABLED] })
  @IsOptional()
  @IsIn([AdminStatus.ACTIVE, AdminStatus.DISABLED])
  status?: AdminStatus;

  @ApiPropertyOptional({ enum: ADMIN_LIST_SORTS, default: 'createdAt' })
  @IsOptional()
  @IsIn(ADMIN_LIST_SORTS)
  sort?: (typeof ADMIN_LIST_SORTS)[number] = 'createdAt';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc' = 'desc';
}
