import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { ProductsModule } from '../products/products.module';
import { StoresModule } from '../stores/stores.module';

@Module({
  imports: [ProductsModule, StoresModule],
  controllers: [SearchController],
})
export class SearchModule {}
