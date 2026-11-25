import { Module } from '@nestjs/common';
import { AdminAuthModule } from './admin-auth/admin-auth.module';
import { AdminAccountsModule } from './admin-accounts/admin-accounts.module';
import { AdminStoresModule } from './admin-stores/admin-stores.module';
import { AdminPlansModule } from '../subscriptions/admin-plans.module';
import { AdminSubscriptionsModule } from '../subscriptions/admin-subscriptions.module';

@Module({
  imports: [
    AdminAuthModule,
    AdminAccountsModule,
    AdminStoresModule,
    AdminPlansModule,
    AdminSubscriptionsModule,
  ],
})
export class AdminModule {}

