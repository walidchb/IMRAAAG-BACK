import { HttpException } from '@nestjs/common';
import { ERROR_HTTP_STATUS } from './error-statuses.const';
import type { AppErrorCodeType } from './error-codes.enum';

export interface AppExceptionParams {
  [key: string]: unknown;
}

export class AppException extends HttpException {
  public readonly errorCode: string;
  public readonly errorParams: AppExceptionParams;

  constructor(
    code: AppErrorCodeType,
    params?: AppExceptionParams,
    status?: number,
    message?: string,
  ) {
    const resolvedStatus = status ?? ERROR_HTTP_STATUS[code] ?? 500;
    const body = {
      code,
      params: params ?? {},
      statusCode: resolvedStatus,
      message: message ?? code,
    };
    super(body, resolvedStatus);
    this.errorCode = code;
    this.errorParams = params ?? {};
  }
}
