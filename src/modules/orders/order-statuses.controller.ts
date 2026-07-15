import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { OrderStatusesService } from './order-statuses.service';

@ApiTags('Order Statuses')
@Controller('order-statuses')
export class OrderStatusesController {
  constructor(private readonly statusesService: OrderStatusesService) {}

  @Get()
  @ApiOperation({ summary: 'Get all order statuses' })
  getAll() {
    return this.statusesService.getAll();
  }
}
