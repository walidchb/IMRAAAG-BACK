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
  NotFoundException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { Role } from '../../common/constants/roles.enum';
import { StorePermission } from '../../common/constants/store-permissions.const';
import { RequirePermissions } from '../team/decorators/require-permissions.decorator';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { CreateVendorOrderDto } from './dto/create-vendor-order.dto';
import { UpdateVendorOrderDto } from './dto/update-vendor-order.dto';
import { BulkActionDto } from './dto/bulk-action.dto';
import { BulkShipDto } from './dto/bulk-ship.dto';
import { ReceiveReturnDto } from '../inventory/dto/reservations.dto';
import { Order } from './schemas/order.schema';

@ApiTags('Orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post()
  @ApiOperation({ summary: 'Create a new order (public — guest & auth users)' })
  @ApiResponse({ status: 201, description: 'Order created successfully', type: Order })
  create(@Body() createOrderDto: CreateOrderDto, @Req() req: any) {
    return this.ordersService.create(createOrderDto, req.user);
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.ORDERS_CREATE)
  @Post('vendor')
  @ApiOperation({ summary: 'Create a new order (vendor)' })
  @ApiResponse({ status: 201, description: 'Order created successfully', type: Order })
  createVendor(@Body() dto: CreateVendorOrderDto, @Req() req: any) {
    const { id: _id, orderNo: _orderNo, ...cleanDto } = dto;
    return this.ordersService.create(cleanDto as CreateOrderDto, req.user);
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.ORDERS_UPDATE)
  @Patch('vendor/:id')
  @ApiOperation({ summary: 'Update order (vendor)' })
  @ApiResponse({ status: 200, description: 'Order updated', type: Order })
  updateVendor(@Param('id') id: string, @Body() dto: UpdateVendorOrderDto, @Req() req: any) {
    const { storeId: _storeId, id: _unusedId, orderNo: _unusedOrderNo, _id: __id, deliveryParcelId: _parcelId, deliveryError: _err, updatedAt: _updatedAt, source: _source, ...cleanDto } = dto;
    return this.ordersService.update(id, cleanDto as UpdateOrderDto, req.user);
  }

  @Public()
  // H10: order numbers are sequential and phone numbers come from a small national format, so
  // this endpoint is brute-forceable. Throttle it hard per client.
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Get('track/:orderNo')
  @ApiOperation({ summary: 'Track an order by order number (public, requires phone verification)' })
  @ApiQuery({ name: 'phone', required: true, description: 'Customer phone number for verification' })
  @ApiResponse({ status: 200, description: 'Order found with carrier-neutral delivery block' })
  @ApiResponse({ status: 404, description: 'Order not found or phone mismatch' })
  async trackByOrderNo(@Param('orderNo') orderNo: string, @Query('phone') phone: string) {
    const order = await this.ordersService.findByOrderNo(orderNo, phone);
    if (!order) {
      throw new NotFoundException('Order not found or phone mismatch');
    }
    const delivery = this.buildDeliveryBlock(order);
    return { order: OrdersController.toPublicTrackingOrder(order), delivery };
  }

  /**
   * The tracking response is a buyer-facing projection: it keeps what the order page renders
   * and drops the seller's internal identifiers and delivery diagnostics (H10).
   */
  private static toPublicTrackingOrder(order: any): Record<string, unknown> {
    const plain =
      typeof order?.toObject === 'function' ? order.toObject() : { ...(order as object) };
    delete plain.vendorEmail;
    delete plain.vendorId;
    delete plain.deliveryError;
    delete plain.deliveryParcelId;
    delete plain.isDeleted;
    delete plain.deletedAt;
    delete plain.isArchived;
    delete plain.archivedAt;
    delete plain.archivedBy;
    return plain;
  }

  private buildDeliveryBlock(order: any) {
    const status = order.status?.slug ?? null;
    // Simple carrier‑neutral label: use the slug as‑is; callers can translate later.
    const statusLabel = status ?? null;
    const updatedAt = order.updatedAt ?? order.date ?? null;

    // Build timeline from order history (order events only)
    const timeline = (order.history ?? [])
      .filter((e: any) => e.status?.slug)
      .map((e: any) => ({
        kind: 'order' as const,
        at: e.date ?? null,
        orderStatus: e.status?.slug ?? null,
        orderStatusLabel: e.status?.displayName ?? null,
        user: e.user ?? null,
      }));

    // If the order has a parcel, add a synthetic "parcel created" anchor
    // only when a dispatched event exists in the order (roadmap §9.3 anchor rule).
    if (order.deliveryParcelId && order.dispatchedAt) {
      const dispatched = new Date(order.dispatchedAt);
      const earliestCarrier = timeline
        .map((t) => t.at)
        .filter((d): d is Date => d instanceof Date)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      if (earliestCarrier && earliestCarrier.getTime() < dispatched.getTime()) {
        timeline.unshift({
          kind: 'anchor' as const,
          at: dispatched,
          anchor: 'parcel_created',
        });
      }
    }

    return {
      status,
      statusLabel,
      updatedAt,
      timeline,
    };
  }

  @Roles(Role.CUSTOMER, Role.VENDOR, Role.ADMIN)
  @Get('mine/:id')
  @ApiOperation({ summary: 'Get a single order for the authenticated customer' })
  @ApiResponse({ status: 200, description: 'Order found' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  findOneMine(@Param('id') id: string, @Req() req: any) {
    // Ownership is the customer phone. A principal with no phone (an OTP token used to have
    // this shape, and a vendor account may have none) must never match an order, so refuse
    // before the lookup instead of comparing against `undefined` (H3).
    const phone = (req.user as any)?.phoneNumber;
    if (!phone) throw new AppException(AppErrorCode.AUTH_UNAUTHORIZED);
    return this.ordersService.findOneByCustomer(id, phone);
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.ORDERS_VIEW)
  @Get()
  @ApiOperation({ summary: 'List all orders' })
  @ApiQuery({ name: 'vendorEmail', required: false })
  @ApiQuery({ name: 'archived', required: false, description: 'When true, list archived orders only' })
  @ApiQuery({ name: 'orderStatus', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'client', required: false })
  @ApiQuery({ name: 'orderNo', required: false })
  @ApiQuery({ name: 'total', required: false })
  @ApiQuery({ name: 'wilaya', required: false })
  @ApiQuery({ name: 'commune', required: false })
  @ApiQuery({ name: 'shippingMethod', required: false })
  @ApiQuery({ name: 'createdBy', required: false })
  @ApiQuery({ name: 'confirmedBy', required: false })
  @ApiQuery({ name: 'bureau', required: false })
  @ApiQuery({ name: 'phone', required: false })
  @ApiQuery({ name: 'note', required: false })
  @ApiQuery({ name: 'minTotal', required: false })
  @ApiQuery({ name: 'maxTotal', required: false })
  @ApiQuery({ name: 'page', required: false, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Items per page (default: 10, max: 100)' })
  @ApiResponse({ status: 200, description: 'Paginated list of orders' })
  findAll(
    @Query() query: Record<string, string>,
    @Req() req: any,
  ) {
    return this.ordersService.findAll(query, req.user);
  }

  @Roles(Role.CUSTOMER, Role.VENDOR, Role.ADMIN)
  @Get('mine')
  @ApiOperation({ summary: 'Get my orders (customer)' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiResponse({ status: 200, description: 'Paginated customer orders' })
  findMine(
    @Req() req: any,
    @Query('page') page = 1,
    @Query('limit') limit = 10,
    @Query('status') status?: string,
  ) {
    const phone = (req.user as any)?.phoneNumber;
    // A principal without a phone would match orders whose customer phone is empty.
    if (!phone) throw new AppException(AppErrorCode.AUTH_UNAUTHORIZED);
    return this.ordersService.findByCustomerPhone(phone, {
      page: Number(page),
      limit: Number(limit),
      status,
    });
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.ORDERS_VIEW)
  @Post('bulk')
  @ApiOperation({ summary: 'Bulk action on orders (confirm, cancel, archive, restore, delete)' })
  @ApiResponse({ status: 200, description: 'Bulk action completed' })
  bulkAction(@Body() bulkActionDto: BulkActionDto, @Req() req: any) {
    return this.ordersService.bulkAction(bulkActionDto, req.user);
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.ORDERS_DISPATCH)
  @Post('bulk-ship')
  @ApiOperation({ summary: 'Bulk ship orders grouped by delivery company' })
  @ApiResponse({ status: 200, description: 'Bulk ship completed with per-order results' })
  bulkShip(@Body() bulkShipDto: BulkShipDto, @Req() req: any) {
    return this.ordersService.bulkShip(bulkShipDto, req.user);
  }

  /**
   * Phase 4 (roadmap §4.5): why is this order's stock in its current state?
   *
   * Declared before `:id` for readability rather than necessity - `:id` matches one path
   * segment, so it cannot swallow this path.
   */
  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.ORDERS_INVENTORY_VIEW)
  @Get(':id/inventory')
  @ApiOperation({
    summary: 'Reservation and deduction state for one order',
    description:
      'Diagnostic view of per-line reservations, their status, and the movements recorded against each line.',
  })
  @ApiResponse({ status: 200, description: 'Order inventory state' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  getOrderInventory(@Param('id') id: string, @Req() req: any) {
    return this.ordersService.getOrderInventory(id, req.user);
  }

  /**
   * Phase 4 (roadmap §4.5): record goods physically received back.
   *
   * `restock` returns units to sellable stock; `write_off` records them as damaged and leaves
   * on-hand alone. Only a dispatched order qualifies.
   */
  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.ORDERS_RETURNS_RECEIVE)
  @Post(':id/inventory/receive-return')
  @ApiOperation({
    summary: 'Receive returned goods and restock or write them off',
    description:
      'Per line, choose restock (units become sellable again) or write_off (recorded as damaged, stock unchanged). Idempotent per line.',
  })
  @ApiResponse({ status: 200, description: 'Return recorded' })
  @ApiResponse({ status: 404, description: 'Order or reservation not found' })
  @ApiResponse({ status: 409, description: 'Order was never dispatched, or line not fulfilled' })
  receiveReturn(@Param('id') id: string, @Body() dto: ReceiveReturnDto, @Req() req: any) {
    return this.ordersService.receiveReturn(id, dto, req.user);
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.ORDERS_ARCHIVE)
  @Post(':id/archive')
  @ApiOperation({ summary: 'Archive an order' })
  @ApiResponse({ status: 200, description: 'Order archived' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Order status cannot be archived' })
  archive(@Param('id') id: string, @Req() req: any) {
    return this.ordersService.archive(id, req.user);
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.ORDERS_ARCHIVE)
  @Post(':id/restore')
  @ApiOperation({ summary: 'Restore an archived order' })
  @ApiResponse({ status: 200, description: 'Order restored' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Order is not archived' })
  restore(@Param('id') id: string, @Req() req: any) {
    return this.ordersService.restore(id, req.user);
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.ORDERS_VIEW)
  @Get(':id')
  @ApiOperation({ summary: 'Get order by ID' })
  @ApiResponse({ status: 200, description: 'Order found', type: Order })
  @ApiResponse({ status: 404, description: 'Order not found' })
  findOne(@Param('id') id: string, @Req() req: any, @Query('showDeleted') showDeleted?: string) {
    return this.ordersService.findOne(id, req.user, showDeleted === 'true');
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.ORDERS_UPDATE)
  @Patch(':id')
  @ApiOperation({ summary: 'Update order by ID' })
  @ApiResponse({ status: 200, description: 'Order updated', type: Order })
  @ApiResponse({ status: 404, description: 'Order not found' })
  update(@Param('id') id: string, @Body() updateOrderDto: UpdateOrderDto, @Req() req: any) {
    return this.ordersService.update(id, updateOrderDto, req.user);
  }

  @Roles(Role.VENDOR, Role.ADMIN)
  @RequirePermissions(StorePermission.ORDERS_DELETE)
  @Delete(':id')
  @ApiOperation({ summary: 'Delete order by ID' })
  @ApiResponse({ status: 200, description: 'Order deleted', schema: { properties: { id: { type: 'string' }, deleted: { type: 'boolean' } } } })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 400, description: 'Invalid ID format' })
  remove(@Param('id') id: string, @Req() req: any) {
    return this.ordersService.remove(id, req.user);
  }
}
