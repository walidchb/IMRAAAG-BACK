import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Category, CategorySchema } from './schemas/category.schema';
import { SubCategory, SubCategorySchema } from './schemas/sub-category.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { CacheService } from '../../common/cache.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Category.name, schema: CategorySchema },
      { name: SubCategory.name, schema: SubCategorySchema },
      { name: Product.name, schema: ProductSchema },
    ]),
  ],
  controllers: [CategoriesController],
  providers: [CategoriesService, CacheService],
  exports: [MongooseModule, CategoriesService],
})
export class CategoriesModule {}
