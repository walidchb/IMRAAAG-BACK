import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { DeliveryModule } from '../delivery/delivery.module';
import { StoresModule } from '../stores/stores.module';
import { UploadModule } from '../upload/upload.module';
import { OrderLabelsController } from './order-labels.controller';
import { OrderLabelsService } from './order-labels.service';
import { LabelRendererService } from './services/label-renderer.service';
import { LabelComposerService } from './services/label-composer.service';
import { LabelArtifactService } from './services/label-artifact.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Order.name, schema: OrderSchema }]),
    DeliveryModule,
    StoresModule,
    UploadModule,
  ],
  controllers: [OrderLabelsController],
  providers: [
    OrderLabelsService,
    LabelRendererService,
    LabelComposerService,
    LabelArtifactService,
  ],
  exports: [OrderLabelsService],
})
export class OrderLabelsModule {}
