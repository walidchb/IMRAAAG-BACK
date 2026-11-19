import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { Box, BoxSchema } from '../boxes/schemas/box.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { StoresModule } from '../stores/stores.module';
import { ItemViewsAnalyticsController } from './item-views.analytics.controller';
import { ItemViewsService } from './item-views.service';
import { ItemViewsTrackController } from './item-views.track.controller';
import {
  ItemViewDaily,
  ItemViewDailySchema,
} from './schemas/item-view-daily.schema';

/**
 * Product & Box view analytics.
 *
 * Registers the models it reads directly (no dependency on the Products/Boxes/Analytics
 * modules) and borrows `StoresService` for session store resolution and self-view detection.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ItemViewDaily.name, schema: ItemViewDailySchema },
      { name: Product.name, schema: ProductSchema },
      { name: Box.name, schema: BoxSchema },
    ]),
    StoresModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.secret'),
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [ItemViewsTrackController, ItemViewsAnalyticsController],
  providers: [ItemViewsService],
  exports: [ItemViewsService],
})
export class ItemViewsModule {}
