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
import { UpdateStoreSubdomainDto } from './dto/update-store-subdomain.dto';
import { Store } from './schemas/store.schema';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Role } from '../../common/constants/roles.enum';
import { StorePermission } from '../../common/constants/store-permissions.const';
import { RequirePermissions } from '../team/decorators/require-permissions.decorator';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { evaluateStoreAvailability } from './store-availability';
import { SubscriptionAccessService } from '../subscriptions/subscription-access.service';

/**
 * Fields a public storefront read may expose. `vendorId`, `vendorEmail`, the legacy
 * `storeId`, `inventoryEnabled` and `barcodeSeq` are internal/account data and must never
 * reach an unauthenticated caller. Keep this list in sync with `Store` in the storefront's
 * `types.ts`; the vendor's own `GET /stores/mine` deliberately bypasses this projection.
 */
const PUBLIC_STORE_FIELDS = [
  '_id',
  'storeName',
  'storeSlug',
  'subdomain',
  'description',
  'storeLogo',
  'coverImage',
  'contactEmail',
  'contactPhone',
  'contactPhones',
  'wilaya',
  'commune',
  'streetAddress',
  'googleMapsUrl',
  // Legacy address object: kept only so pre-migration stores that never set
  // `wilaya`/`commune` still render their location. New writes use the root fields.
  'address',
  'categories',
  'tagline',
  'socialMedia',
  // Legacy mirror plus the two authoritative decisions. `isAvailable` is derived below.
  'status',
  'ownerStatus',
  'adminStatus',
  'totalProducts',
  'totalOrders',
  'createdAt',
] as const;

function toPublicStore(store: any): Record<string, unknown> | null {
  if (!store) return null;
  const plain = typeof store.toObject === 'function' ? store.toObject() : store;
  const result: Record<string, unknown> = {};
  for (const field of PUBLIC_STORE_FIELDS) {
    if (plain[field] !== undefined) result[field] = plain[field];
  }

  // Always expose the derived decision, even for a legacy row that only has `status`.
  const availability = evaluateStoreAvailability(plain);
  result.ownerStatus = availability.ownerStatus;
  result.adminStatus = availability.adminStatus;
  result.isAvailable = availability.available;
  return result;
}

@ApiTags('Stores')
@ApiBearerAuth()
@Controller('stores')
export class StoresController {
  constructor(
    private readonly storesService: StoresService,
    private readonly subscriptionAccessService: SubscriptionAccessService,
  ) {}

  /**
   * Additive public subscription state. Omitted entirely while `SUBSCRIPTIONS_ENABLED` is off,
   * so existing storefront payloads are unchanged. Only `acceptingOrders` and a minimal state
   * are exposed — never plan price, limits, admin actor or event history (plan §14.1).
   */
  private async withPublicSubscription<T extends Record<string, any> | null>(store: T): Promise<T> {
    if (!store || !this.subscriptionAccessService.isEnabled()) return store;
    const id = String((store as Record<string, any>)._id ?? '');
    if (!id) return store;
    const state = await this.subscriptionAccessService.getPublicState(id);
    return {
      ...store,
      acceptingOrders: state.acceptingOrders,
      subscriptionState: state.subscriptionState,
    } as T;
  }

  private async withPublicSubscriptions(
    stores: Array<Record<string, any> | null>,
  ): Promise<Array<Record<string, any> | null>> {
    if (!this.subscriptionAccessService.isEnabled()) return stores;
    const ids = stores
      .map((store) => (store?._id ? String(store._id) : ''))
      .filter((id) => Boolean(id));
    const states = await this.subscriptionAccessService.getPublicStates(ids);
    return stores.map((store) => {
      if (!store) return store;
      const state = states.get(String(store._id));
      if (!state) return store;
      return {
        ...store,
        acceptingOrders: state.acceptingOrders,
        subscriptionState: state.subscriptionState,
      };
    });
  }

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

  /**
   * Dedicated subdomain update. Ownership is session-derived (`findByMemberIdOrThrow`); a
   * `storeId`/email smuggled into the body is ignored because the DTO has no such field and
   * the strict validation pipe rejects unknown properties.
   */
  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Patch('mine/subdomain')
  @RequirePermissions(StorePermission.STORE_UPDATE)
  @ApiOperation({ summary: 'Update own store public subdomain' })
  @ApiResponse({ status: 200, description: 'Subdomain updated', type: Store })
  @ApiResponse({ status: 400, description: 'Invalid or reserved subdomain' })
  @ApiResponse({ status: 409, description: 'Subdomain already taken' })
  async updateMineSubdomain(@Body() dto: UpdateStoreSubdomainDto, @Req() req: any) {
    const user = req.user as { id: string };
    const store = await this.storesService.findByMemberIdOrThrow(user.id, {
      skipStatusCheck: true,
    });
    return this.storesService.updateSubdomain(store._id.toString(), dto.subdomain);
  }

  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Patch('mine/toggle-status')
  @RequirePermissions(StorePermission.STORE_TOGGLE_STATUS)
  @ApiOperation({ summary: 'Toggle own store owner status Enabled/Disabled' })
  @ApiResponse({ status: 200, description: 'Owner status toggled', type: Store })
  @ApiResponse({ status: 404, description: 'Store not found' })
  async toggleStatus(@Req() req: any) {
    const user = req.user as { id: string };
    const store = await this.storesService.findByMemberIdOrThrow(user.id, {
      skipStatusCheck: true,
    }) as any;
    return this.storesService.toggleOwnerStatus(store._id.toString());
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
  async findAll(
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const result = await this.storesService.findAll({
      search,
      limit: limit ? Number(limit) : undefined,
      cursor,
    });
    return { ...result, stores: await this.withPublicSubscriptions(result.stores.map((store) => toPublicStore(store))) };
  }

  /**
   * Public host-based resolution. Static path, declared before `GET /stores/:id` so Express
   * never treats `by-subdomain` as an id. Read-only, active-only, and never trusts a Host
   * header - the caller names the label explicitly.
   */
  // The storefront resolves a store host from server-side code, so every store-root document
  // can make one or two requests from the same egress address. The read is a cheap indexed,
  // active-only lookup; a higher limit avoids turning a campaign burst into 429s while the
  // storefront retries and caches. Keep this in-memory throttle as best-effort abuse
  // protection only: on Vercel each function instance has its own counter.
  @Public()
  @Throttle({ default: { limit: 600, ttl: 60000 } })
  @Get('by-subdomain/:subdomain')
  @ApiOperation({ summary: 'Get an active store by its public subdomain (public)' })
  @ApiResponse({ status: 200, description: 'Store found', type: Store })
  @ApiResponse({ status: 404, description: 'Store not found' })
  @ApiResponse({ status: 403, description: 'Store is not active' })
  async findBySubdomain(@Param('subdomain') subdomain: string) {
    const store = await this.storesService.findBySubdomain(subdomain, { includePublishedCount: true });
    return this.withPublicSubscription(toPublicStore(store));
  }

  /**
   * Availability check for the vendor's own picker. Requires an authenticated vendor (so the
   * endpoint cannot be used for anonymous bulk enumeration) but reveals nothing about the
   * owner of a taken label. Always 200 with `{ value, available, reason? }`.
   */
  @Roles(Role.VENDOR)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('subdomain-availability')
  @ApiOperation({ summary: 'Check whether a store subdomain is available' })
  @ApiResponse({ status: 200, description: 'Availability result' })
  async checkSubdomainAvailability(@Query('value') value: string, @Req() req: any) {
    const user = req.user as { id: string };
    // Resolve the caller's store so only vendors (not any token holder) can probe, without
    // restricting the check to an active store (a paused vendor can still choose a name).
    await this.storesService.findByMemberIdOrThrow(user.id, { skipStatusCheck: true });
    return this.storesService.isSubdomainAvailable(value ?? '');
  }

  @Public()
  @Get('by-email/:email')
  @ApiOperation({ summary: 'Get store by vendor email (public)' })
  @ApiResponse({ status: 200, description: 'Store found', type: Store })
  @ApiResponse({ status: 404, description: 'Store not found' })
  async findByEmail(@Param('email') email: string) {
    const store = await this.storesService.findByEmail(email, { includePublishedCount: true });
    return this.withPublicSubscription(toPublicStore(store));
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
    if (by === 'slug') {
      return this.withPublicSubscription(
        toPublicStore(await this.storesService.findBySlug(id, { includePublishedCount: true })),
      );
    }
    if (by === 'vendor') {
      return this.withPublicSubscription(
        toPublicStore(await this.storesService.findByVendor(id, { includePublishedCount: true })),
      );
    }

    const isMongoId = /^[0-9a-fA-F]{24}$/.test(id);
    if (isMongoId) {
      return this.withPublicSubscription(
        toPublicStore(await this.storesService.findOne(id, { includePublishedCount: true })),
      );
    }

    return this.withPublicSubscription(
      toPublicStore(await this.storesService.findBySlug(id, { includePublishedCount: true })),
    );
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


