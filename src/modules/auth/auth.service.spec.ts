import { Types } from 'mongoose';
import { AuthService } from './auth.service';
import { Role } from '../../common/constants/roles.enum';
import { StoreRole } from '../../common/constants/store-roles.enum';

function chain<T>(result: T): any {
  const c: any = {
    select: () => c,
    lean: () => c,
    exec: async () => result,
  };
  return c;
}

describe('AuthService — team integration', () => {
  const userId = new Types.ObjectId();
  const storeId = new Types.ObjectId();

  let userModel: any;
  let resetTokenModel: any;
  let otpModel: any;
  let jwtService: any;
  let configService: any;
  let emailService: any;
  let storesService: any;
  let storeAccessService: any;
  let invitationsService: any;
  let service: AuthService;

  const ownerAccess = {
    store: { _id: storeId },
    storeId,
    storeRole: StoreRole.OWNER,
    isOwner: true,
    permissions: ['*'],
    memberId: null,
  };

  const vendorUser = {
    _id: userId,
    fullName: 'Owner',
    email: 'owner@store.test',
    phoneNumber: '0550',
    role: Role.VENDOR,
    gender: null,
    address: null,
    savedProductIds: [],
    profileImage: null,
    tokenVersion: 0,
  };

  beforeEach(() => {
    userModel = {
      findOne: jest.fn(),
      findById: jest.fn(),
      findByIdAndDelete: jest.fn(() => chain(null)),
      create: jest.fn(),
      findByIdAndUpdate: jest.fn(),
    };
    resetTokenModel = {};
    otpModel = {};
    jwtService = { sign: jest.fn(() => 'jwt-token'), verify: jest.fn() };
    configService = { get: jest.fn() };
    emailService = { sendPasswordResetEmail: jest.fn() };
    storesService = { create: jest.fn() };
    storeAccessService = {
      resolveForUser: jest.fn().mockResolvedValue(ownerAccess),
      hasDeactivatedMembership: jest.fn().mockResolvedValue(false),
    };
    invitationsService = {
      validateToken: jest.fn(),
      claim: jest.fn(),
      join: jest.fn(),
      releaseClaim: jest.fn(),
      consume: jest.fn(),
    };

    service = new AuthService(
      userModel,
      resetTokenModel,
      otpModel,
      jwtService,
      configService,
      emailService,
      storesService,
      storeAccessService,
      invitationsService,
    );
  });

  it('issueSession includes storeId, storeRole, isOwner and permissions', async () => {
    const session = await service.issueSession(vendorUser);

    expect(session.user).toMatchObject({
      id: userId,
      storeId: String(storeId),
      storeRole: StoreRole.OWNER,
      isOwner: true,
      permissions: ['*'],
    });
    expect(session.token).toBe('jwt-token');
  });

  it('refuses a session when the vendor membership was deactivated', async () => {
    storeAccessService.resolveForUser.mockResolvedValue(null);
    storeAccessService.hasDeactivatedMembership.mockResolvedValue(true);

    await expect(service.issueSession(vendorUser)).rejects.toMatchObject({
      errorCode: 'AUTH_STORE_ACCESS_REVOKED',
    });
  });

  it('allows a legacy vendor with no store at all (no invented access)', async () => {
    storeAccessService.resolveForUser.mockResolvedValue(null);

    const session = await service.issueSession(vendorUser);
    expect(session.user.storeId).toBeNull();
    expect(session.user.permissions).toEqual([]);
  });

  it('creates the invitee account without a store and joins the store team', async () => {
    const created = {
      ...vendorUser,
      _id: new Types.ObjectId(),
      email: 'employee@example.com',
      fullName: 'Nadia',
      toObject() {
        return this;
      },
    };
    invitationsService.validateToken.mockResolvedValue({
      email: 'employee@example.com',
      requiresAccount: true,
    });
    userModel.findOne.mockReturnValue(chain(null));
    invitationsService.claim.mockResolvedValue({ invitation: {}, storeId: String(storeId) });
    userModel.create.mockResolvedValue(created);
    storeAccessService.resolveForUser.mockResolvedValue({
      ...ownerAccess,
      storeRole: StoreRole.ORDER_CONFIRMER,
      isOwner: false,
      permissions: ['orders.view'],
    });

    const session = await service.acceptInvitationNewAccount(
      { fullName: 'Nadia', password: 'password123', confirmPassword: 'password123' },
      'raw-token',
    );

    const createPayload = userModel.create.mock.calls[0][0];
    expect(createPayload.storeId).toBeUndefined();
    expect(createPayload.role).toBe(Role.VENDOR);
    expect(invitationsService.join).toHaveBeenCalledWith(
      expect.anything(),
      String(created._id),
      expect.objectContaining({ email: 'employee@example.com' }),
    );
    expect(session.user.storeRole).toBe(StoreRole.ORDER_CONFIRMER);
  });

  it('refuses new-account acceptance when the account already exists', async () => {
    invitationsService.validateToken.mockResolvedValue({
      email: 'employee@example.com',
      requiresAccount: false,
    });

    await expect(
      service.acceptInvitationNewAccount(
        { fullName: 'Nadia', password: 'password123', confirmPassword: 'password123' },
        'raw-token',
      ),
    ).rejects.toMatchObject({ errorCode: 'TEAM_ACCOUNT_EXISTS_USE_LOGIN' });
  });

  it('refuses acceptance when the signed-in email does not match the invitation', async () => {
    userModel.findById.mockResolvedValue(vendorUser);
    invitationsService.validateToken.mockResolvedValue({
      email: 'employee@example.com',
      requiresAccount: false,
    });

    await expect(
      service.acceptInvitationExisting({ id: String(userId) }, 'raw-token'),
    ).rejects.toMatchObject({ errorCode: 'TEAM_INVITATION_EMAIL_MISMATCH' });
  });

  it('upgrades a CUSTOMER accepting an invitation and issues a fresh session', async () => {
    const customer: any = { ...vendorUser, role: Role.CUSTOMER, save: jest.fn() };
    userModel.findById.mockResolvedValue(customer);
    invitationsService.validateToken.mockResolvedValue({
      email: customer.email,
      requiresAccount: false,
    });
    invitationsService.claim.mockResolvedValue({ invitation: {}, storeId: String(storeId) });
    invitationsService.join.mockResolvedValue(undefined);

    const session = await service.acceptInvitationExisting({ id: String(userId) }, 'raw-token');

    expect(customer.role).toBe(Role.VENDOR);
    expect(customer.save).toHaveBeenCalled();
    expect(session.user.storeId).toBe(String(storeId));
  });

  it('getMe returns the session payload with the current permissions', async () => {
    userModel.findById.mockResolvedValue(vendorUser);
    storeAccessService.resolveForUser.mockResolvedValue({
      ...ownerAccess,
      storeRole: StoreRole.INVENTORY_STAFF,
      isOwner: false,
      permissions: ['inventory.view'],
    });

    const me = await service.getMe(String(userId));
    expect(me.storeRole).toBe(StoreRole.INVENTORY_STAFF);
    expect(me.permissions).toEqual(['inventory.view']);
  });
});
