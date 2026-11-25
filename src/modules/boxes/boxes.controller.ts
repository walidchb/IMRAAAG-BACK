import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BoxesService } from './boxes.service';
import { CreateBoxDto } from './dto/create-box.dto';
import { UpdateBoxDto } from './dto/update-box.dto';
import { BoxQueryDto, VendorBoxQueryDto } from './dto/box-query.dto';
import { ValidateBoxSelectionDto } from './dto/box-selection.dto';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../../common/constants/roles.enum';
import { StorePermission } from '../../common/constants/store-permissions.const';
import { RequirePermissions } from '../team/decorators/require-permissions.decorator';
import { StoresService } from '../stores/stores.service';
import { StoreSubscriptionGuard } from '../subscriptions/guards/store-subscription.guard';

@ApiTags('Boxes')
@Controller('boxes')
@UseGuards(StoreSubscriptionGuard)
export class BoxesController {
  constructor(
    private readonly boxesService: BoxesService,
    private readonly storesService: StoresService,
  ) {}

  /** The store is always resolved from the session — a body/query `storeId` is never trusted. */
  private async sessionStore(req: any): Promise<{ _id: any; vendorEmail: string; id: string }> {
    const user = req.user as { id: string };
    const store = await this.storesService.findByMemberIdOrThrow(user.id);
    return { _id: store._id, vendorEmail: store.vendorEmail, id: user.id };
  }

  // ── Vendor routes (declared before `GET :slugId` so `vendor` is never swallowed) ──

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.BOXES_VIEW)
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get('vendor')
  @ApiOperation({ summary: "List the current store's Boxes (vendor, offset pagination)" })
  async findVendorPage(@Query() query: VendorBoxQueryDto, @Req() req: any) {
    const store = await this.sessionStore(req);
    return this.boxesService.findVendorPage(String(store._id), query);
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.BOXES_VIEW)
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get('vendor/:id')
  @ApiOperation({ summary: 'Box detail for the current store' })
  async findVendorOne(@Param('id') id: string, @Req() req: any) {
    const store = await this.sessionStore(req);
    return this.boxesService.findOneForVendor(id, String(store._id));
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.BOXES_MANAGE)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post()
  @ApiOperation({ summary: 'Create a Box (draft unless published is true)' })
  async create(@Body() dto: CreateBoxDto, @Req() req: any) {
    const store = await this.sessionStore(req);
    return this.boxesService.create(dto, store);
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.BOXES_MANAGE)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Patch(':id')
  @ApiOperation({ summary: 'Update a Box (including publish/unpublish)' })
  async update(@Param('id') id: string, @Body() dto: UpdateBoxDto, @Req() req: any) {
    const store = await this.sessionStore(req);
    return this.boxesService.update(id, dto, store);
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.BOXES_MANAGE)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post(':id/duplicate')
  @ApiOperation({ summary: 'Duplicate a Box as an unpublished draft' })
  async duplicate(@Param('id') id: string, @Req() req: any) {
    const store = await this.sessionStore(req);
    return this.boxesService.duplicate(id, store);
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.BOXES_MANAGE)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post(':id/archive')
  @ApiOperation({ summary: 'Archive a Box (reversible; never touches orders or stock)' })
  async archive(@Param('id') id: string, @Req() req: any) {
    const store = await this.sessionStore(req);
    return this.boxesService.archive(id, store, store.vendorEmail);
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.BOXES_MANAGE)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post(':id/restore')
  @ApiOperation({ summary: 'Restore an archived Box' })
  async restore(@Param('id') id: string, @Req() req: any) {
    const store = await this.sessionStore(req);
    return this.boxesService.restore(id, store);
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.BOXES_DELETE)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Delete(':id')
  @ApiOperation({ summary: 'Hard delete a Box (refused while an active order references it)' })
  async remove(@Param('id') id: string, @Req() req: any) {
    const store = await this.sessionStore(req);
    return this.boxesService.remove(id, store);
  }

  // ── Public storefront routes ─────────────────────────────────────────────────

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get()
  @ApiOperation({ summary: 'List a store’s published Boxes (public, cursor pagination)' })
  @ApiResponse({ status: 200, description: 'Published Boxes' })
  findPublic(@Query() query: BoxQueryDto) {
    return this.boxesService.publicList(query);
  }

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get(':slugId')
  @ApiOperation({ summary: 'Get a published Box by slug-ID (public)' })
  findPublicOne(@Param('slugId') slugId: string) {
    return this.boxesService.publicDetail(slugId);
  }

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Post(':slugId/validate')
  @ApiOperation({ summary: 'Validate a Box selection read-only (public)' })
  validateSelection(
    @Param('slugId') slugId: string,
    @Body() dto: ValidateBoxSelectionDto,
  ) {
    return this.boxesService.validateSelection(slugId, dto.selections);
  }
}
