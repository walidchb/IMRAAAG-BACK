import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AppException } from '../errors/app-exception';
import { AppErrorCode } from '../errors/error-codes.enum';

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected throwThrottlingException(): never {
    throw new AppException(AppErrorCode.RATE_LIMIT_EXCEEDED);
  }
}
