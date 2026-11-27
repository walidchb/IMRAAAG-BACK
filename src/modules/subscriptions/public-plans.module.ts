import { Module } from '@nestjs/common';
import { SubscriptionsModule } from './subscriptions.module';
import { PublicPlansController } from './public-plans.controller';

@Module({
  imports: [SubscriptionsModule],
  controllers: [PublicPlansController],
})
export class PublicPlansModule {}
