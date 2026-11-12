import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Store, StoreSchema } from './schemas/store.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { Category, CategorySchema } from '../categories/schemas/category.schema';
import {
  SubCategory,
  SubCategorySchema,
} from '../categories/schemas/sub-category.schema';
import { StoresController } from './stores.controller';
import { StoresService } from './stores.service';
import { UploadModule } from '../upload/upload.module';
import { StoreMember, StoreMemberSchema } from '../team/schemas/store-member.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Store.name, schema: StoreSchema },
      { name: Product.name, schema: ProductSchema },
      // Store creation seeds the General/General tree, and store removal cascades the
      // soft-delete over it. These are schema registrations only; the modules stay acyclic.
      { name: Category.name, schema: CategorySchema },
      { name: SubCategory.name, schema: SubCategorySchema },
      // StoresService owns the owner-or-active-member lookup (`findByMemberId*`), so it needs
      // the membership model. Registering the schema here keeps StoresModule free of a
      // dependency on TeamModule (the schema file itself imports only enums).
      { name: StoreMember.name, schema: StoreMemberSchema },
    ]),
    forwardRef(() => UploadModule),
  ],
  controllers: [StoresController],
  providers: [StoresService],
  exports: [MongooseModule, StoresService]
})
export class StoresModule {}
