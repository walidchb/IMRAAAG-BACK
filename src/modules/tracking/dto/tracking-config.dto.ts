import { IsOptional, IsString, IsBoolean } from 'class-validator';

export class UpdateTrackingConfigDto {
  @IsOptional()
  @IsString()
  metaPixelId?: string;

  @IsOptional()
  @IsString()
  metaAccessToken?: string;

  @IsOptional()
  @IsBoolean()
  metaPixelEnabled?: boolean;

  @IsOptional()
  @IsString()
  tikTokPixelId?: string;

  @IsOptional()
  @IsString()
  tikTokAccessToken?: string;

  @IsOptional()
  @IsBoolean()
  tikTokPixelEnabled?: boolean;
}

export class SendEventDto {
  @IsString()
  eventName: string;

  @IsOptional()
  eventId?: string;

  @IsOptional()
  eventSourceUrl?: string;

  @IsOptional()
  userEmail?: string;

  @IsOptional()
  userPhone?: string;

  @IsOptional()
  value?: number;

  @IsOptional()
  currency?: string;

  @IsOptional()
  contentIds?: string[];

  @IsOptional()
  contentType?: string;

  @IsOptional()
  numItems?: number;
}
