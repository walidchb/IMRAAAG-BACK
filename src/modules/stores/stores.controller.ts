import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { StoresService } from './stores.service';
import { CreateStoreDto } from './dto/create-store.dto';
import { UpdateStoreDto } from './dto/update-store.dto';
import { Store } from './schemas/store.schema';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Role } from '../../common/constants/roles.enum';
import { StorePermission } from '../../common/constants/store-permissions.const';
import { RequirePermissions } from '../team/decorators/require-permissions.decorator';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';

@ApiTags('Stores')
@ApiBearerAuth()
@Controller('stores')
export class StoresController {
  constructor(private readonly storesService: StoresService) {}

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 5, ttl: 3600000 } })
  @Post('mine')
  @ApiOperation({ summary: 'Create own store' })
  @ApiResponse({ status: 201, description: 'Store created', type: Store })
  @ApiResponse({ status: 409, description: 'Store already exists' })
  createMine(@Body() createStoreDto: CreateStoreDto, @Req() req: any) {
    const user = req.user as { id: string; email: string };
    // Ownership comes from the session, never the body. A store created without a
    // `vendorId` is invisible to `findByVendorIdOrThrow()`, which is what tracking
    // settings resolve against - so a vendor whose store predates this would be locked
    // out of their own pixel config with a 404.
    //
    // No `@RequirePermissions(store.create)` here on purpose: the caller by definition has
    // no store to resolve permissions against yet, and the permission is Owner-only. The
    // existence check below is the real guard (one store per user), and signup normally
    // creates the store already.
    createStoreDto.vendorEmail = user.email;
    return this.storesService
      .findByMemberId(user.id)
      .then((existing) => {
        if (existing) throw new AppException(AppErrorCode.STORE_ALREADY_EXISTS);
        return this.storesService.create(createStoreDto, user.id);
      });
  }

  @Roles(Role.VENDOR)
  @Get('mine')
  @RequirePermissions(StorePermission.STORE_VIEW)
  @ApiOperation({ summary: 'Get own store' })
  @ApiResponse({ status: 200, description: 'Store found', type: Store })
  @ApiResponse({ status: 404, description: 'Store not found' })
  findMine(@Req() req: any) {
    const user = req.user as { id: string };
    return this.storesService.findByMemberIdOrThrow(user.id, { skipStatusCheck: true });
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Patch('mine')
  @RequirePermissions(StorePermission.STORE_UPDATE)
  @ApiOperation({ summary: 'Update own store' })
  @ApiResponse({ status: 200, description: 'Store updated', type: Store })
  @ApiResponse({ status: 404, description: 'Store not found' })
  async updateMine(@Body() updateStoreDto: UpdateStoreDto, @Req() req: any) {
    // Required attributes on the vendor edit path: store name, phone and email. The slug
    // is derived from the name. Everything else (description, logo, cover, location,
    // socials) is optional. The public `UpdateStoreDto` keeps every field optional because
    // the admin `PATCH /stores/:id` route shares it and performs partial updates; the
    // vendor's own store must always carry its contact identity, so enforce it here.
    for (const field of ['storeName', 'contactPhone', 'contactEmail'] as const) {
      const value = updateStoreDto[field];
      if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
        throw new AppException(AppErrorCode.VALIDATION_REQUIRED, { field });
      }
    }
    const user = req.user as { id: string };
    const store = await this.storesService.findByMemberIdOrThrow(user.id, {
      skipStatusCheck: true,
    }) as any;
    return this.storesService.update(store._id.toString(), updateStoreDto);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Patch('mine/toggle-status')
  @RequirePermissions(StorePermission.STORE_TOGGLE_STATUS)
  @ApiOperation({ summary: 'Toggle own store status Active/Paused' })
  @ApiResponse({ status: 200, description: 'Status toggled', type: Store })
  @ApiResponse({ status: 404, description: 'Store not found' })
  async toggleStatus(@Req() req: any) {
    const user = req.user as { id: string };
    const store = await this.storesService.findByMemberIdOrThrow(user.id, {
      skipStatusCheck: true,
    }) as any;
    return this.storesService.toggleStatus(store._id.toString());
  }

  /**
   * Admin-only. Note this route used to carry no `@Roles` guard at all, so any
   * authenticated caller - including a CUSTOMER - could create a store. The vendor
   * dashboard used this route rather than `POST /stores/mine`, which meant the
   * session-derived ownership was never applied and the created store had no
   * `vendorId`. Both are fixed: vendors must use `/stores/mine`, and this is now
   * restricted to admins. An unlinked store (no `vendorId`) is created here, which no
   * vendor-scoped endpoint can resolve.
   */
  @Roles(Role.ADMIN)
  @Throttle({ default: { limit: 5, ttl: 3600000 } })
  @Post()
  @ApiOperation({ summary: 'Create a new store (admin)' })
  @ApiResponse({ status: 201, description: 'Store created', type: Store })
  @ApiResponse({ status: 409, description: 'Store already exists for this vendor' })
  create(@Body() createStoreDto: CreateStoreDto) {
    return this.storesService.create(createStoreDto);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'List all active stores (public, cursor-based pagination)' })
  @ApiQuery({ name: 'search', required: false, description: 'Full-text search' })
  @ApiQuery({ name: 'limit', required: false, description: 'Items per page (default 10, max 100)' })
  @ApiQuery({ name: 'cursor', required: false, description: 'JSON stringified cursor {createdAt, _id} from previous response' })
  @ApiResponse({ status: 200, description: 'Stores with cursor pagination' })
  findAll(
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.storesService.findAll({
      search,
      limit: limit ? Number(limit) : undefined,
      cursor,
    });
  }

  @Public()
  @Get('by-email/:email')
  @ApiOperation({ summary: 'Get store by vendor email (public)' })
  @ApiResponse({ status: 200, description: 'Store found', type: Store })
  @ApiResponse({ status: 404, description: 'Store not found' })
  findByEmail(@Param('email') email: string) {
    return this.storesService.findByEmail(email, { includePublishedCount: true });
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Get store by ID, slug, or vendor ID (public)' })
  @ApiQuery({
    name: 'by',
    required: false,
    enum: ['slug', 'vendor'],
    description: 'Lookup strategy',
  })
  @ApiResponse({ status: 200, description: 'Store found', type: Store })
  @ApiResponse({ status: 404, description: 'Store not found' })
  async findOne(
    @Param('id') id: string,
    @Query('by') by?: string,
  ) {
    if (by === 'slug') return this.storesService.findBySlug(id, { includePublishedCount: true });
    if (by === 'vendor') return this.storesService.findByVendor(id, { includePublishedCount: true });

    const isMongoId = /^[0-9a-fA-F]{24}$/.test(id);
    if (isMongoId) return this.storesService.findOne(id, { includePublishedCount: true });

    return this.storesService.findBySlug(id, { includePublishedCount: true });
  }

  @Roles(Role.ADMIN)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Patch(':id')
  @ApiOperation({ summary: 'Update store by ID (Admin only)' })
  @ApiResponse({ status: 200, description: 'Store updated', type: Store })
  @ApiResponse({ status: 404, description: 'Store not found' })
  update(@Param('id') id: string, @Body() updateStoreDto: UpdateStoreDto) {
    return this.storesService.update(id, updateStoreDto);
  }

  @Roles(Role.ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Delete(':id')
  @ApiOperation({ summary: 'Delete store by ID (Admin only)' })
  @ApiResponse({ status: 200, description: 'Store deleted' })
  @ApiResponse({ status: 404, description: 'Store not found' })
  remove(@Param('id') id: string) {
    return this.storesService.remove(id);
  }
}
