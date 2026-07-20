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
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { BulkActionDto } from './dto/bulk-action.dto';
import { BulkShipDto } from './dto/bulk-ship.dto';
import { Order } from './schemas/order.schema';

@ApiTags('Orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new order' })
  @ApiResponse({ status: 201, description: 'Order created successfully', type: Order })
  create(@Body() createOrderDto: CreateOrderDto) {
    return this.ordersService.create(createOrderDto);
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
  ) {
    return this.ordersService.findAll(query);
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
  bulkAction(@Body() bulkActionDto: BulkActionDto) {
    return this.ordersService.bulkAction(bulkActionDto);
  }

  @Post('bulk-ship')
  @ApiOperation({ summary: 'Bulk ship orders grouped by delivery company' })
  @ApiResponse({ status: 200, description: 'Bulk ship completed with per-order results' })
  bulkShip(@Body() bulkShipDto: BulkShipDto) {
    return this.ordersService.bulkShip(bulkShipDto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get order by ID' })
  @ApiResponse({ status: 200, description: 'Order found', type: Order })
  @ApiResponse({ status: 404, description: 'Order not found' })
  findOne(@Param('id') id: string) {
    return this.ordersService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update order by ID' })
  @ApiResponse({ status: 200, description: 'Order updated', type: Order })
  @ApiResponse({ status: 404, description: 'Order not found' })
  update(@Param('id') id: string, @Body() updateOrderDto: UpdateOrderDto) {
    return this.ordersService.update(id, updateOrderDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete order by ID' })
  @ApiResponse({ status: 200, description: 'Order deleted', schema: { properties: { id: { type: 'string' }, deleted: { type: 'boolean' } } } })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 400, description: 'Invalid ID format' })
  remove(@Param('id') id: string) {
    return this.ordersService.remove(id);
  }
}
