import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin/admin-auth/admin-auth.module';
import { SubscriptionsModule } from './subscriptions.module';
import { AdminPlansController } from './admin-plans.controller';

@Module({
  imports: [AdminAuthModule, SubscriptionsModule],
  controllers: [AdminPlansController],
})
export class AdminPlansModule {}
