import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { UploadService } from '../../upload/upload.service';
import {
  ORDER_LABEL_ARTIFACT_FILES,
  ORDER_LABEL_ARTIFACT_PREFIX,
  ORDER_LABEL_JOB_ID_PATTERN,
  OrderLabelArtifactFile,
} from '../order-labels.constants';
import type { LabelArtifactStream } from '../types';

@Injectable()
export class LabelArtifactService {
  private readonly logger = new Logger(LabelArtifactService.name);

  constructor(
    private readonly uploadService: UploadService,
    private readonly configService: ConfigService,
  ) {}

  assertConfigured(): void {
    const endpoint = this.configService.get<string>('r2.endpoint');
    const accessKeyId = this.configService.get<string>('r2.accessKeyId');
    const secretAccessKey = this.configService.get<string>('r2.secretAccessKey');
    const bucket = this.configService.get<string>('r2.bucket');
    if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
      throw new AppException(AppErrorCode.ORDER_LABEL_STORAGE_UNAVAILABLE);
    }
  }

  async put(
    storeId: string,
    jobId: string,
    file: OrderLabelArtifactFile,
    bytes: Buffer,
    contentType: 'application/pdf' | 'application/zip',
  ): Promise<string> {
    this.assertConfigured();
    const key = this.keyFor(storeId, jobId, file);
    try {
      await this.uploadService.putPrivateObject(key, bytes, contentType);
    } catch (err) {
      this.logger.error(
        `Unable to store order-label artifact ${jobId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new AppException(AppErrorCode.ORDER_LABEL_STORAGE_UNAVAILABLE);
    }
    return key;
  }

  async stream(
    storeId: string,
    jobId: string,
    file: OrderLabelArtifactFile,
  ): Promise<LabelArtifactStream> {
    if (!ORDER_LABEL_JOB_ID_PATTERN.test(jobId) || !this.isAllowedFile(file)) {
      throw new AppException(AppErrorCode.ORDER_LABEL_ARTIFACT_NOT_FOUND, { jobId });
    }

    this.assertConfigured();
    const key = this.keyFor(storeId, jobId, file);
    try {
      const object = await this.uploadService.streamPrivateObject(key);
      return {
        ...object,
        contentDisposition: `attachment; filename="order-labels-${jobId}.${file === 'labels.zip' ? 'zip' : 'pdf'}"`,
      };
    } catch (err) {
      if (
        err instanceof AppException &&
        err.errorCode === AppErrorCode.ORDER_LABEL_ARTIFACT_NOT_FOUND
      ) {
        throw err;
      }
      throw new AppException(AppErrorCode.ORDER_LABEL_ARTIFACT_NOT_FOUND, { jobId });
    }
  }

  fileNameFor(jobId: string, file: OrderLabelArtifactFile): string {
    return `order-labels-${jobId}.${file === 'labels.zip' ? 'zip' : 'pdf'}`;
  }

  private keyFor(storeId: string, jobId: string, file: OrderLabelArtifactFile): string {
    return `${ORDER_LABEL_ARTIFACT_PREFIX}/${storeId}/${jobId}/${file}`;
  }

  private isAllowedFile(file: string): file is OrderLabelArtifactFile {
    return (ORDER_LABEL_ARTIFACT_FILES as readonly string[]).includes(file);
  }
}
