import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { Role } from '../../../common/constants/roles.enum';
import { Roles } from '../../auth/decorators/roles.decorator';
import { StoresService } from '../../stores/stores.service';
import { DeliveryStatusQueryService } from './delivery-status-query.service';
import {
  DeliveryStatusCycleSummary,
  DeliveryStatusService,
} from './delivery-status.service';
import { DEFAULT_CARRIER_COMPANY_ID, getCarrierProfile } from './carrier/carrier-profiles';

/** The session user, as the JWT strategy resolves it. */
interface SessionUser {
  id: string;
  email: string;
  role: string;
}

/** The store a request is scoped to. */
interface RequestScope {
  storeId: string;
  vendorEmail: string;
  /** True when the scope was named explicitly by an operator (never by a vendor). */
  operatorScoped: boolean;
}

/**
 * The **read** endpoints of the ZR Express status sync (roadmap §16.2, §16.3).
 *
 * Five endpoints:
 *
 * | Method | Path | Who | Throttle |
 * |---|---|---|---|
 * | `GET` | `/delivery/orders/:orderId/status` | vendor, admin | 30/min |
 * | `GET` | `/delivery/parcels/:parcelId/status` | vendor, admin | 30/min |
 * | `GET` | `/delivery/sync/health` | vendor (own store), admin (all) | 10/min |
 * | `POST` | `/delivery/sync/run` | admin | 1/min |
 * | `POST` | `/delivery/parcels/:parcelId/refresh` | vendor, admin | 2/min |
 *
 * **The store always comes from the session.** A vendor never sends a store identifier, and a
 * smuggled one is ignored — the platform resolves the caller's store and answers only for it.
 * An operator (admin) may name a store explicitly, because an admin has no store of their own
 * and the operational endpoints would otherwise be unreachable.
 */
@ApiTags('Delivery status')
@ApiBearerAuth()
@Controller('delivery')
export class DeliveryStatusController {
  constructor(
    private readonly queryService: DeliveryStatusQueryService,
    private readonly statusService: DeliveryStatusService,
    private readonly storesService: StoresService,
  ) {}

  /**
   * The delivery status of one order, with the merged timeline (§8.4).
   *
   * An order that does not exist and an order that belongs to another store answer the same
   * way — 404 — so the endpoint cannot be used to probe another store's order ids.
   */
  @Roles(Role.VENDOR, Role.ADMIN)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get('orders/:orderId/status')
  @ApiOperation({ summary: "Get one order's carrier delivery status and merged timeline" })
  @ApiParam({ name: 'orderId', description: 'The platform order id' })
  async getOrderStatus(@Req() req: any, @Param('orderId') orderId: string) {
    const scope = await this.resolveScope(req, undefined);

    const view = await this.queryService.getOrderView(
      scope.storeId,
      orderId,
      scope.vendorEmail,
    );

    if (!view) {
      throw new AppException(AppErrorCode.DELIVERY_STATUS_NOT_FOUND, { orderId });
    }

    return view;
  }

  /** The same view, reached through the carrier's parcel id. */
  @Roles(Role.VENDOR, Role.ADMIN)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get('parcels/:parcelId/status')
  @ApiOperation({ summary: "Get one parcel's carrier delivery status and merged timeline" })
  @ApiParam({ name: 'parcelId', description: 'The carrier parcel id' })
  async getParcelStatus(@Req() req: any, @Param('parcelId') parcelId: string) {
    const scope = await this.resolveScope(req, undefined);

    const view = await this.queryService.getParcelView(
      scope.storeId,
      parcelId,
      scope.vendorEmail,
    );

    if (!view) {
      throw new AppException(AppErrorCode.DELIVERY_STATUS_NOT_FOUND, { parcelId });
    }

    return view;
  }

  /**
   * The sync health (§19.3).
   *
   * A vendor sees their own store only. An admin sees every store — and may narrow the answer
   * to one store with `?storeId=`.
   */
  @Roles(Role.VENDOR, Role.ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Get('sync/health')
  @ApiOperation({ summary: 'Get the delivery status sync health' })
  @ApiQuery({ name: 'storeId', required: false, description: 'Operator only: narrow to one store' })
  @ApiQuery({
    name: 'provider',
    required: false,
    description: 'Carrier slug; defaults to zr-express',
  })
  async getSyncHealth(
    @Req() req: any,
    @Query('storeId') storeId?: string,
    @Query('provider') provider?: string,
  ) {
    const user = req.user as SessionUser;
    const isAdmin = user?.role === Role.ADMIN;
    const companyId = this.resolveProvider(provider);

    // An operator sees every store until they narrow the answer; a vendor always sees only
    // their own, whatever they send.
    const storeIds =
      isAdmin && !storeId
        ? null
        : [(await this.resolveScope(req, storeId)).storeId];

    const settings =
      typeof this.statusService.settingsFor === 'function'
        ? this.statusService.settingsFor(companyId)
        : this.statusService.settings;

    return this.queryService.getHealth(storeIds, {
      enabled: settings.enabled,
      intervalMinutes: settings.intervalMinutes,
      lastCycleAt: this.statusService.lastCycleAt,
      nextCycleAt: this.statusService.nextCycleAt,
      companyId,
    });
  }

  /**
   * Forces one sync cycle now (roadmap §16.2).
   *
   * Operator-only, and hard-throttled: a cycle spends the carrier's call budget.
   */
  @Roles(Role.ADMIN)
  @Throttle({ default: { limit: 1, ttl: 60000 } })
  @Post('sync/run')
  @ApiOperation({ summary: 'Force one delivery status sync cycle' })
  async runSync(@Body() body?: { provider?: string }) {
    const provider = body?.provider;

    // A named provider runs exactly that one. Without a name, every provider whose own flag is
    // on runs once — never a disabled carrier (Ecom/Recon plan, §E5).
    if (provider) {
      return this.statusService.runCycle({ companyId: this.resolveProvider(provider) });
    }

    const profiles = this.statusService.enabledProviders();
    const summaries: DeliveryStatusCycleSummary[] = [];
    for (const profile of profiles) {
      summaries.push(await this.statusService.runCycle({ companyId: profile.companyId }));
    }

    return { providers: summaries };
  }

  /**
   * Re-reads the carrier's timeline for one parcel and returns the merged view (§16.3).
   *
   * The refresh **never** moves an order — it shows the vendor the truth immediately, and the
   * poller applies the order's next step on its own schedule.
   */
  @Roles(Role.VENDOR, Role.ADMIN)
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @Post('parcels/:parcelId/refresh')
  @ApiOperation({ summary: 'Re-fetch one parcel from the carrier' })
  @ApiParam({ name: 'parcelId', description: 'The carrier parcel id' })
  async refreshParcel(@Req() req: any, @Param('parcelId') parcelId: string) {
    const scope = await this.resolveScope(req, undefined);

    const view = await this.queryService.refreshParcel(
      scope.storeId,
      parcelId,
      scope.vendorEmail,
    );

    if (!view) {
      throw new AppException(AppErrorCode.DELIVERY_STATUS_NOT_FOUND, { parcelId });
    }

    return view;
  }

  /**
   * The store the request is scoped to.
   *
   * A vendor's store is resolved from the session — never from the request. An admin has no
   * store of their own, so an admin may name one; a vendor who sends a store id is ignored.
   */
  /** The requested provider, or the historical ZR default. */
  private resolveProvider(provider?: string): string {
    if (!provider) return DEFAULT_CARRIER_COMPANY_ID;
    const profile = getCarrierProfile(provider);
    if (!profile) {
      throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, {
        field: 'provider',
        value: provider,
      });
    }
    return profile.companyId;
  }

  private async resolveScope(req: any, storeIdParam?: string): Promise<RequestScope> {
    const user = req.user as SessionUser;
    if (!user) {
      throw new AppException(AppErrorCode.AUTH_USER_NOT_FOUND, {});
    }

    const ownStore = await this.storesService.findByVendorId(user.id).catch(() => null);
    if (ownStore) {
      return {
        storeId: String((ownStore as any)._id),
        vendorEmail: (ownStore as any).vendorEmail ?? user.email,
        operatorScoped: false,
      };
    }

    // No store of their own — only an operator may proceed, and only by naming a store.
    if (user.role !== Role.ADMIN) {
      throw new AppException(AppErrorCode.STORE_NOT_FOUND, { vendorId: user.id });
    }

    if (!storeIdParam) {
      throw new AppException(AppErrorCode.STORE_NOT_FOUND, { vendorId: user.id });
    }

    const store = await this.storesService.findOne(storeIdParam, { skipStatusCheck: true });
    return {
      storeId: String((store as any)._id),
      vendorEmail: (store as any).vendorEmail ?? '',
      operatorScoped: true,
    };
  }
}