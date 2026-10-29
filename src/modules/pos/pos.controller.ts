import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Types } from 'mongoose';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Role } from '../../common/constants/roles.enum';
import { StoresService } from '../stores/stores.service';
import { OrdersService } from '../orders/orders.service';
import { CreatePosSaleDto } from '../orders/dto/create-pos-sale.dto';
import { PosService } from './pos.service';
import { PosProductQueryDto } from './dto/pos.dto';

/**
 * Vendor-scoped POS catalog endpoints.
 *
 * The store is resolved from the session (`req.user.id`), never from the request, so the
 * register of one vendor can never read another vendor's catalog. Reads only — the sale
 * itself goes through the existing (idempotent, inventory-aware) order endpoint.
 */
@ApiTags('pos')
@Controller('pos')
@UseGuards(RolesGuard)
@Roles(Role.VENDOR, Role.ADMIN)
@Throttle({ default: { limit: 120, ttl: 60000 } })
export class PosController {
  constructor(
    private readonly posService: PosService,
    private readonly storesService: StoresService,
    private readonly ordersService: OrdersService,
  ) {}

  /** Product-grouped catalog search. `q` matches name (any language), SKU or barcode. */
  @Get('products')
  async search(@Query() query: PosProductQueryDto, @Req() req: any) {
    return this.posService.searchProducts(await this.storeIdFor(req), query);
  }

  /** Barcode lookup returning the scanned variant's whole product. */
  @Get('products/by-barcode/:barcode')
  async byBarcode(@Param('barcode') barcode: string, @Req() req: any) {
    return this.posService.findByBarcode(await this.storeIdFor(req), barcode);
  }

  /**
   * Rings up an in-store sale. The store and the actor come from the session; the body only
   * carries what was scanned. Stock is server-authoritative and enforced inside the sale's
   * transaction, so a sold-out line rejects the whole sale rather than overdrawing stock.
   */
  @Post('sales')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async createSale(@Body() dto: CreatePosSaleDto, @Req() req: any) {
    return this.ordersService.createImmediateSale(dto, req.user);
  }

  /**
   * Returns distinct walk-in customers that have placed orders in this store. The query is
   * stored-tenant-scoped (only orders from the session store are considered) and matches either
   * the customer's name or phone. Used by the POS screen to attach a past walk-in to the sale.
   */
  @Get('customers')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  async customers(@Query('q') q: string | undefined, @Req() req: any) {
    const store = await this.storesService.findByVendorIdOrThrow(req.user?.id);
    return this.posService.searchCustomers(store._id as Types.ObjectId, q);
  }

  private async storeIdFor(req: any): Promise<Types.ObjectId> {
    const store = await this.storesService.findByVendorIdOrThrow(req.user?.id);
    return store._id as Types.ObjectId;
  }
}
