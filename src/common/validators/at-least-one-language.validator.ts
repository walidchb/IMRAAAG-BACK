import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

export function AtLeastOneLanguage(
  languages: string[],
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'atLeastOneLanguage',
      target: object.constructor,
      propertyName,
      constraints: languages,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const obj = args.object as Record<string, unknown>;
          const fields = args.constraints as string[];
          return fields.some((field) => {
            const val = obj[field];
            return typeof val === 'string' && val.trim().length > 0;
          });
        },
        defaultMessage(args: ValidationArguments) {
          const fields = args.constraints as string[];
          return `At least one of the following fields is required: ${fields.join(', ')}`;
        },
      },
    });
  };
}

export function AtLeastOneImage(
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'atLeastOneImage',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const obj = args.object as Record<string, unknown>;
          const image = obj['image'];
          const images = obj['images'];
          const hasImage = typeof image === 'string' && image.trim().length > 0;
          const hasImages = Array.isArray(images) && images.length > 0;
          return hasImage || hasImages;
        },
        defaultMessage() {
          return 'At least one product image is required';
        },
      },
    });
  };
}
