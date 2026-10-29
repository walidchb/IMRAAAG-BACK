import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  ANALYTICS_BUCKETS,
  ANALYTICS_CHANNELS,
  ANALYTICS_RANGE_PRESETS,
  ANALYTICS_TREND_METRICS,
} from '../constants/analytics.constants';

/**
 * Shared query for every analytics read (roadmap Phase 0).
 *
 * Validation mirrors the metric dictionary: only the presets/buckets/channels those constants
 * define are accepted, so a typo becomes a 400 rather than a silently different dashboard.
 * `preset=custom` is answered from `from`/`to`; the service falls back to the default preset
 * when those are missing instead of failing mid-navigation.
 */
export class AnalyticsRangeQueryDto {
  @ApiPropertyOptional({
    enum: ANALYTICS_RANGE_PRESETS,
    description: 'Range preset. `custom` requires `from` and `to`.',
  })
  @IsOptional()
  @IsString()
  @IsIn([...ANALYTICS_RANGE_PRESETS])
  preset?: string;

  @ApiPropertyOptional({ description: 'ISO 8601 date. Start (inclusive) when preset=custom.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO 8601 date. End (exclusive) when preset=custom.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ enum: ANALYTICS_BUCKETS, description: 'Trend bucket granularity.' })
  @IsOptional()
  @IsString()
  @IsIn([...ANALYTICS_BUCKETS])
  bucket?: string;

  @ApiPropertyOptional({ enum: ANALYTICS_CHANNELS, default: 'all' })
  @IsOptional()
  @IsString()
  @IsIn([...ANALYTICS_CHANNELS])
  channel?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'Compare against the previous period.' })
  @IsOptional()
  @IsString()
  @IsIn(['true', 'false'])
  compare?: string;

  /**
   * Trend primary metric (Phase 2). Only `sales` additionally costs the response with the
   * gross/discount breakdown. Accepted (and ignored) on the summary/channels reads because
   * they share one query contract.
   */
  @ApiPropertyOptional({ enum: ANALYTICS_TREND_METRICS, default: 'sales' })
  @IsOptional()
  @IsString()
  @IsIn([...ANALYTICS_TREND_METRICS])
  metric?: string;
}
