import { Controller, Get, Query, Req, UseGuards, Param } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Types } from 'mongoose';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Role } from '../../common/constants/roles.enum';
import { StoresService } from '../stores/stores.service';
import { AnalyticsService, StoreScope } from './analytics.service';
import { AnalyticsRangeQueryDto } from './dto/analytics-query.dto';

/**
 * Seller-dashboard analytics reads (roadmap Phase 1).
 *
 * Every route is store-scoped from the session (`req.user.id`), exactly like POS/inventory:
 * a client-supplied `storeId` is never read or trusted, so one vendor's numbers can never leak
 * across stores. All figures are computed over the half-open, Algiers-anchored window resolved
 * from the same `AnalyticsRangeQueryDto` every route accepts.
 */
@ApiTags('analytics')
@Controller('analytics')
@UseGuards(RolesGuard)
@Roles(Role.VENDOR, Role.ADMIN)
@Throttle({ default: { limit: 120, ttl: 60000 } })
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly storesService: StoresService,
  ) {}

  @Get('summary')
  @ApiQuery({ name: 'preset', required: false, enum: ['today', 'yesterday', '7d', '30d', 'month', 'custom'] })
  @ApiQuery({ name: 'from', required: false, description: 'ISO date; start when preset=custom' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO date; exclusive end when preset=custom' })
  @ApiQuery({ name: 'channel', required: false, enum: ['all', 'online', 'in-store', 'manual'] })
  @ApiQuery({ name: 'compare', required: false, enum: ['true', 'false'] })
  async summary(@Query() query: AnalyticsRangeQueryDto, @Req() req: any) {
    return this.analyticsService.summary(await this.scopeFor(req), query);
  }

  @Get('trend')
  @ApiQuery({ name: 'bucket', required: false, enum: ['hour', 'day', 'week', 'month'] })
  async trend(@Query() query: AnalyticsRangeQueryDto, @Req() req: any) {
    return this.analyticsService.trend(await this.scopeFor(req), query);
  }

  @Get('channels')
  async channels(@Query() query: AnalyticsRangeQueryDto, @Req() req: any) {
    return this.analyticsService.channels(await this.scopeFor(req), query);
  }

  /**
   * Per-status order counts within the selected window. The vendor Orders page's tabs use the
   * same `orderStatus=<slug>` filter, so the actionable tiles link straight into it.
   */
  @Get('orders/status')
  async ordersStatus(@Query() query: AnalyticsRangeQueryDto, @Req() req: any) {
    return this.analyticsService.ordersStatus(await this.scopeFor(req), query);
  }

  @Get('products')
  async products(@Query() query: AnalyticsRangeQueryDto, @Req() req: any) {
    return this.analyticsService.products(await this.scopeFor(req), query);
  }

  @Get('products/no-sales')
  async productsNoSales(@Query() query: AnalyticsRangeQueryDto, @Req() req: any) {
    return this.analyticsService.productsNoSales(await this.scopeFor(req), query);
  }

  @Get('products/:productId/variants')
  async productVariants(@Query() query: AnalyticsRangeQueryDto, @Req() req: any, @Param('productId') productId: string) {
    return this.analyticsService.productVariants(await this.scopeFor(req), query, productId);
  }

  private async scopeFor(req: any): Promise<StoreScope> {
    const store = await this.storesService.findByVendorIdOrThrow(req.user?.id);
    return {
      storeId: store._id as Types.ObjectId,
      vendorEmail: store.vendorEmail,
    };
  }
}