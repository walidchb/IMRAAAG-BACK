import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CacheService } from './common/cache.service';
import { AppThrottlerGuard } from './common/guards/throttler.guard';
import configuration from './config/configuration';
import { UsersModule } from './modules/users/users.module';
import { StoresModule } from './modules/stores/stores.module';
import { ProductsModule } from './modules/products/products.module';
import { OrdersModule } from './modules/orders/orders.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { UploadModule } from './modules/upload/upload.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { DeliveryStatusModule } from './modules/delivery/delivery-status/delivery-status.module';
import { DeliveryFeesModule } from './modules/delivery-fees/delivery-fees.module';
import { TerritoriesModule } from './modules/territories/territories.module';
import { ProfileModule } from './modules/profile/profile.module';
import { TrackingModule } from './modules/tracking/tracking.module';
import { SavedProductsModule } from './modules/saved-products/saved-products.module';
import { SearchModule } from './modules/search/search.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { PosModule } from './modules/pos/pos.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { OrderLabelsModule } from './modules/order-labels/order-labels.module';
import { TeamModule } from './modules/team/team.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        uri: configService.get<string>('database.uri'),
      }),
      inject: [ConfigService],
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 60,
      },
    ]),
    AuthModule,
    UsersModule,
    StoresModule,
    ProductsModule,
    OrdersModule,
    AuditModule,
    CategoriesModule,
    UploadModule,
    DeliveryModule,
    DeliveryStatusModule,
    DeliveryFeesModule,
    TerritoriesModule,
    ProfileModule,
    TrackingModule,
    SavedProductsModule,
    SearchModule,
    InventoryModule,
    PosModule,
    AnalyticsModule,
    OrderLabelsModule,
    TeamModule,
  ],
  controllers: [AppController],
  providers: [AppService, CacheService, { provide: APP_GUARD, useClass: AppThrottlerGuard }],
})
export class AppModule {}
