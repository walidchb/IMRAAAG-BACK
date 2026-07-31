import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Store, StoreSchema } from './schemas/store.schema';
import { StoresController } from './stores.controller';
import { StoresService } from './stores.service';
import { UploadModule } from '../upload/upload.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Store.name, schema: StoreSchema }]),
    UploadModule,
  ],
  controllers: [StoresController],
  providers: [StoresService],
  exports: [MongooseModule, StoresService]
})
export class StoresModule {}
