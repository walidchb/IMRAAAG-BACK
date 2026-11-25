import { JwtService } from '@nestjs/jwt';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AdminProtected } from './decorators/admin-protected.decorator';
import { AdminJwtAuthGuard } from './admin-auth/admin-jwt-auth.guard';
import { AdminOriginGuard } from './admin-auth/admin-origin.guard';
import { AdminAuthController } from './admin-auth/admin-auth.controller';
import { AdminAccountsController } from './admin-accounts/admin-accounts.controller';
import { AdminStoresController } from './admin-stores/admin-stores.controller';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';

const ADMIN_SECRET = 'admin-secret-for-test-only';
const SELLER_SECRET = 'seller-secret-for-test-only';

function methodNames(prototype: object): string[] {
  return Object.getOwnPropertyNames(prototype).filter((name) => name !== 'constructor');
}

describe('Admin/seller boundary', () => {
  it('a seller-signed token cannot be verified by the admin secret', () => {
    const seller = new JwtService({ secret: SELLER_SECRET });
    const admin = new JwtService({ secret: ADMIN_SECRET });
    const sellerToken = seller.sign({ sub: 'user-1', role: 'VENDOR', tokenVersion: 0 });
    expect(() => admin.verify(sellerToken)).toThrow();
  });

  it('an admin-signed token cannot be verified by the seller secret', () => {
    const seller = new JwtService({ secret: SELLER_SECRET });
    const admin = new JwtService({ secret: ADMIN_SECRET });
    const adminToken = admin.sign(
      { sub: 'admin-1', typ: 'admin' },
      { issuer: 'imraaah-admin', audience: 'imraaah-admin' },
    );
    expect(() => seller.verify(adminToken)).toThrow();
  });

  it('rejects an admin-secret token whose issuer/audience is wrong', () => {
    const admin = new JwtService({ secret: ADMIN_SECRET });
    const token = admin.sign({ sub: 'admin-1', typ: 'admin' }, { audience: 'somewhere-else' });
    expect(() =>
      admin.verify(token, { issuer: 'imraaah-admin', audience: 'imraaah-admin' }),
    ).toThrow();
  });

  it('AdminProtected marks the route public for sellers and adds both admin guards', () => {
    class Probe {}
    (AdminProtected() as ClassDecorator)(Probe);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, Probe)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, Probe)).toEqual([
      AdminJwtAuthGuard,
      AdminOriginGuard,
    ]);
  });

  it('no public registration/signup route exists on either admin controller', () => {
    for (const controller of [AdminAuthController, AdminAccountsController]) {
      const names = methodNames(controller.prototype);
      expect(names.some((name) => /register|signup/i.test(name))).toBe(false);
      for (const name of names) {
        const path = Reflect.getMetadata(PATH_METADATA, controller.prototype[name]);
        expect(String(path ?? '')).not.toMatch(/register|signup/i);
      }
    }
  });

  it('admin stores controller is admin-protected and exposes exactly the four intended paths', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminStoresController)).toBe('admin/stores');
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AdminStoresController)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminStoresController)).toEqual([
      AdminJwtAuthGuard,
      AdminOriginGuard,
    ]);

    const names = methodNames(AdminStoresController.prototype);
    expect(names.some((name) => /register|signup/i.test(name))).toBe(false);
    expect(names).toHaveLength(4);

    const paths = names.map((name) =>
      String(
        Reflect.getMetadata(
          PATH_METADATA,
          AdminStoresController.prototype[name as keyof AdminStoresController],
        ) ?? '',
      ),
    );
    expect(paths).toEqual(expect.arrayContaining(['wilayas', ':id', ':id/status']));
  });

  it('admin accounts expose exactly one delete route, on the account id', () => {
    const deleteRoutes = methodNames(AdminAccountsController.prototype).filter(
      (name) =>
        Reflect.getMetadata(METHOD_METADATA, AdminAccountsController.prototype[name]) ===
        RequestMethod.DELETE,
    );
    expect(deleteRoutes).toHaveLength(1);
    expect(
      Reflect.getMetadata(PATH_METADATA, AdminAccountsController.prototype[deleteRoutes[0]]),
    ).toBe(':id');
  });
});
