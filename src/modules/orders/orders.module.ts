import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from './schemas/order.schema';
import { OrderStatus, OrderStatusSchema } from './schemas/order-status.schema';
import { Counter, CounterSchema } from './schemas/counter.schema';
import { PosHold, PosHoldSchema } from './schemas/pos-hold.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { OrdersController } from './orders.controller';
import { OrderStatusesController } from './order-statuses.controller';
import { OrdersService } from './orders.service';
import { OrderStatusesService } from './order-statuses.service';
import { DeliveryModule } from '../delivery/delivery.module';
import { DeliveryFeesModule } from '../delivery-fees/delivery-fees.module';
import { AuditModule } from '../audit/audit.module';
import { StoresModule } from '../stores/stores.module';
import { InventoryModule } from '../inventory/inventory.module';
import { TeamModule } from '../team/team.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: OrderStatus.name, schema: OrderStatusSchema },
      { name: Counter.name, schema: CounterSchema },
      { name: PosHold.name, schema: PosHoldSchema },
      { name: Product.name, schema: ProductSchema },
    ]),
    forwardRef(() => DeliveryModule),
    DeliveryFeesModule,
    AuditModule,
    StoresModule,
    // `OrdersService` enforces the status-target/bulk-action store permissions itself, because
    // the allowed capability depends on the request body rather than the route alone.
    TeamModule,
    // Phase 4: `ReservationsService` is imported, not the whole inventory module, because a
    // confirm/dispatch has to reserve or deduct inside the same transaction as the status
    // claim. `InventoryModule` does not import this one back, so no `forwardRef` is needed.
    InventoryModule,
  ],
  controllers: [OrdersController, OrderStatusesController],
  providers: [OrdersService, OrderStatusesService],
  exports: [MongooseModule, OrdersService, OrderStatusesService],
})
export class OrdersModule {}
