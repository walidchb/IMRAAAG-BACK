import { Module, forwardRef } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ConfigModule } from '@nestjs/config';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { StoresModule } from '../stores/stores.module';
import { memoryStorage } from 'multer';

@Module({
  imports: [
    MulterModule.register({
      storage: memoryStorage(),
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB
      },
    }),
    ConfigModule,
    // The upload controller resolves the owning store from the session to namespace keys.
    // StoresModule already imports UploadModule (it deletes old images on update), so the
    // dependency is circular by design and deliberately lazy.
    forwardRef(() => StoresModule),
  ],
  controllers: [UploadController],
  providers: [UploadService],
  exports: [UploadService],
})
export class UploadModule {}
