import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import * as path from 'path';
import sharp from 'sharp';

export type UploadFolder = 'products' | 'stores';

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.bucket = this.configService.get<string>('r2.bucket') || 'imraaah';
    this.publicUrl = this.configService.get<string>('r2.publicUrl') || '';

    const endpoint = this.configService.get<string>('r2.endpoint') || '';
    const accessKeyId = this.configService.get<string>('r2.accessKeyId') || '';
    const secretAccessKey =
      this.configService.get<string>('r2.secretAccessKey') || '';

    this.s3 = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  async uploadFile(
    file: Express.Multer.File,
    folder: UploadFolder,
  ): Promise<{ url: string; key: string; thumbUrl: string; thumbKey: string }> {
    this.validateFile(file);

    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const baseName = `${folder}/${randomUUID()}`;
    const key = `${baseName}${ext}`;
    const thumbKey = `${baseName}-thumb.webp`;

    const baseUrl = this.publicUrl.replace(/\/+$/, '');
    const url = baseUrl ? `${baseUrl}/${key}` : key;
    const thumbUrl = baseUrl ? `${baseUrl}/${thumbKey}` : thumbKey;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      // Upload original
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
          CacheControl: 'public, max-age=31536000',
        }),
        { abortSignal: controller.signal },
      );

      // Generate and upload thumbnail
      const thumbBuffer = await sharp(file.buffer)
        .resize(400, 400, { fit: 'cover', position: 'centre' })
        .webp({ quality: 80 })
        .toBuffer();

      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: thumbKey,
          Body: thumbBuffer,
          ContentType: 'image/webp',
          CacheControl: 'public, max-age=31536000',
        }),
        { abortSignal: controller.signal },
      );

      clearTimeout(timeoutId);

      this.logger.log(`File uploaded: ${url}`);
      return { url, key, thumbUrl, thumbKey };
    } catch (error) {
      this.logger.error(`Failed to upload file to R2: ${error.message}`);
      const msg = error.message || '';
      if (msg.includes('Access Denied')) {
        throw new AppException(AppErrorCode.UPLOAD_R2_ACCESS_DENIED);
      }
      throw new AppException(AppErrorCode.UPLOAD_FAILED);
    }
  }

  async deleteFile(key: string): Promise<void> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      await this.s3.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
        { abortSignal: controller.signal },
      );

      clearTimeout(timeoutId);
      this.logger.log(`File deleted: ${key}`);
    } catch (error) {
      this.logger.error(`Failed to delete file from R2: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      throw new AppException(AppErrorCode.UPLOAD_DELETE_FAILED, { key });
    }
  }

  async uploadMultipleFiles(
    files: Express.Multer.File[],
    folder: UploadFolder,
  ): Promise<{ url: string; key: string; thumbUrl: string; thumbKey: string }[]> {
    const results = await Promise.all(
      files.map((file) => this.uploadFile(file, folder)),
    );
    return results;
  }

  private validateFile(file: Express.Multer.File): void {
    const allowedMimes = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'image/avif',
    ];
    const maxSize = 10 * 1024 * 1024; // 10MB

    if (!allowedMimes.includes(file.mimetype)) {
      throw new AppException(AppErrorCode.UPLOAD_INVALID_FILE_TYPE, { mime: file.mimetype });
    }

    if (file.size > maxSize) {
      throw new AppException(AppErrorCode.UPLOAD_FILE_TOO_LARGE, { size: (file.size / 1024 / 1024).toFixed(1) });
    }
  }
}
