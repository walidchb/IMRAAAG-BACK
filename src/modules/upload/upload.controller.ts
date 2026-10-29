import {
  Controller,
  Post,
  Delete,
  Body,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { UploadService } from './upload.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../../common/constants/roles.enum';
import { IMAGE_CONFIG } from './image.config';

@ApiTags('Upload')
@Controller('upload')
@Roles(Role.VENDOR, Role.ADMIN)
@Throttle({ default: { limit: 20, ttl: 60000 } })
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post('product-image')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMAGE_CONFIG.maxFileSize } }))
  @ApiOperation({ summary: 'Upload a single product image' })
  @ApiConsumes('multipart/form-data')
  async uploadProductImage(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new AppException(AppErrorCode.UPLOAD_NO_FILE_PROVIDED);
    return this.uploadService.uploadProductImage(file);
  }

  @Post('product-images')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FilesInterceptor('files', 10, { limits: { fileSize: IMAGE_CONFIG.maxFileSize, files: 10 } }),
  )
  @ApiOperation({ summary: 'Upload multiple product images (max 10)' })
  @ApiConsumes('multipart/form-data')
  async uploadProductImages(@UploadedFiles() files: Express.Multer.File[]) {
    if (!files || files.length === 0)
      throw new AppException(AppErrorCode.UPLOAD_NO_FILE_PROVIDED);
    if (files.length > 10)
      throw new AppException(AppErrorCode.UPLOAD_MAX_FILES_EXCEEDED);
    const results = await this.uploadService.uploadProductImages(files);
    return { images: results };
  }

  @Post('store-logo')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMAGE_CONFIG.maxFileSize } }))
  @ApiOperation({ summary: 'Upload a store logo' })
  @ApiConsumes('multipart/form-data')
  async uploadStoreLogo(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new AppException(AppErrorCode.UPLOAD_NO_FILE_PROVIDED);
    return this.uploadService.uploadStoreLogo(file);
  }

  @Post('store-cover')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMAGE_CONFIG.maxFileSize } }))
  @ApiOperation({ summary: 'Upload a store cover image' })
  @ApiConsumes('multipart/form-data')
  async uploadStoreCover(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new AppException(AppErrorCode.UPLOAD_NO_FILE_PROVIDED);
    return this.uploadService.uploadStoreCover(file);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an uploaded image by key' })
  async deleteFile(@Body('key') key: string) {
    if (!key) throw new AppException(AppErrorCode.UPLOAD_NO_KEY_PROVIDED);
    this.assertAllowedKey(key);
    await this.uploadService.deleteFile(key);
    return { message: 'File deleted' };
  }

  /**
   * Only keys shaped exactly like an R2 upload (`<allowed-folder>/<uuid>(-<variant>)?.webp`)
   * may be deleted. Arbitrary keys would let an authenticated vendor reach any object in the
   * bucket, so anything else is refused up front rather than handed to the R2 client (ME-3).
   */
  private assertAllowedKey(key: string): void {
    const folders = Object.values(IMAGE_CONFIG.folders).join('|');
    const allowedShape = new RegExp(
      `^(${folders})\\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[a-z]+)?\\.webp$`,
    );
    if (!allowedShape.test(key)) {
      throw new AppException(AppErrorCode.UPLOAD_KEY_FORBIDDEN, { key });
    }
  }
}
