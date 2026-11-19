import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ANALYTICS_RANGE_PRESETS } from '../../analytics/constants/analytics.constants';
import { ITEM_VIEW_SCOPES, ITEM_VIEW_SORTS } from '../item-view.constants';

/**
 * Shared query for the vendor view reads.
 *
 * The whitelist rejects anything not declared here, so `storeId`/`vendorEmail` can never be
 * accepted from a caller — the store always comes from the session.
 */
export class ItemViewQueryDto {
  @ApiPropertyOptional({ enum: ANALYTICS_RANGE_PRESETS })
  @IsOptional()
  @IsIn([...ANALYTICS_RANGE_PRESETS])
  preset?: string;

  @ApiPropertyOptional({ description: 'ISO 8601 date; start when preset=custom.' })
  @IsOptional()
  @MaxLength(40)
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO 8601 date; exclusive end when preset=custom.' })
  @IsOptional()
  @MaxLength(40)
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ enum: ITEM_VIEW_SCOPES, default: 'all' })
  @IsOptional()
  @IsIn([...ITEM_VIEW_SCOPES])
  type?: 'all' | 'product' | 'box';

  @ApiPropertyOptional({ enum: ITEM_VIEW_SORTS, default: 'views' })
  @IsOptional()
  @IsIn([...ITEM_VIEW_SORTS])
  sort?: 'views' | 'unique';

  @ApiPropertyOptional({ description: 'Page size (1–100).', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Rows to skip.', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @ApiPropertyOptional({ enum: ['daily'], description: 'Include a zero-filled daily series.' })
  @IsOptional()
  @IsIn(['daily'])
  include?: 'daily';
}
