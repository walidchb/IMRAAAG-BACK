import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { StoresModule } from '../../stores/stores.module';
import { UsersModule } from '../../users/users.module';
import { AdminStoresController } from './admin-stores.controller';
import { AdminStoresService } from './admin-stores.service';

@Module({
  imports: [AdminAuthModule, StoresModule, UsersModule],
  controllers: [AdminStoresController],
  providers: [AdminStoresService],
})
export class AdminStoresModule {}
