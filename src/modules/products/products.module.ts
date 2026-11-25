import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from './schemas/product.schema';
import { Category, CategorySchema } from '../categories/schemas/category.schema';
import { SubCategory, SubCategorySchema } from '../categories/schemas/sub-category.schema';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { CacheService } from '../../common/cache.service';
import { StoresModule } from '../stores/stores.module';
import { UploadModule } from '../upload/upload.module';
import { InventoryModule } from '../inventory/inventory.module';
import { AuditModule } from '../audit/audit.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { StoreSubscriptionGuard } from '../subscriptions/guards/store-subscription.guard';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      { name: Category.name, schema: CategorySchema },
      { name: SubCategory.name, schema: SubCategorySchema },
      { name: Order.name, schema: OrderSchema },
    ]),
    StoresModule,
    UploadModule,
    // Needed for the default-variant factory and matrix duplication: every created or
    // duplicated product gets its variant structure (and opening balance) in one
    // transaction rather than as a bare field copy. One-directional: InventoryModule
    // never imports ProductsModule.
    InventoryModule,
    AuditModule,
    SubscriptionsModule,
  ],
  controllers: [ProductsController],
  providers: [ProductsService, CacheService, StoreSubscriptionGuard],
  exports: [MongooseModule, ProductsService]
})
export class ProductsModule {}

