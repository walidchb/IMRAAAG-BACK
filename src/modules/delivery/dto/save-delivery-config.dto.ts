import { IsString, IsOptional, IsBoolean, IsEnum, IsObject, IsDefined } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SaveDeliveryConfigDto {
  @ApiProperty()
  @IsString()
  companyId: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  credentials?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({ enum: ['enabled', 'disabled'] })
  @IsOptional()
  @IsEnum(['enabled', 'disabled'])
  status?: 'enabled' | 'disabled';

  /**
   * Pauses the carrier status poller for this company without deleting its credentials.
   *
   * The store keeps the configuration; the sync engine simply stops polling this provider
   * (Ecom/Recon plan, §E5).
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  statusSyncEnabled?: boolean;

  /**
   * Per-company carrier-state overrides: `{ '<carrier state>': '<normalized status>' }`.
   *
   * Only affects how a state is *displayed*, never how an order is moved. The value must be a
   * known normalized status; the service rejects anything else (E6).
   */
  @ApiPropertyOptional({ type: Object, additionalProperties: { type: 'string' } })
  @IsOptional()
  @IsObject()
  statusStateOverrides?: Record<string, string>;

  /**
   * Per-company signal overrides: `{ '<carrier state>': '<order signal>' }`.
   *
   * The escape hatch for a tenant whose workflow means something different from the shared
   * profile. The value must be one of `none | in_transit | delivered | cancelled | returned`.
   */
  @ApiPropertyOptional({ type: Object, additionalProperties: { type: 'string' } })
  @IsOptional()
  @IsObject()
  statusSignalOverrides?: Record<string, string>;
}

export class SaveAttributionsDto {
  @ApiProperty({ type: Object, additionalProperties: { type: 'string' } })
  @IsDefined()
  @IsObject()
  attributions: Record<string, string>;
}
