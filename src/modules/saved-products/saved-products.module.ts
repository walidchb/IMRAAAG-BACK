import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SavedProduct, SavedProductSchema } from './schemas/saved-product.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { SavedProductsController } from './saved-products.controller';
import { SavedProductsService } from './saved-products.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SavedProduct.name, schema: SavedProductSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [SavedProductsController],
  providers: [SavedProductsService],
  exports: [SavedProductsService],
})
export class SavedProductsModule {}
