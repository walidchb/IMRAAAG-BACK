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
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { CreateVendorOrderDto } from './dto/create-vendor-order.dto';
import { UpdateVendorOrderDto } from './dto/update-vendor-order.dto';
import { BulkActionDto } from './dto/bulk-action.dto';
import { BulkShipDto } from './dto/bulk-ship.dto';
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

  @Post('vendor')
  @ApiOperation({ summary: 'Create a new order (vendor)' })
  @ApiResponse({ status: 201, description: 'Order created successfully', type: Order })
  createVendor(@Body() dto: CreateVendorOrderDto, @Req() req: any) {
    const { id: _id, orderNo: _orderNo, ...cleanDto } = dto;
    return this.ordersService.create(cleanDto as CreateOrderDto, req.user);
  }

  @Patch('vendor/:id')
  @ApiOperation({ summary: 'Update order (vendor)' })
  @ApiResponse({ status: 200, description: 'Order updated', type: Order })
  updateVendor(@Param('id') id: string, @Body() dto: UpdateVendorOrderDto, @Req() req: any) {
    const { id: _unusedId, orderNo: _unusedOrderNo, _id: __id, deliveryParcelId: _parcelId, deliveryError: _err, updatedAt: _updatedAt, ...cleanDto } = dto;
    return this.ordersService.update(id, cleanDto as UpdateOrderDto, req.user);
  }

  @Public()
  @Get('track/:orderNo')
  @ApiOperation({ summary: 'Track an order by order number (public, requires phone verification)' })
  @ApiQuery({ name: 'phone', required: true, description: 'Customer phone number for verification' })
  @ApiResponse({ status: 200, description: 'Order found' })
  @ApiResponse({ status: 404, description: 'Order not found or phone mismatch' })
  trackByOrderNo(@Param('orderNo') orderNo: string, @Query('phone') phone: string) {
    return this.ordersService.findByOrderNo(orderNo, phone);
  }

  @Get('mine/:id')
  @ApiOperation({ summary: 'Get a single order for the authenticated customer' })
  @ApiResponse({ status: 200, description: 'Order found' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  findOneMine(@Param('id') id: string, @Req() req: any) {
    const phone = (req.user as any)?.phoneNumber;
    return this.ordersService.findOneByCustomer(id, phone);
  }

  @Get()
  @ApiOperation({ summary: 'List all orders' })
  @ApiQuery({ name: 'vendorEmail', required: false })
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
    const phone = (req.user as any).phoneNumber;
    return this.ordersService.findByCustomerPhone(phone, {
      page: Number(page),
      limit: Number(limit),
      status,
    });
  }

  @Post('bulk')
  @ApiOperation({ summary: 'Bulk action on orders (confirm, cancel, delete)' })
  @ApiResponse({ status: 200, description: 'Bulk action completed' })
  bulkAction(@Body() bulkActionDto: BulkActionDto, @Req() req: any) {
    return this.ordersService.bulkAction(bulkActionDto, req.user);
  }

  @Post('bulk-ship')
  @ApiOperation({ summary: 'Bulk ship orders grouped by delivery company' })
  @ApiResponse({ status: 200, description: 'Bulk ship completed with per-order results' })
  bulkShip(@Body() bulkShipDto: BulkShipDto, @Req() req: any) {
    return this.ordersService.bulkShip(bulkShipDto, req.user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get order by ID' })
  @ApiResponse({ status: 200, description: 'Order found', type: Order })
  @ApiResponse({ status: 404, description: 'Order not found' })
  findOne(@Param('id') id: string, @Req() req: any, @Query('showDeleted') showDeleted?: string) {
    return this.ordersService.findOne(id, req.user, showDeleted === 'true');
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update order by ID' })
  @ApiResponse({ status: 200, description: 'Order updated', type: Order })
  @ApiResponse({ status: 404, description: 'Order not found' })
  update(@Param('id') id: string, @Body() updateOrderDto: UpdateOrderDto, @Req() req: any) {
    return this.ordersService.update(id, updateOrderDto, req.user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete order by ID' })
  @ApiResponse({ status: 200, description: 'Order deleted', schema: { properties: { id: { type: 'string' }, deleted: { type: 'boolean' } } } })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 400, description: 'Invalid ID format' })
  remove(@Param('id') id: string, @Req() req: any) {
    return this.ordersService.remove(id, req.user);
  }
}
