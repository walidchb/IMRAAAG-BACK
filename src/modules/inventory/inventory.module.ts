import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ProductOption,
  ProductOptionSchema,
} from './schemas/product-option.schema';
import {
  ProductOptionValue,
  ProductOptionValueSchema,
} from './schemas/product-option-value.schema';
import {
  ProductVariant,
  ProductVariantSchema,
} from './schemas/product-variant.schema';
import {
  VariantOptionValue,
  VariantOptionValueSchema,
} from './schemas/variant-option-value.schema';
import {
  InventoryBalance,
  InventoryBalanceSchema,
} from './schemas/inventory-balance.schema';
import {
  InventoryMovement,
  InventoryMovementSchema,
} from './schemas/inventory-movement.schema';
import {
  InventoryReservation,
  InventoryReservationSchema,
} from './schemas/inventory-reservation.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Store, StoreSchema } from '../stores/schemas/store.schema';
import { StoresModule } from '../stores/stores.module';
import { InventoryController } from './inventory.controller';
import { VariantsController } from './variants.controller';
import { InventoryService } from './services/inventory.service';
import { InventoryReadService } from './services/inventory-read.service';
import { MovementsService } from './services/movements.service';
import { VariantsService } from './services/variants.service';
import { ReservationsService } from './services/reservations.service';
import { BarcodeService } from './services/barcode.service';

/**
 * `Product` is registered here because `InventoryReadService` owns the stock choke point:
 * it resolves every product's stock through its variant balances, so it reads
 * `Product.lowStockThreshold` and `Product.storeId` itself. (The old `hasVariants` stock
 * branch and its `Product.stock` read disappeared with the field.) Registering the same
 * model in two modules is safe: Mongoose keeps one connection per URI and reuses the
 * compiled model.
 *
 * `Order` is registered for `ReservationsService`, which stamps `Order.inventoryState` in the
 * same transaction as the reservation it describes - if that write were outside the
 * transaction, a committed reservation could sit against an order that claims none happened.
 *
 * `Store` is registered for `BarcodeService`, which draws each store's EAN-13 body from
 * `Store.barcodeSeq` with an atomic `$inc`.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ProductOption.name, schema: ProductOptionSchema },
      { name: ProductOptionValue.name, schema: ProductOptionValueSchema },
      { name: ProductVariant.name, schema: ProductVariantSchema },
      { name: VariantOptionValue.name, schema: VariantOptionValueSchema },
      { name: InventoryBalance.name, schema: InventoryBalanceSchema },
      { name: InventoryMovement.name, schema: InventoryMovementSchema },
      { name: InventoryReservation.name, schema: InventoryReservationSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Order.name, schema: OrderSchema },
      { name: User.name, schema: UserSchema },
      { name: Store.name, schema: StoreSchema },
    ]),
    StoresModule,
  ],
  controllers: [InventoryController, VariantsController],
  providers: [
    InventoryService,
    InventoryReadService,
    MovementsService,
    VariantsService,
    ReservationsService,
    BarcodeService,
  ],
  exports: [
    InventoryService,
    InventoryReadService,
    MovementsService,
    VariantsService,
    ReservationsService,
    BarcodeService,
  ],
})
export class InventoryModule {}
