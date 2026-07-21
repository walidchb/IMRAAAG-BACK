import { Order } from '../../../orders/schemas/order.schema';

export interface BulkOrderResult {
  orderNo: string;
  success: boolean;
  parcelId?: string;
  error?: string;
}

export interface DeliveryCompanyHandler {
  readonly companyId: string;
  createOrder(order: Order): Promise<{ parcelId: string }>;
  createBulkOrders?(orders: Order[]): Promise<BulkOrderResult[]>;
}
