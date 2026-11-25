import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StoreAdminStatus } from '../../../stores/schemas/store-status.enum';

/**
 * The admin-controlled status only. The owner-controlled status is never writable from the
 * admin panel, and the legacy shared `status` field is not accepted from any client.
 */
export class UpdateAdminStoreStatusDto {
  @ApiProperty({ enum: [StoreAdminStatus.ACTIVE, StoreAdminStatus.SUSPENDED] })
  @IsIn([StoreAdminStatus.ACTIVE, StoreAdminStatus.SUSPENDED])
  adminStatus: StoreAdminStatus.ACTIVE | StoreAdminStatus.SUSPENDED;

  /** Optional explanation retained on the store and shown to the seller. */
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
