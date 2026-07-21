import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as crypto from 'crypto';
import { TrackingConfig, TrackingConfigDocument } from './schemas/tracking-config.schema';
import { UpdateTrackingConfigDto, SendEventDto } from './dto/tracking-config.dto';

interface MetaEventPayload {
  data: Array<{
    event_name: string;
    event_time: number;
    event_id?: string;
    action_source: string;
    event_source_url?: string;
    user_data: Record<string, string[] | string>;
    custom_data?: Record<string, unknown>;
  }>;
}

interface TikTokEventPayload {
  event_source: string;
  event_source_id: string;
  data: Array<{
    event: string;
    event_time: number;
    event_id?: string;
    user: Record<string, string[] | string>;
    properties?: Record<string, unknown>;
  }>;
}

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);
  private readonly metaApiBase = 'https://graph.facebook.com/v22.0';
  private readonly tikTokApiBase = 'https://business-api.tiktok.com/open_api/v1.3';

  constructor(
    @InjectModel(TrackingConfig.name)
    private configModel: Model<TrackingConfigDocument>,
  ) {}

  async getConfig(vendorEmail: string): Promise<TrackingConfig> {
    const config = await this.configModel.findOne({ vendorEmail }).exec();
    if (!config) {
      return {
        vendorEmail,
        metaPixelId: null,
        metaAccessToken: null,
        metaPixelEnabled: false,
        tikTokPixelId: null,
        tikTokAccessToken: null,
        tikTokPixelEnabled: false,
      } as TrackingConfig;
    }
    return config;
  }

  async updateConfig(vendorEmail: string, dto: UpdateTrackingConfigDto): Promise<TrackingConfig> {
    return this.configModel.findOneAndUpdate(
      { vendorEmail },
      { $set: { vendorEmail, ...dto } },
      { upsert: true, new: true },
    ).exec();
  }

  async sendEvent(
    vendorEmail: string,
    dto: SendEventDto,
    clientIp?: string,
    userAgent?: string,
  ): Promise<{ meta: boolean; tikTok: boolean }> {
    const config = await this.getConfig(vendorEmail);
    const results = { meta: false, tikTok: false };

    const tasks: Promise<void>[] = [];

    if (config.metaPixelEnabled && config.metaPixelId && config.metaAccessToken) {
      tasks.push(
        this.forwardToMeta(config, dto, clientIp, userAgent)
          .then(() => { results.meta = true; })
          .catch((err) => {
            this.logger.error(`Meta event failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
          }),
      );
    }

    if (config.tikTokPixelEnabled && config.tikTokPixelId && config.tikTokAccessToken) {
      tasks.push(
        this.forwardToTikTok(config, dto, clientIp, userAgent)
          .then(() => { results.tikTok = true; })
          .catch((err) => {
            this.logger.error(`TikTok event failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
          }),
      );
    }

    await Promise.allSettled(tasks);
    return results;
  }

  private hashEmail(email: string): string {
    return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  }

  private hashPhone(phone: string): string {
    const cleaned = phone.replace(/[^0-9]/g, '');
    return crypto.createHash('sha256').update(cleaned).digest('hex');
  }

  private async forwardToMeta(
    config: TrackingConfig,
    dto: SendEventDto,
    clientIp?: string,
    userAgent?: string,
  ): Promise<void> {
    const userData: Record<string, string[] | string> = {
      client_ip_address: clientIp || '0.0.0.0',
      client_user_agent: userAgent || '',
    };

    if (dto.userEmail) {
      userData.em = [this.hashEmail(dto.userEmail)];
    }
    if (dto.userPhone) {
      userData.ph = [this.hashPhone(dto.userPhone)];
    }

    const customData: Record<string, unknown> = {};
    if (dto.value !== undefined) customData.value = dto.value;
    if (dto.currency) customData.currency = dto.currency;
    if (dto.contentIds) customData.content_ids = dto.contentIds;
    if (dto.contentType) customData.content_type = dto.contentType;
    if (dto.numItems !== undefined) customData.num_items = dto.numItems;

    const payload: MetaEventPayload = {
      data: [{
        event_name: dto.eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: dto.eventId,
        action_source: 'website',
        event_source_url: dto.eventSourceUrl,
        user_data: userData,
        custom_data: Object.keys(customData).length > 0 ? customData : undefined,
      }],
    };

    const url = `${this.metaApiBase}/${config.metaPixelId}/events?access_token=${config.metaAccessToken}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new AppException(AppErrorCode.TRACKING_META_API_FAILED, { status: response.status, body });
    }
  }

  private async forwardToTikTok(
    config: TrackingConfig,
    dto: SendEventDto,
    clientIp?: string,
    userAgent?: string,
  ): Promise<void> {
    const user: Record<string, string[] | string> = {
      ip: clientIp || '0.0.0.0',
      user_agent: userAgent || '',
    };

    if (dto.userEmail) {
      user.email = [this.hashEmail(dto.userEmail)];
    }
    if (dto.userPhone) {
      user.phone_number = [this.hashPhone(dto.userPhone)];
    }

    const properties: Record<string, unknown> = {};
    if (dto.value !== undefined) properties.value = dto.value;
    if (dto.currency) properties.currency = dto.currency;
    if (dto.contentIds) properties.contents = dto.contentIds.map((id) => ({ content_id: id }));
    if (dto.contentType) properties.content_type = dto.contentType;
    if (dto.numItems !== undefined) properties.num_items = dto.numItems;

    const payload: TikTokEventPayload = {
      event_source: 'web',
      event_source_id: config.tikTokPixelId!,
      data: [{
        event: dto.eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: dto.eventId,
        user,
        properties: Object.keys(properties).length > 0 ? properties : undefined,
      }],
    };

    const response = await fetch(`${this.tikTokApiBase}/event/track/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Access-Token': config.tikTokAccessToken!,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new AppException(AppErrorCode.TRACKING_TIKTOK_API_FAILED, { status: response.status, body });
    }
  }
}
