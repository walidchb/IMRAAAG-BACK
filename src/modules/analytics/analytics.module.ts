import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { ProductVariant, ProductVariantSchema } from '../inventory/schemas/product-variant.schema';
import { StoresModule } from '../stores/stores.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * Seller-dashboard analytics (roadmap).
 *
 * Phase 0 wired the module and the shared query semantics. Phase 1 adds the route layer and the
 * aggregation pipelines: the controller resolves the store from the session and the service
 * owns one `$match` per read. The module registers the Order schema (not the OrdersModule —
 * analytics only reads) and borrows `StoresService` from `StoresModule` for store resolution.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Product.name, schema: ProductSchema },
      { name: ProductVariant.name, schema: ProductVariantSchema },
    ]),
    StoresModule,
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}