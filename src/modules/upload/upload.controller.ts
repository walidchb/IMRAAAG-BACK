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
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { UploadService } from './upload.service';

@ApiTags('Upload')
@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post('product-image')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload a single product image' })
  @ApiConsumes('multipart/form-data')
  async uploadProductImage(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new AppException(AppErrorCode.UPLOAD_NO_FILE_PROVIDED);
    return this.uploadService.uploadProductImage(file);
  }

  @Post('product-images')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FilesInterceptor('files', 10))
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
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload a store logo' })
  @ApiConsumes('multipart/form-data')
  async uploadStoreLogo(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new AppException(AppErrorCode.UPLOAD_NO_FILE_PROVIDED);
    return this.uploadService.uploadStoreLogo(file);
  }

  @Post('store-cover')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file'))
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
    await this.uploadService.deleteFile(key);
    return { message: 'File deleted' };
  }
}
