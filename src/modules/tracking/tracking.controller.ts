import { Controller, Get, Patch, Post, Body, Query, Req, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import type { Request } from 'express';
import { TrackingService } from './tracking.service';
import { UpdateTrackingConfigDto, SendEventDto } from './dto/tracking-config.dto';

@ApiTags('Tracking')
@Controller('tracking')
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  @Get('config')
  @ApiOperation({ summary: 'Get tracking pixel config for a vendor' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  getConfig(@Query('vendorEmail') vendorEmail: string) {
    return this.trackingService.getConfig(vendorEmail);
  }

  @Patch('config')
  @ApiOperation({ summary: 'Update tracking pixel config for a vendor' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  updateConfig(
    @Query('vendorEmail') vendorEmail: string,
    @Body() dto: UpdateTrackingConfigDto,
  ) {
    return this.trackingService.updateConfig(vendorEmail, dto);
  }

  @Post('send-event')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a tracking event to Meta/TikTok server-side' })
  @ApiQuery({ name: 'vendorEmail', required: true })
  async sendEvent(
    @Query('vendorEmail') vendorEmail: string,
    @Body() dto: SendEventDto,
    @Req() req: Request,
  ) {
    const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket?.remoteAddress;
    const userAgent = req.headers['user-agent'] || '';
    return this.trackingService.sendEvent(vendorEmail, dto, clientIp, userAgent);
  }
}
