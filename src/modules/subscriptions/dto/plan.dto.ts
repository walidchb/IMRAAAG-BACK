import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PlanLimitsDto {
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'null = unlimited' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxOrders?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'null = unlimited' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxProducts?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'null = unlimited' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxTeamMembers?: number | null;
}

export class PlanFeaturesDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  pos?: boolean;
}

export class PlanTrialDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @Type(() => Number)
  @ValidateIf((o: PlanTrialDto) => o.enabled === true)
  @IsInt()
  @Min(1)
  @Max(3650)
  days?: number | null;
}

export class CreatePlanDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ description: 'Integer DZD, >= 0' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  price: number;

  @ApiProperty({ enum: ['DZD'], default: 'DZD' })
  @IsIn(['DZD'])
  currency: 'DZD';

  @ApiProperty({ description: 'Integer days, >= 1' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  durationDays: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ default: false, description: 'At most one active default plan' })
  @IsOptional()
  @IsBoolean()
  isDefaultForSignup?: boolean;

  @ApiPropertyOptional({ type: PlanLimitsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlanLimitsDto)
  limits?: PlanLimitsDto;

  @ApiPropertyOptional({ type: PlanFeaturesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlanFeaturesDto)
  features?: PlanFeaturesDto;

  @ApiPropertyOptional({ type: PlanTrialDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlanTrialDto)
  trial?: PlanTrialDto;
}

/** Every commercial field is optional on edit; a change increments `version`. */
export class UpdatePlanDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  price?: number;

  @ApiPropertyOptional({ enum: ['DZD'] })
  @IsOptional()
  @IsIn(['DZD'])
  currency?: 'DZD';

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  durationDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefaultForSignup?: boolean;

  @ApiPropertyOptional({ type: PlanLimitsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlanLimitsDto)
  limits?: PlanLimitsDto;

  @ApiPropertyOptional({ type: PlanFeaturesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlanFeaturesDto)
  features?: PlanFeaturesDto;

  @ApiPropertyOptional({ type: PlanTrialDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlanTrialDto)
  trial?: PlanTrialDto;
}

export class UpdatePlanAvailabilityDto {
  @ApiProperty()
  @IsBoolean()
  isActive: boolean;
}

export const PLAN_SORTS = ['createdAt', 'name', 'price'] as const;

export class PlanQueryDto {
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

  @ApiPropertyOptional({ enum: ['active', 'inactive'] })
  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';

  @ApiPropertyOptional({ enum: PLAN_SORTS, default: 'createdAt' })
  @IsOptional()
  @IsIn(PLAN_SORTS)
  sort?: (typeof PLAN_SORTS)[number] = 'createdAt';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc' = 'desc';
}
