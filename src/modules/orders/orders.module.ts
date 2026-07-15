import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from './schemas/order.schema';
import { OrderStatus, OrderStatusSchema } from './schemas/order-status.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { OrdersController } from './orders.controller';
import { OrderStatusesController } from './order-statuses.controller';
import { OrdersService } from './orders.service';
import { OrderStatusesService } from './order-statuses.service';
import { DeliveryModule } from '../delivery/delivery.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: OrderStatus.name, schema: OrderStatusSchema },
      { name: Product.name, schema: ProductSchema },
    ]),
    forwardRef(() => DeliveryModule),
  ],
  controllers: [OrdersController, OrderStatusesController],
  providers: [OrdersService, OrderStatusesService],
  exports: [MongooseModule, OrdersService, OrderStatusesService]
})
export class OrdersModule {}
