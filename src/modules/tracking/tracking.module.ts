import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TrackingConfig, TrackingConfigSchema } from './schemas/tracking-config.schema';
import { TrackingController } from './tracking.controller';
import { TrackingService } from './tracking.service';
import { StoresModule } from '../stores/stores.module';
import { Store, StoreSchema } from '../stores/schemas/store.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TrackingConfig.name, schema: TrackingConfigSchema },
      // Read-only, used solely to confirm a stale `tracking_configs.storeId` no longer
      // points at a live store before its row is adopted. See `TrackingService.updateConfig`.
      { name: Store.name, schema: StoreSchema },
    ]),
    StoresModule,
  ],
  controllers: [TrackingController],
  providers: [TrackingService],
  exports: [TrackingService, MongooseModule],
})
export class TrackingModule {}
