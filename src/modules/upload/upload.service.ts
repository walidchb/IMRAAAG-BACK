import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { IMAGE_CONFIG } from './image.config';

type VariantDef = {
  suffix: string;
  width: number;
  height: number;
  fit: 'cover' | 'inside';
};

type ImageFolder = keyof typeof IMAGE_CONFIG.folders;

export type UploadResult = {
  url: string;
  key: string;
  thumbnail: string;
  thumbnailKey: string;
  medium: string;
  mediumKey: string;
  large: string;
  largeKey: string;
};

export type MultiUploadResult = UploadResult[];

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
    const secretAccessKey = this.configService.get<string>('r2.secretAccessKey') || '';

    this.s3 = new S3Client({
      region: 'auto',
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
  }

  async uploadProductImage(file: Express.Multer.File): Promise<UploadResult> {
    this.validateFile(file);
    const folder = IMAGE_CONFIG.folders.product;
    const variants = IMAGE_CONFIG.variants.product;
    const maxWidth = IMAGE_CONFIG.maxWidths.product;
    return this.processUpload(file, folder, variants, maxWidth);
  }

  async uploadProductImages(files: Express.Multer.File[]): Promise<MultiUploadResult> {
    return Promise.all(files.map((f) => this.uploadProductImage(f)));
  }

  async uploadStoreLogo(file: Express.Multer.File): Promise<UploadResult> {
    this.validateFile(file);
    const folder = IMAGE_CONFIG.folders.storeLogo;
    const variants = IMAGE_CONFIG.variants.storeLogo;
    const maxWidth = IMAGE_CONFIG.maxWidths.storeLogo;
    return this.processUpload(file, folder, variants, maxWidth);
  }

  async uploadStoreCover(file: Express.Multer.File): Promise<UploadResult> {
    this.validateFile(file);
    const folder = IMAGE_CONFIG.folders.storeCover;
    const variants = IMAGE_CONFIG.variants.storeCover;
    const maxWidth = IMAGE_CONFIG.maxWidths.storeCover;
    return this.processUpload(file, folder, variants, maxWidth);
  }

  private async processUpload(
    file: Express.Multer.File,
    folder: string,
    variants: readonly VariantDef[],
    maxWidth: number,
  ): Promise<UploadResult> {
    const id = randomUUID();
    const baseKey = `${folder}/${id}`;
    const baseUrl = this.publicUrl.replace(/\/+$/, '');

    let pipeline = sharp(file.buffer).rotate();

    const metadata = await sharp(file.buffer).metadata();
    if (metadata.width && metadata.width > maxWidth) {
      pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
    }

    const mainBuffer = await pipeline.webp({ quality: IMAGE_CONFIG.quality }).toBuffer();
    const mainKey = `${baseKey}.webp`;
    const mainUrl = baseUrl ? `${baseUrl}/${mainKey}` : mainKey;

    const results: Record<string, { url: string; key: string }> = {};

    const uploadPromises = variants.map(async (v) => {
      const buf = await sharp(file.buffer)
        .rotate()
        .resize(v.width, v.height, { fit: v.fit, withoutEnlargement: true })
        .webp({ quality: IMAGE_CONFIG.quality })
        .toBuffer();

      const key = `${baseKey}-${v.suffix}.webp`;
      const url = baseUrl ? `${baseUrl}/${key}` : key;

      await this.uploadToR2(key, buf, 'image/webp');
      results[v.suffix] = { url, key };
    });

    await Promise.all([this.uploadToR2(mainKey, mainBuffer, 'image/webp'), ...uploadPromises]);

    this.logger.log(`Images uploaded: ${mainKey}`);
    return {
      url: mainUrl,
      key: mainKey,
      thumbnail: results['thumb']?.url || mainUrl,
      thumbnailKey: results['thumb']?.key || mainKey,
      medium: results['medium']?.url || mainUrl,
      mediumKey: results['medium']?.key || mainKey,
      large: results['large']?.url || mainUrl,
      largeKey: results['large']?.key || mainKey,
    };
  }

  private async uploadToR2(key: string, body: Buffer, contentType: string): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: 'public, max-age=31536000, immutable',
        }),
        { abortSignal: controller.signal },
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async deleteFile(key: string): Promise<void> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      await this.s3.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: controller.signal },
      );

      clearTimeout(timeoutId);
      this.logger.log(`File deleted: ${key}`);
    } catch (error) {
      this.logger.error(`Failed to delete file from R2: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      throw new AppException(AppErrorCode.UPLOAD_DELETE_FAILED, { key });
    }
  }

  async deleteFiles(keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => this.deleteFile(key).catch((err) => {
      this.logger.warn(`Failed to delete ${key}: ${err.message}`);
    })));
  }

  async deleteProductImages(mainKey: string): Promise<void> {
    const base = mainKey.replace(/\.webp$/, '');
    const keys = [
      mainKey,
      `${base}-thumb.webp`,
      `${base}-medium.webp`,
      `${base}-large.webp`,
    ];
    await this.deleteFiles(keys);
  }

  extractKeyFromUrl(url: string): string | null {
    if (!url) return null;
    if (this.publicUrl && url.startsWith(this.publicUrl)) {
      return url.slice(this.publicUrl.length).replace(/^\//, '');
    }
    if (!url.startsWith('http')) return url;
    return null;
  }

  private validateFile(file: Express.Multer.File): void {
    if (!file.buffer || file.buffer.length === 0) {
      throw new AppException(AppErrorCode.UPLOAD_NO_FILE_PROVIDED);
    }

    if (!IMAGE_CONFIG.allowedMimeTypes.includes(file.mimetype as any)) {
      throw new AppException(AppErrorCode.UPLOAD_INVALID_FILE_TYPE, { mime: file.mimetype });
    }

    if (file.size > IMAGE_CONFIG.maxFileSize) {
      throw new AppException(AppErrorCode.UPLOAD_FILE_TOO_LARGE, {
        size: (file.size / 1024 / 1024).toFixed(1),
      });
    }
  }
}
