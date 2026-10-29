import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { Roles } from '../decorators/roles.decorator';
import { Public } from '../decorators/public.decorator';
import { Role } from '../../../common/constants/roles.enum';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';

/**
 * `@Public()` has to beat a class-level `@Roles`.
 *
 * The global JWT guard honours `IS_PUBLIC_KEY`, and this one did not. Any controller combining a
 * class-level `@UseGuards(RolesGuard) @Roles(...)` with a `@Public()` handler therefore left that
 * handler throwing AUTH_UNAUTHORIZED for the anonymous visitors it was written for: the JWT guard
 * stepped aside, then this one demanded a session.
 *
 * That is how `GET /products/:productId/variants/public-matrix` - which the storefront must be
 * able to read as a logged-out shopper - would have been unreachable. The tests below pin the
 * override *and* its boundary, because a fix that let public through everywhere would be worse
 * than the bug: it would silently expose the rest of the vendor controller.
 */
describe('RolesGuard', () => {
  let reflector: Reflector;
  let guard: RolesGuard;

  const handler = () => function handler() {};
  const cls = () => class Controller {};

  /** ExecutionContext carrying only `user`, which is all the guard reads. */
  const ctx = (user?: { role: Role }): ExecutionContext =>
    ({
      getHandler: handler,
      getClass: cls,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  describe('@Public() override', () => {
    it('admits an anonymous caller when the handler is public', () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key: any) =>
          key === 'isPublic' ? (true as any) : ([Role.VENDOR, Role.ADMIN] as any),
        );

      expect(guard.canActivate(ctx(undefined))).toBe(true);
    });

    it('still admits a caller whose role matches', () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key: any) =>
          key === 'isPublic' ? (true as any) : ([Role.VENDOR, Role.ADMIN] as any),
        );

      expect(guard.canActivate(ctx({ role: Role.CUSTOMER }))).toBe(true);
    });
  });

  describe('boundary - non-public routes are unaffected', () => {
    it('throws AUTH_UNAUTHORIZED with no user on a vendor-only route', () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key: any) =>
          key === 'isPublic' ? (undefined as any) : ([Role.VENDOR, Role.ADMIN] as any),
        );

      expect(() => guard.canActivate(ctx(undefined))).toThrow(AppErrorCode.AUTH_UNAUTHORIZED);
    });

    it('throws AUTH_INSUFFICIENT_PERMISSIONS for a CUSTOMER on a vendor+admin route', () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key: any) =>
          key === 'isPublic' ? (undefined as any) : ([Role.VENDOR, Role.ADMIN] as any),
        );

      expect(() => guard.canActivate(ctx({ role: Role.CUSTOMER }))).toThrow(
        AppErrorCode.AUTH_INSUFFICIENT_PERMISSIONS,
      );
    });

    it('throws AUTH_VENDOR_ONLY when a route demands VENDOR alone', () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key: any) =>
          key === 'isPublic' ? (undefined as any) : ([Role.VENDOR] as any),
        );

      expect(() => guard.canActivate(ctx({ role: Role.CUSTOMER }))).toThrow(
        AppErrorCode.AUTH_VENDOR_ONLY,
      );
    });

    it('admits a VENDOR and an ADMIN on a vendor-only route', () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key: any) =>
          key === 'isPublic' ? (undefined as any) : ([Role.VENDOR, Role.ADMIN] as any),
        );

      expect(guard.canActivate(ctx({ role: Role.VENDOR }))).toBe(true);
      expect(guard.canActivate(ctx({ role: Role.ADMIN }))).toBe(true);
    });

    it('admits anyone when no roles are required at all', () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key: any) => (key === 'isPublic' ? (undefined as any) : (undefined as any)));

      expect(guard.canActivate(ctx(undefined))).toBe(true);
    });
  });

  describe('real metadata wiring', () => {
    /** Guards against the mocks above passing while the decorators themselves are mis-declared. */
    it('resolves @Public() and @Roles() through the actual reflector', () => {
      class VariantsController {
        @Public()
        publicMatrix() {}

        @Roles(Role.VENDOR, Role.ADMIN)
        matrix() {}
      }

      const h = (VariantsController.prototype.publicMatrix as any);
      const v = (VariantsController.prototype.matrix as any);
      const C = VariantsController as any;

      const real = new Reflector();
      const realGuard = new RolesGuard(real);

      const contextFor = (handlerFn: any): ExecutionContext =>
        ({
          getHandler: () => handlerFn,
          getClass: () => C,
          switchToHttp: () => ({ getRequest: () => ({ user: undefined }) }),
        }) as unknown as ExecutionContext;

      expect(realGuard.canActivate(contextFor(h))).toBe(true);
      expect(() => realGuard.canActivate(contextFor(v))).toThrow();
    });
  });
});