import { Allow } from 'class-validator';
import { UpdateOrderDto } from './update-order.dto';

export class UpdateVendorOrderDto extends UpdateOrderDto {
  @Allow()
  id?: string;

  @Allow()
  orderNo?: string;

  @Allow()
  _id?: string;

  @Allow()
  deliveryParcelId?: string;

  @Allow()
  deliveryError?: string;

  @Allow()
  updatedAt?: string;
}
