import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { randomUUID } from 'crypto';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const { method, url } = request;
    const requestId = randomUUID().slice(0, 8);
    const startTime = Date.now();

    (request as unknown as Record<string, unknown>)['requestId'] = requestId;

    this.logger.log(`[${requestId}] --> ${method} ${url}`);

    return next.handle().pipe(
      tap(() => {
        const response = context.switchToHttp().getResponse();
        const duration = Date.now() - startTime;
        this.logger.log(
          `[${requestId}] <-- ${method} ${url} ${response.statusCode} ${duration}ms`,
        );
      }),
      catchError((error) => {
        const duration = Date.now() - startTime;
        const status = error?.status || 500;
        this.logger.error(
          `[${requestId}] <-- ${method} ${url} ${status} ${duration}ms - ${error?.message || 'Unknown error'}`,
        );
        return throwError(() => error);
      }),
    );
  }
}
