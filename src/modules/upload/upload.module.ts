import { Module, forwardRef } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ConfigModule } from '@nestjs/config';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { UploadSizeGuard } from './upload-size.guard';
import { IMAGE_CONFIG } from './image.config';
import { StoresModule } from '../stores/stores.module';
import { memoryStorage } from 'multer';

@Module({
  imports: [
    MulterModule.register({
      storage: memoryStorage(),
      limits: {
        // The controller sets the effective limit per route; keep the module default aligned.
        fileSize: IMAGE_CONFIG.maxFileSize,
      },
    }),
    ConfigModule,
    // The upload controller resolves the owning store from the session to namespace keys.
    // StoresModule already imports UploadModule (it deletes old images on update), so the
    // dependency is circular by design and deliberately lazy.
    forwardRef(() => StoresModule),
  ],
  controllers: [UploadController],
  providers: [UploadService, UploadSizeGuard],
  exports: [UploadService],
})
export class UploadModule {}
