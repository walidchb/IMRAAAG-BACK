import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Browser pixels only (D2 in PLAN_PIXELS_MODULE.md): a Pixel ID is sufficient for both
 * Meta and TikTok. Access tokens are not part of this API — the server-side
 * Conversions/Events API path was removed.
 */
export class UpdateTrackingConfigDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(32)
  @Matches(/^\d{5,32}$/, { message: 'metaPixelId must be numeric' })
  metaPixelId?: string | null;

  @IsOptional()
  @IsBoolean()
  metaPixelEnabled?: boolean;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]{5,64}$/, { message: 'tikTokPixelId must be alphanumeric' })
  tikTokPixelId?: string | null;

  @IsOptional()
  @IsBoolean()
  tikTokPixelEnabled?: boolean;
}
