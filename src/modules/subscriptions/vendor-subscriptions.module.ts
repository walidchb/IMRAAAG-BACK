import { Module } from '@nestjs/common';
import { StoresModule } from '../stores/stores.module';
import { SubscriptionsModule } from './subscriptions.module';
import { VendorSubscriptionsController } from './vendor-subscriptions.controller';

@Module({
  imports: [SubscriptionsModule, StoresModule],
  controllers: [VendorSubscriptionsController],
})
export class VendorSubscriptionsModule {}
