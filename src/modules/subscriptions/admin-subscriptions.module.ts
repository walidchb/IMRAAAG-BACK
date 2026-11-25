import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin/admin-auth/admin-auth.module';
import { StoresModule } from '../stores/stores.module';
import { UsersModule } from '../users/users.module';
import { SubscriptionsModule } from './subscriptions.module';
import { AdminSubscriptionsController } from './admin-subscriptions.controller';
import { AdminSubscriptionsService } from './admin-subscriptions.service';

@Module({
  imports: [AdminAuthModule, SubscriptionsModule, StoresModule, UsersModule],
  controllers: [AdminSubscriptionsController],
  providers: [AdminSubscriptionsService],
})
export class AdminSubscriptionsModule {}
