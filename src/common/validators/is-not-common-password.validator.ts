import { registerDecorator, ValidationOptions } from 'class-validator';
import { isCommonPassword } from '../constants/password.const';

/** Rejects a password that is on the offline common-password denylist (H4). */
export function IsNotCommonPassword(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isNotCommonPassword',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return typeof value !== 'string' || !isCommonPassword(value);
        },
        defaultMessage() {
          return 'This password is too common. Choose something less predictable.';
        },
      },
    });
  };
}
