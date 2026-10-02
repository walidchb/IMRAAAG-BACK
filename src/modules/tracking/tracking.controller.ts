import { Controller, Get, Patch, Post, Body, Req, Param, HttpCode } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import type { Request } from 'express';
import { TrackingService } from './tracking.service';
import { StoresService } from '../stores/stores.service';
import { UpdateTrackingConfigDto } from './dto/tracking-config.dto';
import { Public } from '../auth/decorators/public.decorator';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';

/**
 * Security note (§3.6 of PLAN_STORE_ID_MIGRATION.md):
 * these endpoints used to read `vendorEmail` straight from the query string with no
 * ownership check, so any authenticated caller could read or overwrite **any** vendor's
 * Meta/TikTok pixel IDs. The store is now always resolved from `req.user.id`.
 *
 * The `storeId` / `vendorEmail` query params are no longer advertised here. They were
 * already accepted-and-ignored, and unknown query params are discarded by Nest, so
 * removing them from the contract is safe for any older client still sending them.
 *
 * The `vendorEmail` *field* on the tracking_configs schema is a different matter and is
 * deliberately retained: it is the storeId-migration shim, and dropping it is Phase 5 of
 * `PLAN_STORE_ID_MIGRATION.md`, which is still blocked. Nothing reads it.
 *
 * Scope note (D2 in PLAN_PIXELS_MODULE.md): this module is browser-pixel only. The former
 * `POST /tracking/send-event` route and the Meta Conversions API / TikTok Events API
 * forwarding code were removed - a Pixel ID is all a browser pixel needs, and the server
 * path was firing with the vendor's IP rather than the customer's.
 */
@ApiTags('Tracking')
@Controller('tracking')
export class TrackingController {
  constructor(
    private readonly trackingService: TrackingService,
    private readonly storesService: StoresService,
  ) {}

  private async storeOf(req: Request) {
    const userId = (req.user as { id: string })?.id;
    return this.storesService.findByVendorIdOrThrow(userId);
  }

  @Get('config')
  @ApiOperation({ summary: 'Get tracking pixel config for the authenticated vendor' })
  async getConfig(@Req() req: Request) {
    return this.trackingService.getConfig(await this.storeOf(req));
  }

  @Patch('config')
  @ApiOperation({ summary: 'Update tracking pixel config for the authenticated vendor' })
  async updateConfig(
    @Req() req: Request,
    @Body() dto: UpdateTrackingConfigDto,
  ) {
    return this.trackingService.updateConfig(await this.storeOf(req), dto);
  }

  /**
   * Public, cacheable per-store pixel lookup for the customer storefront.
   *
   * The storefront needs to know which pixel belongs to the store whose page a visitor is
   * looking at, before any customer is signed in (F16). A Pixel ID is public by design —
   * it is embedded in the page source of every site that uses it — so exposing it
   * unauthenticated is safe. This route resolves strictly by `storeId` and accepts no
   * seller identifier from the client, consistent with the platform rule that a storefront
   * never asserts a seller.
   */
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get('public/:storeId')
  @ApiOperation({ summary: 'Get a store public pixel config for the storefront (pixel IDs only)' })
  @ApiParam({ name: 'storeId', description: 'Store identifier.' })
  async getPublicConfig(@Param('storeId') storeId: string) {
    if (!/^[0-9a-fA-F]{24}$/.test(storeId)) {
      throw new AppException(AppErrorCode.VALIDATION_INVALID_ID, { field: 'storeId' });
    }
    return this.trackingService.getPublicConfig(storeId);
  }

  /**
   * Lightweight validation so a mistyped Pixel ID surfaces in the vendor's dashboard
   * instead of failing silently at event time (F6). The Meta check validates the ID against
   * Events Manager and reports the pixel's name and activity, which also confirms the
   * vendor pasted their own pixel and not someone else's.
   */
  @Post('test')
  @HttpCode(200)
  @ApiOperation({ summary: 'Validate a pixel ID without waiting for an event to fire' })
  async testConfig(
    @Req() req: Request,
    @Body() dto: UpdateTrackingConfigDto,
  ) {
    return this.trackingService.testConfig(await this.storeOf(req), dto);
  }
}
