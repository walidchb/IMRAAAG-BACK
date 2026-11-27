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

  @ApiPropertyOptional({
    description: 'Billing duration in months (1, 3, 6 or 12). Required for monthly plans.',
    enum: [1, 3, 6, 12],
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([1, 3, 6, 12])
  durationMonths?: number;

  @ApiPropertyOptional({ description: 'Deprecated: use durationMonths.' })
  @IsOptional()
  @IsMongoId()
  billingOptionId?: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Admin-only negotiated total price (0..listPrice). Snapshotted, not applied to the plan.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  agreedPriceOverride?: number | null;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    description:
      'Prepend the plan trial (plan.trial.days) before the paid period. The trial starts now, the paid period starts when it ends.',
  })
  @IsOptional()
  @IsBoolean()
  includeTrial?: boolean;

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
  @ApiPropertyOptional({
    description: 'Billing duration in months (1, 3, 6 or 12). Required for monthly plans.',
    enum: [1, 3, 6, 12],
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([1, 3, 6, 12])
  durationMonths?: number;

  @ApiPropertyOptional({ description: 'Deprecated: use durationMonths.' })
  @IsOptional()
  @IsMongoId()
  billingOptionId?: string;

  @ApiPropertyOptional({
    description:
      'Prepend the new plan trial (plan.trial.days) before the paid period. Off = paid period starts now.',
  })
  @IsOptional()
  @IsBoolean()
  includeTrial?: boolean;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ExtendSubscriptionDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 36,
    description: 'Preferred. Adds calendar months and the corresponding orders allowance.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(36)
  months?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 3650,
    description: 'Legacy/compat. Adds days and a prorated orders allowance.',
  })
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

export class CancelSubscriptionDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ReactivateSubscriptionDto {
  @ApiPropertyOptional({
    description: 'Billing duration in months (1, 3, 6 or 12) for a monthly plan.',
    enum: [1, 3, 6, 12],
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([1, 3, 6, 12])
  durationMonths?: number;

  @ApiPropertyOptional({ description: 'Deprecated: use durationMonths.' })
  @IsOptional()
  @IsMongoId()
  billingOptionId?: string;

  @ApiPropertyOptional({
    description: 'Reuse the snapshot billing terms when the original option is gone/inactive.',
  })
  @IsOptional()
  @IsBoolean()
  sameTerms?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 36, description: 'Override period in calendar months' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(36)
  months?: number;

  @ApiPropertyOptional({ minimum: 1, description: 'Override period in days (legacy)' })
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
