import {
  ValidationPipe as NestValidationPipe,
  ValidationError,
  HttpStatus,
} from '@nestjs/common';
import { AppException } from '../errors/app-exception';
import { AppErrorCode } from '../errors/error-codes.enum';

const CONSTRAINT_TO_CODE: Record<string, string> = {
  isEmail: AppErrorCode.VALIDATION_INVALID_EMAIL,
  isString: AppErrorCode.VALIDATION_MUST_BE_STRING,
  isNotEmpty: AppErrorCode.VALIDATION_REQUIRED,
  minLength: AppErrorCode.VALIDATION_MIN_LENGTH,
  min: AppErrorCode.VALIDATION_MIN_VALUE,
  isMongoId: AppErrorCode.VALIDATION_INVALID_ID,
  isArray: AppErrorCode.VALIDATION_INVALID_VALUE,
  arrayMinSize: AppErrorCode.VALIDATION_ARRAY_MIN_SIZE,
  arrayMaxSize: AppErrorCode.VALIDATION_ARRAY_MAX_SIZE,
};

export class ValidationPipe extends NestValidationPipe {
  constructor() {
    super({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (validationErrors: ValidationError[]) => {
        const errors: Record<string, string[]> = {};
        const fieldCodes: Record<string, string> = {};

        for (const error of validationErrors) {
          const field = error.property;
          const constraints = error.constraints || {};
          errors[field] = Object.values(constraints);

          const constraintNames = Object.keys(constraints);
          if (constraintNames.length > 0) {
            fieldCodes[field] = CONSTRAINT_TO_CODE[constraintNames[0]] || AppErrorCode.VALIDATION_INVALID_VALUE;
          }

          if (error.children?.length) {
            for (const child of error.children) {
              const childField = `${field}.${child.property}`;
              const childConstraints = child.constraints || {};
              errors[childField] = Object.values(childConstraints);

              const childNames = Object.keys(childConstraints);
              if (childNames.length > 0) {
                fieldCodes[childField] = CONSTRAINT_TO_CODE[childNames[0]] || AppErrorCode.VALIDATION_INVALID_VALUE;
              }
            }
          }
        }

        return new AppException(
          AppErrorCode.VALIDATION_FAILED,
          { errors, fieldCodes },
          HttpStatus.BAD_REQUEST,
          'Validation failed',
        );
      },
    });
  }
}
