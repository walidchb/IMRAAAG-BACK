import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ProductVariant,
  ProductVariantSchema,
} from '../inventory/schemas/product-variant.schema';
import {
  InventoryBalance,
  InventoryBalanceSchema,
} from '../inventory/schemas/inventory-balance.schema';
import {
  ProductOption,
  ProductOptionSchema,
} from '../inventory/schemas/product-option.schema';
import {
  ProductOptionValue,
  ProductOptionValueSchema,
} from '../inventory/schemas/product-option-value.schema';
import {
  VariantOptionValue,
  VariantOptionValueSchema,
} from '../inventory/schemas/variant-option-value.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { StoresModule } from '../stores/stores.module';
import { OrdersModule } from '../orders/orders.module';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';

/**
 * POS catalog module.
 *
 * It re-registers the inventory schemas rather than importing `InventoryModule`: it needs the
 * models, not the services, and re-registering the same schema is safe (Mongoose keeps one
 * compiled model per connection). The one thing it borrows from inventory is the pure label
 * builder, so labels stay identical across both.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ProductVariant.name, schema: ProductVariantSchema },
      { name: InventoryBalance.name, schema: InventoryBalanceSchema },
      { name: ProductOption.name, schema: ProductOptionSchema },
      { name: ProductOptionValue.name, schema: ProductOptionValueSchema },
      { name: VariantOptionValue.name, schema: VariantOptionValueSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Order.name, schema: OrderSchema },
    ]),
    StoresModule,
    // `OrdersService` owns the immediate-sale write (it already owns the order document and
    // the reservation wiring), so the POS controller delegates to it rather than duplicating
    // that logic. `OrdersModule` does not import `PosModule`, so there is no cycle.
    OrdersModule,
  ],
  controllers: [PosController],
  providers: [PosService],
})
export class PosModule {}
