import { IsString, IsNumber, IsOptional, Min, IsObject, IsDefined } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateDeliveryFeeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  homeDeliveryFee?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  stopDeskDeliveryFee?: number;
}

export class BulkUpdateDeliveryFeeDto {
  @ApiProperty({ type: Object, additionalProperties: { type: 'object' } })
  @IsDefined()
  @IsObject()
  fees: Record<string, { homeDeliveryFee?: number; stopDeskDeliveryFee?: number }>;
}
