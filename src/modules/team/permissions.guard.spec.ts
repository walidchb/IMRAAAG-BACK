import { PermissionsGuard } from './permissions.guard';

function context(user: any, request: any = { user }): any {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  };
}

describe('PermissionsGuard', () => {
  const user = { id: 'user-1', role: 'VENDOR' };

  function build(metadata: Record<string, any>, access?: any) {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => metadata[key]),
    };
    const storeAccessService = {
      resolveForUserOrThrow:
        access === undefined
          ? jest.fn()
          : jest.fn().mockResolvedValue(access),
      hasPermission: jest.fn(
        (a: any, p: string) =>
          Array.isArray(a?.permissions) &&
          (a.permissions.includes('*') || a.permissions.includes(p)),
      ),
    };
    return {
      guard: new PermissionsGuard(reflector as any, storeAccessService as any),
      storeAccessService,
    };
  }

  it('allows a @Public route without resolving access', async () => {
    const { guard, storeAccessService } = build({ isPublic: true, permissions: ['orders.view'] });
    await expect(guard.canActivate(context(user))).resolves.toBe(true);
    expect(storeAccessService.resolveForUserOrThrow).not.toHaveBeenCalled();
  });

  it('allows a route with no permission metadata (backward compatible)', async () => {
    const { guard } = build({});
    await expect(guard.canActivate(context(user))).resolves.toBe(true);
  });

  it('allows a platform ADMIN without resolving store access', async () => {
    const { guard, storeAccessService } = build(
      { permissions: ['team.manage_owner'] },
      undefined,
    );
    await expect(
      guard.canActivate(context({ id: 'admin-1', role: 'ADMIN' })),
    ).resolves.toBe(true);
    expect(storeAccessService.resolveForUserOrThrow).not.toHaveBeenCalled();
  });

  it('allows a wildcard permission', async () => {
    const { guard } = build({ permissions: ['orders.view'] }, { permissions: ['*'] });
    await expect(guard.canActivate(context(user))).resolves.toBe(true);
  });

  it('denies a missing permission with AUTH_INSUFFICIENT_PERMISSIONS', async () => {
    const { guard } = build({ permissions: ['orders.delete'] }, { permissions: ['orders.view'] });
    await expect(guard.canActivate(context(user))).rejects.toMatchObject({
      errorCode: 'AUTH_INSUFFICIENT_PERMISSIONS',
      errorParams: { permission: 'orders.delete' },
    });
  });

  it('requires all listed permissions (AND semantics)', async () => {
    const { guard } = build(
      { permissions: ['orders.view', 'orders.confirm'] },
      { permissions: ['orders.view'] },
    );
    await expect(guard.canActivate(context(user))).rejects.toMatchObject({
      errorCode: 'AUTH_INSUFFICIENT_PERMISSIONS',
      errorParams: { permission: 'orders.confirm' },
    });
  });

  it('memoises the resolved access on the request', async () => {
    const { guard, storeAccessService } = build(
      { permissions: ['orders.view'] },
      { permissions: ['orders.view'] },
    );
    const request: any = { user };

    await guard.canActivate(context(user, request));
    await guard.canActivate(context(user, request));

    expect(storeAccessService.resolveForUserOrThrow).toHaveBeenCalledTimes(1);
    expect(request.storeAccess).toBeDefined();
  });

  it('denies an unauthenticated caller when a permission is required', async () => {
    const { guard } = build({ permissions: ['orders.view'] }, { permissions: ['*'] });
    await expect(guard.canActivate(context(undefined))).rejects.toMatchObject({
      errorCode: 'AUTH_UNAUTHORIZED',
    });
  });
});
