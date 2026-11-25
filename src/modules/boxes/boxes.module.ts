import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Box, BoxSchema } from './schemas/box.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { BoxesController } from './boxes.controller';
import { BoxesService } from './boxes.service';
import { StoresModule } from '../stores/stores.module';
import { InventoryModule } from '../inventory/inventory.module';
import { UploadModule } from '../upload/upload.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { StoreSubscriptionGuard } from '../subscriptions/guards/store-subscription.guard';

/**
 * Dependency direction: `OrdersModule → BoxesModule → InventoryModule`.
 *
 * `ProductsModule` is deliberately not imported (it is heavy and itself imports
 * `InventoryModule`); the `Product` model is registered directly, the same pattern
 * `InventoryModule` uses. `Order` is registered for the delete guard only — a schema
 * registration creates no module dependency, so the graph stays acyclic.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Box.name, schema: BoxSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Order.name, schema: OrderSchema },
    ]),
    StoresModule,
    InventoryModule,
    UploadModule,
    SubscriptionsModule,
  ],
  controllers: [BoxesController],
  providers: [BoxesService, StoreSubscriptionGuard],
  exports: [BoxesService, MongooseModule],
})
export class BoxesModule {}
