import { Allow } from 'class-validator';
import { CreateOrderDto } from './create-order.dto';

export class CreateVendorOrderDto extends CreateOrderDto {
  @Allow()
  id?: string;

  @Allow()
  orderNo?: string;
}
