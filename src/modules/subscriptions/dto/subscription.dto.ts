import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AssignSubscriptionDto {
  @ApiProperty()
  @IsMongoId()
  storeId: string;

  @ApiProperty()
  @IsMongoId()
  planId: string;

  @ApiPropertyOptional({ description: 'Required to replace an active/trialing subscription' })
  @IsOptional()
  @IsBoolean()
  replace?: boolean;
}

export class TrialSubscriptionDto {
  @ApiProperty()
  @IsMongoId()
  storeId: string;

  @ApiProperty()
  @IsMongoId()
  planId: string;

  @ApiPropertyOptional({ description: 'Required to replace an active/trialing subscription' })
  @IsOptional()
  @IsBoolean()
  replace?: boolean;
}

export class ChangePlanDto {
  @ApiProperty()
  @IsMongoId()
  planId: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ExtendSubscriptionDto {
  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  days: number;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CancelSubscriptionDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ReactivateSubscriptionDto {
  @ApiPropertyOptional({ minimum: 1, description: 'Defaults to the snapshot duration' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  days?: number;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export const SUBSCRIPTION_STATUS_FILTERS = [
  'active',
  'trialing',
  'expired',
  'cancelled',
] as const;

export class SubscriptionQueryDto {
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

  @ApiPropertyOptional({ description: 'Search store name/slug/email or seller email/name' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  planId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  storeId?: string;

  @ApiPropertyOptional({ enum: SUBSCRIPTION_STATUS_FILTERS })
  @IsOptional()
  @IsIn(SUBSCRIPTION_STATUS_FILTERS)
  status?: (typeof SUBSCRIPTION_STATUS_FILTERS)[number];

  @ApiPropertyOptional({ enum: ['yes', 'no'] })
  @IsOptional()
  @IsIn(['yes', 'no'])
  trial?: 'yes' | 'no';

  @ApiPropertyOptional({ description: 'ISO date; filters by period start' })
  @IsOptional()
  @IsString()
  startFrom?: string;

  @ApiPropertyOptional({ description: 'ISO date; filters by period start' })
  @IsOptional()
  @IsString()
  startTo?: string;
}
