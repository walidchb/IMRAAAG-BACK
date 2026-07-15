import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';

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
  ): Promise<{ url: string; key: string }> {
    this.validateFile(file);

    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const key = `${folder}/${uuidv4()}${ext}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

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

      clearTimeout(timeoutId);

      const baseUrl = this.publicUrl.replace(/\/+$/, '');
      const url = baseUrl ? `${baseUrl}/${key}` : key;
      this.logger.log(`File uploaded: ${url}`);
      return { url, key };
    } catch (error) {
      this.logger.error(`Failed to upload file to R2: ${error.message}`);
      const msg = error.message || '';
      if (msg.includes('Access Denied')) {
        throw new BadRequestException(
          'R2 Access Denied. Make sure:\n' +
          '1. The bucket "imraaah" exists in your R2 dashboard\n' +
          '2. Your R2 API token has "Object Read & Write" permission\n' +
          '3. The token is applied to the correct bucket',
        );
      }
      throw new BadRequestException('Failed to upload image. Please try again.');
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
      this.logger.error(`Failed to delete file from R2: ${error.message}`);
    }
  }

  async uploadMultipleFiles(
    files: Express.Multer.File[],
    folder: UploadFolder,
  ): Promise<{ url: string; key: string }[]> {
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
      throw new BadRequestException(
        `Invalid file type "${file.mimetype}". Allowed: JPEG, PNG, WebP, GIF, AVIF`,
      );
    }

    if (file.size > maxSize) {
      throw new BadRequestException(
        `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max: 10MB`,
      );
    }
  }
}
