import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  ANALYTICS_TOP_PRODUCTS_DEFAULT_LIMIT,
  ANALYTICS_TOP_PRODUCTS_MAX_LIMIT,
} from '../constants/analytics.constants';
import { AnalyticsRangeQueryDto } from './analytics-query.dto';

/**
 * Shared range query plus the top-products limit. The inherited `metric` already accepts
 * sales|orders|units; `products()` defaults it to `units`.
 */
export class AnalyticsProductsQueryDto extends AnalyticsRangeQueryDto {
  @ApiPropertyOptional({
    description: 'Number of top products to return (1–50).',
    default: ANALYTICS_TOP_PRODUCTS_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ANALYTICS_TOP_PRODUCTS_MAX_LIMIT)
  limit?: number;
}
