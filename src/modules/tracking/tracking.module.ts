import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TrackingConfig, TrackingConfigSchema } from './schemas/tracking-config.schema';
import { TrackingController } from './tracking.controller';
import { TrackingService } from './tracking.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: TrackingConfig.name, schema: TrackingConfigSchema }]),
  ],
  controllers: [TrackingController],
  providers: [TrackingService],
  exports: [TrackingService, MongooseModule],
})
export class TrackingModule {}
