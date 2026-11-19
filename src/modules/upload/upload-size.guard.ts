import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { IMAGE_CONFIG } from './image.config';

/**
 * Rejects an oversized multipart request before multer reads it into memory.
 *
 * Vercel Functions enforce a 4.5 MB total request-body limit. `limits.fileSize` on multer is
 * per file, so a batch of small files could still exceed the platform limit. This guard checks
 * the request `Content-Length` against the aggregate budget. A chunked request without a
 * Content-Length is caught again after upload by the controller's sum check.
 */
@Injectable()
export class UploadSizeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const raw = request.headers['content-length'];
    if (!raw) return true;

    const length = Number(raw);
    if (!Number.isFinite(length) || length <= 0) return true;
    if (length > IMAGE_CONFIG.maxTotalUploadBytes) {
      throw new AppException(AppErrorCode.UPLOAD_REQUEST_TOO_LARGE, {
        limitMb: (IMAGE_CONFIG.maxTotalUploadBytes / (1024 * 1024)).toFixed(1),
      });
    }
    return true;
  }
}
