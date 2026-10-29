import { Allow } from 'class-validator';
import { UpdateOrderDto } from './update-order.dto';

export class UpdateVendorOrderDto extends UpdateOrderDto {
  /** The storefront echoes the order verbatim. Ownership is resolved server-side, so
   *  this field is accepted for validation but stripped by the controller before update. */
  @Allow()
  storeId?: string;

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

  /** The sales channel (ONLINE/POS/MANUAL) is server-assigned at creation. The dashboards
   *  echo the order verbatim, so it is accepted for validation but stripped before update —
   *  a caller can never relabel an order's channel. */
  @Allow()
  source?: string;
}
