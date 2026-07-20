import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from './schemas/product.schema';
import { Category, CategorySchema } from '../categories/schemas/category.schema';
import { SubCategory, SubCategorySchema } from '../categories/schemas/sub-category.schema';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { CacheService } from '../../common/cache.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      { name: Category.name, schema: CategorySchema },
      { name: SubCategory.name, schema: SubCategorySchema },
    ])
  ],
  controllers: [ProductsController],
  providers: [ProductsService, CacheService],
  exports: [MongooseModule, ProductsService]
})
export class ProductsModule {}
