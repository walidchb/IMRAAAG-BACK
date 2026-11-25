import {
  deriveStoreStatus,
  evaluateStoreAvailability,
} from './store-availability';
import {
  StoreAdminStatus,
  StoreOwnerStatus,
  StoreStatus,
} from './schemas/store-status.enum';

describe('store availability', () => {
  it.each([
    [StoreOwnerStatus.ENABLED, StoreAdminStatus.ACTIVE, true, null],
    [StoreOwnerStatus.DISABLED, StoreAdminStatus.ACTIVE, false, 'owner'],
    [StoreOwnerStatus.ENABLED, StoreAdminStatus.SUSPENDED, false, 'admin'],
    [StoreOwnerStatus.DISABLED, StoreAdminStatus.SUSPENDED, false, 'admin'],
  ])(
    'owner=%s admin=%s -> available=%s (%s)',
    (ownerStatus, adminStatus, available, blockedBy) => {
      expect(
        evaluateStoreAvailability({
          ownerStatus,
          adminStatus,
          status: deriveStoreStatus(ownerStatus, adminStatus),
        }),
      ).toMatchObject({ available, blockedBy });
    },
  );

  it('maps legacy statuses without disabling an active store', () => {
    expect(evaluateStoreAvailability({ status: StoreStatus.ACTIVE })).toMatchObject({
      ownerStatus: StoreOwnerStatus.ENABLED,
      adminStatus: StoreAdminStatus.ACTIVE,
      available: true,
    });
    expect(evaluateStoreAvailability({ status: StoreStatus.PAUSED })).toMatchObject({
      ownerStatus: StoreOwnerStatus.DISABLED,
      adminStatus: StoreAdminStatus.ACTIVE,
      available: false,
      blockedBy: 'owner',
    });
    expect(evaluateStoreAvailability({ status: StoreStatus.CLOSED })).toMatchObject({
      ownerStatus: StoreOwnerStatus.ENABLED,
      adminStatus: StoreAdminStatus.SUSPENDED,
      available: false,
      blockedBy: 'admin',
    });
  });
});
