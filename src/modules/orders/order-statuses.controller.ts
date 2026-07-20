import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { OrderStatusesService } from './order-statuses.service';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Order Statuses')
@Controller('order-statuses')
export class OrderStatusesController {
  constructor(private readonly statusesService: OrderStatusesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Get all order statuses (public)' })
  getAll() {
    return this.statusesService.getAll();
  }
}
