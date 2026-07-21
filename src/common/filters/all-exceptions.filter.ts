import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ErrorResponse } from '../interfaces/error-response.interface';
import { MulterError } from 'multer';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number;
    let message: string;
    let error: string;
    let code: string | undefined;
    let params: Record<string, unknown> | undefined;
    let errors: Record<string, string[]> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
        error = exception.name;
      } else if (typeof exceptionResponse === 'object') {
        const resp = exceptionResponse as Record<string, unknown>;

        // Detect AppException by presence of 'code' field
        if (resp.code && typeof resp.code === 'string') {
          code = resp.code;
          params = (resp.params as Record<string, unknown>) ?? {};
          message = (resp.message as string) || code;
          error = exception.name;
          status = (resp.statusCode as number) || status;
        } else {
          message = (resp.message as string) || exception.message;
          error = (resp.error as string) || exception.name;

          if (Array.isArray(resp.message)) {
            const msgs = resp.message as string[];
            error = 'Validation Failed';
            message = 'Validation failed';
            errors = {};
            for (const msg of msgs) {
              const parts = msg.split(' ', 1);
              const field = parts[0]?.toLowerCase() || 'unknown';
              if (!errors[field]) errors[field] = [];
              errors[field].push(msg);
            }
          }
        }
      } else {
        message = exception.message;
        error = exception.name;
      }
    } else if (exception instanceof MulterError) {
      status = HttpStatus.BAD_REQUEST;
      error = 'Upload Error';
      switch (exception.code) {
        case 'LIMIT_FILE_SIZE':
          message = 'File too large. Maximum size is 10MB.';
          break;
        case 'LIMIT_FILE_COUNT':
          message = 'Too many files. Maximum 10 files allowed.';
          break;
        case 'LIMIT_UNEXPECTED_FILE':
          message = 'Unexpected file field.';
          break;
        default:
          message = exception.message;
      }
    } else if (exception instanceof Error) {
      const isCastError =
        exception.name === 'CastError' ||
        (exception.constructor && exception.constructor.name === 'CastError') ||
        (exception.message && exception.message.startsWith('Cast to ObjectId failed'));

      if (isCastError) {
        status = HttpStatus.BAD_REQUEST;
        message = 'Invalid ID format. Please provide a valid identifier.';
        error = 'Bad Request';
      } else {
        status = HttpStatus.INTERNAL_SERVER_ERROR;
        message =
          process.env.NODE_ENV === 'production'
            ? 'Internal server error'
            : exception.message;
        error = 'Internal Server Error';
        code = 'INTERNAL_SERVER_ERROR';
        this.logger.error(
          `Unhandled error: ${exception.message}`,
          exception.stack,
        );
      }
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal server error';
      error = 'Internal Server Error';
    }

    const body: ErrorResponse = {
      statusCode: status,
      message,
      error,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    if (code) body.code = code;
    if (params) body.params = params;
    if (errors) body.errors = errors;

    response.status(status).json(body);
  }
}
