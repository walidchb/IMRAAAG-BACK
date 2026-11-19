import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { TrackItemViewDto } from './dto/track-item-view.dto';
import { ItemViewsService } from './item-views.service';

/**
 * Public view beacon fired by the storefront detail pages.
 *
 * It always answers 204 for a counted, deduped, bot, private/unknown, disabled or self view —
 * existence is never revealed. Only a malformed body/type/id (400) or the throttle (429)
 * produce anything else; the client swallows all of it.
 */
@ApiTags('analytics')
@Controller('analytics/views')
export class ItemViewsTrackController {
  constructor(private readonly itemViewsService: ItemViewsService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  // Best-effort abuse mitigation only. On Vercel each function instance keeps its own
  // in-memory counter, so this is not a global limit; the metrics are directional by design.
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({ summary: 'Record a public product/Box view (fire-and-forget beacon)' })
  async track(@Body() dto: TrackItemViewDto, @Req() req: Request): Promise<void> {
    await this.itemViewsService.track(dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      authorization: req.headers['authorization'],
    });
  }
}
