import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DeliveryFee, DeliveryFeeSchema } from './schemas/delivery-fee.schema';
import { DeliveryConfig, DeliveryConfigSchema } from '../delivery/schemas/delivery-config.schema';
import { DeliveryFeesController } from './delivery-fees.controller';
import { DeliveryFeesService } from './delivery-fees.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DeliveryFee.name, schema: DeliveryFeeSchema },
      { name: DeliveryConfig.name, schema: DeliveryConfigSchema },
    ]),
  ],
  controllers: [DeliveryFeesController],
  providers: [DeliveryFeesService],
  exports: [DeliveryFeesService, MongooseModule],
})
export class DeliveryFeesModule {}
