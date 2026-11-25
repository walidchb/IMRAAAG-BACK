import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Category, CategorySchema } from './schemas/category.schema';
import { SubCategory, SubCategorySchema } from './schemas/sub-category.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { StoresModule } from '../stores/stores.module';
import { UploadModule } from '../upload/upload.module';
import { AuditModule } from '../audit/audit.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { StoreSubscriptionGuard } from '../subscriptions/guards/store-subscription.guard';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Category.name, schema: CategorySchema },
      { name: SubCategory.name, schema: SubCategorySchema },
      { name: Product.name, schema: ProductSchema },
    ]),
    // Session store resolution for the controller + image cleanup for removed categories.
    // StoresModule does not import CategoriesModule, so this stays acyclic.
    StoresModule,
    UploadModule,
    AuditModule,
    SubscriptionsModule,
  ],
  controllers: [CategoriesController],
  providers: [CategoriesService, StoreSubscriptionGuard],
  exports: [MongooseModule, CategoriesService],
})
export class CategoriesModule {}
