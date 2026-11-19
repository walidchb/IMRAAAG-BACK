import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Store Subdomain plan, §5.2.
 *
 * The body carries the candidate label only. There is deliberately no `storeId`/`vendorEmail`
 * here: the target store is always derived from the authenticated session by the controller.
 * The `@Transform` is a convenience (trim/lowercase); the service normalizes again regardless,
 * so a caller that bypasses this DTO cannot store an unnormalized value.
 */
export class UpdateStoreSubdomainDto {
  @ApiProperty({ example: 'zainab', description: 'Lowercase subdomain label (3-30 chars)' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  subdomain: string;
}
