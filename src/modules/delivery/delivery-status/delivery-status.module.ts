import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { DeliveryModule } from '../delivery.module';
import { StoresModule } from '../../stores/stores.module';
import { OrdersModule } from '../../orders/orders.module';
import { Order, OrderSchema } from '../../orders/schemas/order.schema';
import { DeliveryConfig, DeliveryConfigSchema } from '../schemas/delivery-config.schema';
import {
  DeliveryParcelStatus,
  DeliveryParcelStatusSchema,
} from '../schemas/delivery-parcel-status.schema';
import { SyncLease, SyncLeaseSchema } from '../schemas/sync-lease.schema';
import { DeliveryStatusService } from './delivery-status.service';
import { DeliveryStatusScheduler } from './delivery-status.scheduler';
import { DeliveryStatusLeaseService } from './delivery-status-lease.service';
import { DeliveryStatusQueryService } from './delivery-status-query.service';
import { DeliveryStatusController } from './delivery-status.controller';
import { DELIVERY_STATUS_ADVANCE } from './delivery-status-advance.interface';
import { OrdersCarrierStatusAdvance } from './delivery-status-advance.provider';

/**
 * The ZR Express status poller (roadmap Phase 3) and its read surface (Phase 5).
 *
 * The module is **self-contained**: it imports what it needs (`DeliveryModule` for the carrier
 * handlers and the parcel-status write path, `StoresModule` for the store resolution) and
 * registers the models it queries.
 *
 * **Phase 5** adds the read controller: the vendor-facing status reads, the manual refresh and
 * the sync health. Every one of them resolves the store from the session — the poller is still
 * not reachable from a client, and the reads are.
 *
 * The scheduler is registered here, so it starts with the application and stops with it.
 *
 * **Phase 4** adds `OrdersModule` and binds the advance provider: the seam is what lets the
 * poller move an order, and the provider is the only thing in the platform that can. The
 * dependency runs one way (`DeliveryStatusModule → OrdersModule → DeliveryModule`) and
 * `DeliveryModule` imports neither of them back, so there is no cycle.
 */
@Module({
  imports: [
    ConfigModule,
    DeliveryModule,
    StoresModule,
    OrdersModule,
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: DeliveryConfig.name, schema: DeliveryConfigSchema },
      { name: DeliveryParcelStatus.name, schema: DeliveryParcelStatusSchema },
      { name: SyncLease.name, schema: SyncLeaseSchema },
    ]),
  ],
  controllers: [DeliveryStatusController],
  providers: [
    DeliveryStatusService,
    DeliveryStatusLeaseService,
    DeliveryStatusScheduler,
    DeliveryStatusQueryService,
    OrdersCarrierStatusAdvance,
    { provide: DELIVERY_STATUS_ADVANCE, useExisting: OrdersCarrierStatusAdvance },
  ],
  exports: [DeliveryStatusService, DeliveryStatusLeaseService, DeliveryStatusQueryService],
})
export class DeliveryStatusModule {}
