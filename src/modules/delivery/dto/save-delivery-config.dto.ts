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
}

export class SaveAttributionsDto {
  @ApiProperty({ type: Object, additionalProperties: { type: 'string' } })
  @IsDefined()
  @IsObject()
  attributions: Record<string, string>;
}
