import {
  ValidationPipe as NestValidationPipe,
  ValidationError,
  BadRequestException,
} from '@nestjs/common';

export class ValidationPipe extends NestValidationPipe {
  constructor() {
    super({
      whitelist: true,
      transform: true,
      exceptionFactory: (validationErrors: ValidationError[]) => {
        const errors: Record<string, string[]> = {};

        for (const error of validationErrors) {
          const field = error.property;
          const constraints = error.constraints || {};
          errors[field] = Object.values(constraints);

          if (error.children?.length) {
            for (const child of error.children) {
              const childField = `${field}.${child.property}`;
              const childConstraints = child.constraints || {};
              errors[childField] = Object.values(childConstraints);
            }
          }
        }

        return new BadRequestException({
          message: 'Validation failed',
          error: 'Validation Failed',
          errors,
        });
      },
    });
  }
}
