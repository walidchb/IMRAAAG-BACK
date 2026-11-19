import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Types } from 'mongoose';
import { Role } from '../../common/constants/roles.enum';
import { StorePermission } from '../../common/constants/store-permissions.const';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { RequirePermissions } from '../team/decorators/require-permissions.decorator';
import { StoresService } from '../stores/stores.service';
import { ItemViewQueryDto } from './dto/item-view-query.dto';
import { ItemViewsService } from './item-views.service';
import { ITEM_VIEW_TYPES } from './item-view.constants';
import type { ItemViewType } from './item-view.constants';

/**
 * Seller-dashboard Product & Box view reads.
 *
 * Every route resolves the store from the session (`req.user.id`) — a caller-supplied
 * `storeId` is never read (the DTO whitelist rejects it outright) — and every aggregation is
 * scoped to that store. Item detail verifies ownership before any read, answering 404 for a
 * foreign or missing item.
 */
@ApiTags('analytics')
@Controller('analytics/views')
@UseGuards(RolesGuard)
@Roles(Role.VENDOR, Role.ADMIN)
@RequirePermissions(StorePermission.DASHBOARD_VIEW)
@Throttle({ default: { limit: 120, ttl: 60000 } })
export class ItemViewsAnalyticsController {
  constructor(
    private readonly itemViewsService: ItemViewsService,
    private readonly storesService: StoresService,
  ) {}

  @Get('summary')
  async summary(@Query() query: ItemViewQueryDto, @Req() req: any) {
    return this.itemViewsService.summary(await this.scopeFor(req), query);
  }

  @Get('items')
  async items(@Query() query: ItemViewQueryDto, @Req() req: any) {
    return this.itemViewsService.items(await this.scopeFor(req), query);
  }

  @Get('items/:itemType/:itemId')
  async itemDetail(
    @Query() query: ItemViewQueryDto,
    @Req() req: any,
    @Param('itemType') itemType: string,
    @Param('itemId') itemId: string,
  ) {
    if (!(ITEM_VIEW_TYPES as readonly string[]).includes(itemType)) {
      throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, {
        field: 'itemType',
        value: itemType,
      });
    }
    return this.itemViewsService.itemDetail(
      await this.scopeFor(req),
      itemType as ItemViewType,
      itemId,
      query,
    );
  }

  private async scopeFor(req: any): Promise<Types.ObjectId> {
    const store = await this.storesService.findByMemberIdOrThrow(req.user?.id);
    return store._id as Types.ObjectId;
  }
}
