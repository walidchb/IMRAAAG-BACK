import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Types } from 'mongoose';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Role } from '../../common/constants/roles.enum';
import { StorePermission } from '../../common/constants/store-permissions.const';
import { RequirePermissions } from '../team/decorators/require-permissions.decorator';
import { StoresService } from '../stores/stores.service';
import { InventoryService } from './services/inventory.service';
import { InventoryReadService } from './services/inventory-read.service';
import { MovementsService } from './services/movements.service';
import {
  AdjustDeltaDto,
  BulkAdjustDto,
  ListMovementsQueryDto,
  SetOnHandDto,
} from './dto/inventory.dto';
import {
  ListInventoryQueryDto,
  ListStoreMovementsQueryDto,
  SetThresholdDto,
} from './dto/inventory-list.dto';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';

/**
 * Vendor-scoped inventory endpoints.
 *
 * Two rules hold for every route here:
 *  - The store comes from the session, never from the request. A client-supplied storeId
 *    is ignored even if present.
 *  - Writes are audited. There is no untracked path to a balance.
 */
@ApiTags('inventory')
@Controller('inventory')
@UseGuards(RolesGuard)
@RequirePermissions(StorePermission.INVENTORY_VIEW)
export class InventoryController {
  constructor(
    private readonly inventoryService: InventoryService,
    private readonly inventoryReadService: InventoryReadService,
    private readonly movementsService: MovementsService,
    private readonly storesService: StoresService,
  ) {}

  /** Absolute set-on-hand for one variant. */
  @Patch('variants/:variantId/stock')
  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.INVENTORY_ADJUST)
  async setOnHand(
    @Param('variantId') variantId: string,
    @Body() dto: SetOnHandDto,
    @Req() req: any,
  ) {
    return this.inventoryService.setOnHand({
      storeId: await this.storeIdFor(req.user as { id: string }),
      variantId: this.variantId(variantId),
      quantity: dto.quantity,
      reason: dto.reason,
      note: dto.note ?? null,
      actorUserId: this.userIdOrNull((req.user as { id: string })?.id),
      idempotencyKey: dto.idempotencyKey ?? null,
    });
  }

  /** Signed adjustment for one variant. */
  @Patch('variants/:variantId/adjust')
  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.INVENTORY_ADJUST)
  async adjust(
    @Param('variantId') variantId: string,
    @Body() dto: AdjustDeltaDto,
    @Req() req: any,
  ) {
    return this.inventoryService.adjustByDelta({
      storeId: await this.storeIdFor(req.user as { id: string }),
      variantId: this.variantId(variantId),
      delta: dto.delta,
      reason: dto.reason,
      note: dto.note ?? null,
      actorUserId: this.userIdOrNull((req.user as { id: string })?.id),
      idempotencyKey: dto.idempotencyKey ?? null,
    });
  }

  /**
   * Applies an absolute set or a signed delta to many existing variants.
   *
   * Per-item failures are reported rather than aborting the batch: one bad row should not
   * discard the seller's other corrections. Unknown variant ids are refused outright so a
   * typo cannot invent stock.
   */
  @Post('bulk-adjust')
  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.INVENTORY_BULK_ADJUST)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async bulkAdjust(@Body() dto: BulkAdjustDto, @Req() req: any) {
    return this.inventoryService.bulkAdjust(
      await this.storeIdFor(req.user as { id: string }),
      dto.items,
      dto.reason,
      this.userIdOrNull((req.user as { id: string })?.id),
    );
  }

  /** Current availability for one variant. */
  @Get('variants/:variantId/stock')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Roles(Role.VENDOR, Role.ADMIN)
  async getBalance(@Param('variantId') variantId: string, @Req() req: any) {
    await this.assertVariantAccess(variantId, req.user as { id: string });
    const balance = await this.inventoryReadService.getBalance(variantId);
    if (!balance) throw new AppException(AppErrorCode.VARIANT_NOT_FOUND, { variantId });
    return balance;
  }

  /** Movement history for one variant, newest first, cursor-paginated. */
  @Get('variants/:variantId/movements')
  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.INVENTORY_MOVEMENTS_VIEW)
  async listMovements(
    @Param('variantId') variantId: string,
    @Query() query: ListMovementsQueryDto,
    @Req() req: any,
  ) {
    const storeId = await this.storeIdFor(req.user as { id: string });
    await this.assertVariantAccess(variantId, req.user as { id: string });
    return this.movementsService.listForVariant(
      String(storeId),
      variantId,
      query.limit ?? 50,
      query.cursor,
    );
  }

  /**
   * Store-wide variant inventory with search, filters, and paging.
   *
   * Declared before the `:variantId` routes so the literal paths keep winning the match; a
   * request for `/inventory/variants/...` still lands on the variant handlers.
   *
   * Carries no summary on purpose: the header statistics come from `/inventory/stats`,
   * which ignores search/filters entirely (spec §5).
   */
  @Get()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Roles(Role.VENDOR, Role.ADMIN)
  async listInventory(@Query() query: ListInventoryQueryDto, @Req() req: any) {
    return this.inventoryReadService.listStoreInventory(
      await this.storeIdFor(req.user as { id: string }),
      query,
    );
  }

  /**
   * Resolves a scanned barcode to the product that owns it, within the session store.
   *
   * Intended for the vendor inventory view's scan input (mirrors the POS scan flow). If the
   * barcode is found, returns the owning product's id and name so the UI can switch to
   * productId mode and show all variants of that product. Returns 404 if not found.
   */
  @Get('barcode/:barcode')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Roles(Role.VENDOR, Role.ADMIN)
  async findByBarcode(@Param('barcode') barcode: string, @Req() req: any) {
    return this.inventoryReadService.findByBarcode(
      await this.storeIdFor(req.user as { id: string }),
      barcode,
    );
  }

  /**
   * Store-level statistics for the inventory header (spec §5).
   *
   * Takes no query at all - the whole point of the route is that search, filters, sorting
   * and pagination cannot reach it, so the tiles describe the entire store no matter what
   * the list below is showing. Store comes from the session like every other route here.
   */
  @Get('stats')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Roles(Role.VENDOR, Role.ADMIN)
  async getInventoryStats(@Req() req: any) {
    return this.inventoryReadService.getStoreStats(
      await this.storeIdFor(req.user as { id: string }),
    );
  }

  /**
   * Store-wide movement ledger, newest first, cursor-paginated.
   *
   * `productId` is narrowed to that product's variants here rather than in the aggregation:
   * a movement carries a variant id but no product id, and joining products into the ledger
   * would defeat the index this read depends on.
   */
  @Get('movements')
  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.INVENTORY_MOVEMENTS_VIEW)
  async listStoreMovements(
    @Query() query: ListStoreMovementsQueryDto,
    @Req() req: any,
  ) {
    const storeId = await this.storeIdFor(req.user as { id: string });

    const variantIds = query.productId
      ? await this.inventoryReadService.variantIdsForProduct(query.productId, storeId)
      : undefined;
    if (query.variantId) this.variantId(query.variantId);

    return this.movementsService.listForStore(storeId, {
      variantIds,
      // A single variant is a filter, not a validation step: narrowing to `[variantId]` is
      // what actually scopes the ledger. Validating and then dropping it would hand the
      // caller the whole store's history while the response implies one variant's.
      singleVariantId: query.variantId ? this.variantId(query.variantId) : undefined,
      type: query.type,
      from: this.dateOrUndefined(query.from),
      to: this.dateOrUndefined(query.to),
      search: query.search,
      limit: query.limit,
      cursor: query.cursor,
      locale: query.locale,
    });
  }

  /** Sets or clears a low-stock threshold for one variant, or a product-wide default. */
  @Patch('threshold')
  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.INVENTORY_THRESHOLD_UPDATE)
  async setThreshold(@Body() dto: SetThresholdDto, @Req() req: any) {
    const hasVariant = !!dto.variantId;
    const hasProduct = !!dto.productId;

    // Exactly one target: an ambiguous "set the threshold" has no correct meaning, and
    // silently preferring one would let a client edit something it did not name.
    if (hasVariant === hasProduct) {
      throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, {
        field: hasVariant ? 'variantId/productId' : 'variantId',
        rule: 'exactly_one_of_variantId_or_productId',
      });
    }

    // An explicit null clears the override. `@IsOptional()` cannot tell "absent" from
    // "null", so `clear` is what makes the null intentional rather than accidental.
    if (dto.threshold === null && !dto.clear) {
      throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, {
        field: 'threshold',
        rule: 'null_threshold_requires_clear',
      });
    }

    // An entirely absent `threshold` means "change nothing", which is not what this route
    // does. Defaulting it to null would let a request carrying only a target id silently
    // wipe an existing override, so that has to be refused rather than guessed at.
    if (dto.threshold === undefined && !dto.clear) {
      throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, {
        field: 'threshold',
        rule: 'threshold_required_unless_clearing',
      });
    }

    return this.inventoryService.setThreshold({
      storeId: await this.storeIdFor(req.user as { id: string }),
      variantId: hasVariant ? dto.variantId : undefined,
      productId: hasProduct ? dto.productId : undefined,
      threshold: dto.clear ? null : (dto.threshold as number),
    });
  }

  private async storeIdFor(user: { id: string }): Promise<Types.ObjectId> {
    return (await this.storesService.findByMemberIdOrThrow(user.id))._id as Types.ObjectId;
  }

  /**
   * Rejects a variant belonging to another store as not-found rather than forbidden, so
   * these endpoints cannot be used to probe which variant ids exist.
   */
  private async assertVariantAccess(variantId: string, user: { id: string }): Promise<void> {
    await this.inventoryService.assertVariantAccess(
      this.variantId(variantId),
      await this.storeIdFor(user),
    );
  }

  /**
   * Parses an optional date filter, refusing an unparseable value.
   *
   * `new Date('nonsense')` is an Invalid Date, not an error, and MongoDB would then store or
   * compare against nonsense. A seller seeing "no results" for a typo they cannot see is far
   * worse than being told the date was not understood.
   */
  private dateOrUndefined(raw?: string): Date | undefined {
    if (raw === undefined || raw === '') return undefined;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, {
        field: 'date',
        rule: 'expected_iso_date',
        value: raw,
      });
    }
    return parsed;
  }

  private variantId(raw: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(raw)) {
      throw new AppException(AppErrorCode.VARIANT_NOT_FOUND, { variantId: raw });
    }
    return new Types.ObjectId(raw);
  }

  private userIdOrNull(raw?: string): Types.ObjectId | null {
    return raw && Types.ObjectId.isValid(raw) ? new Types.ObjectId(raw) : null;
  }
}