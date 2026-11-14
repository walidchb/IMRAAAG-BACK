import { Types } from 'mongoose';
import { TeamService } from './team.service';
import { StoreRole, StoreMemberStatus } from '../../common/constants/store-roles.enum';
import { Role } from '../../common/constants/roles.enum';

function q<T>(result: T): any {
  const chain: any = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    lean: () => chain,
    exec: async () => result,
  };
  return chain;
}

describe('TeamService', () => {
  const storeId = new Types.ObjectId();
  const ownerUserId = new Types.ObjectId();
  const actorId = new Types.ObjectId().toHexString();

  const store: any = {
    _id: storeId,
    vendorId: ownerUserId,
    vendorEmail: 'owner@store.test',
  };
  const access: any = {
    store,
    storeId,
    storeRole: StoreRole.OWNER,
    isOwner: true,
    permissions: ['*'],
    memberId: null,
  };

  let memberModel: any;
  let userModel: any;
  let auditService: any;
  let storesService: any;
  let service: TeamService;

  function memberDoc(overrides: Record<string, any> = {}) {
    return {
      _id: new Types.ObjectId(),
      storeId,
      userId: new Types.ObjectId(),
      role: StoreRole.ORDER_CONFIRMER,
      status: StoreMemberStatus.ACTIVE,
      joinedAt: new Date(),
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  beforeEach(() => {
    memberModel = {
      find: jest.fn(() => q([])),
      findOne: jest.fn(),
      updateOne: jest.fn(() => q({ modifiedCount: 1 })),
      deleteOne: jest.fn(() => q({ deletedCount: 1 })),
    };
    userModel = {
      find: jest.fn(() => q([])),
      findById: jest.fn(() => q(null)),
      findByIdAndDelete: jest.fn(() => q({ _id: new Types.ObjectId() })),
      updateOne: jest.fn(() => q({ modifiedCount: 1 })),
    };
    auditService = { record: jest.fn() };
    storesService = { findByVendorId: jest.fn(async () => null) };
    service = new TeamService(memberModel, userModel, auditService, storesService);
  });

  it('lists the owner first even when no owner row exists (legacy)', async () => {
    memberModel.find.mockReturnValue(q([]));
    userModel.find.mockReturnValue(q([{ _id: ownerUserId, fullName: 'Owner', email: 'owner@store.test' }]));

    const members = await service.listMembers(access);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      userId: String(ownerUserId),
      role: StoreRole.OWNER,
      isOwner: true,
      status: StoreMemberStatus.ACTIVE,
    });
  });

  it('protects the Owner from any modification', async () => {
    memberModel.findOne.mockReturnValue(q(memberDoc({ role: StoreRole.OWNER, userId: ownerUserId })));

    await expect(
      service.updateMember(access, { id: actorId }, new Types.ObjectId().toHexString(), {
        role: StoreRole.CASHIER,
      }),
    ).rejects.toMatchObject({ errorCode: 'TEAM_OWNER_PROTECTED' });
  });

  it('refuses modifying yourself', async () => {
    memberModel.findOne.mockReturnValue(
      q(memberDoc({ userId: new Types.ObjectId(actorId), role: StoreRole.PARTNER })),
    );

    await expect(
      service.updateMember(access, { id: actorId }, new Types.ObjectId().toHexString(), {
        role: StoreRole.CASHIER,
      }),
    ).rejects.toMatchObject({ errorCode: 'TEAM_CANNOT_MODIFY_SELF' });
  });

  it('refuses assigning the OWNER role', async () => {
    memberModel.findOne.mockReturnValue(q(memberDoc()));

    await expect(
      service.updateMember(access, { id: actorId }, new Types.ObjectId().toHexString(), {
        role: StoreRole.OWNER,
      }),
    ).rejects.toMatchObject({ errorCode: 'TEAM_ROLE_INVALID' });
  });

  it('deactivation bumps tokenVersion and clears the refresh token', async () => {
    const member = memberDoc();
    memberModel.findOne.mockReturnValueOnce(q(member)).mockReturnValueOnce(q(member));
    userModel.findById.mockReturnValue(
      q({ _id: member.userId, fullName: 'Emp', email: 'emp@example.com', phoneNumber: null }),
    );

    const result = await service.updateMember(
      access,
      { id: actorId },
      String(member._id),
      { status: StoreMemberStatus.DEACTIVATED },
    );

    expect(memberModel.updateOne).toHaveBeenCalledWith(
      { _id: member._id },
      expect.objectContaining({
        $set: expect.objectContaining({ status: StoreMemberStatus.DEACTIVATED }),
      }),
    );
    expect(userModel.updateOne).toHaveBeenCalledWith(
      { _id: member.userId },
      expect.objectContaining({
        $inc: { tokenVersion: 1 },
        $set: { refreshToken: null, refreshTokenExpiresAt: null },
      }),
    );
    expect(result.userId).toBe(String(member.userId));
  });

  it('reactivation sets active and clears the deactivation fields', async () => {
    const member = memberDoc({ status: StoreMemberStatus.DEACTIVATED });
    memberModel.findOne.mockReturnValueOnce(q(member)).mockReturnValueOnce(
      q({ ...member, status: StoreMemberStatus.ACTIVE }),
    );

    await service.updateMember(access, { id: actorId }, String(member._id), {
      status: StoreMemberStatus.ACTIVE,
    });

    expect(memberModel.updateOne).toHaveBeenCalledWith(
      { _id: member._id, storeId },
      expect.objectContaining({
        $set: { status: StoreMemberStatus.ACTIVE },
        $unset: { deactivatedAt: 1, deactivatedBy: 1 },
      }),
    );
    expect(userModel.updateOne).not.toHaveBeenCalled();
  });

  it('removes a member and deletes the now-unshared employee account', async () => {
    const member = memberDoc();
    // First `findOne` is the scoped member; the second (after deletion) checks for others.
    memberModel.findOne.mockReturnValueOnce(q(member)).mockReturnValueOnce(q(null));
    userModel.findById.mockReturnValue(q({ _id: member.userId, role: Role.VENDOR }));

    await service.removeMember(access, { id: actorId }, String(member._id));

    expect(memberModel.deleteOne).toHaveBeenCalledWith({ _id: member._id, storeId });
    expect(storesService.findByVendorId).toHaveBeenCalledWith(String(member.userId));
    expect(userModel.findByIdAndDelete).toHaveBeenCalledWith(member.userId);
    expect(userModel.updateOne).not.toHaveBeenCalled();
  });

  it('keeps the account of a store Owner and only revokes their sessions', async () => {
    const member = memberDoc();
    memberModel.findOne.mockReturnValue(q(member));
    userModel.findById.mockReturnValue(q({ _id: member.userId, role: Role.VENDOR }));
    storesService.findByVendorId.mockResolvedValue({ _id: new Types.ObjectId() });

    await service.removeMember(access, { id: actorId }, String(member._id));

    expect(userModel.findByIdAndDelete).not.toHaveBeenCalled();
    expect(userModel.updateOne).toHaveBeenCalledWith(
      { _id: member.userId },
      expect.objectContaining({ $inc: { tokenVersion: 1 } }),
    );
  });

  it('keeps the account of a user who is still a member elsewhere', async () => {
    const member = memberDoc();
    memberModel.findOne
      .mockReturnValueOnce(q(member))
      .mockReturnValueOnce(q({ _id: new Types.ObjectId() }));
    userModel.findById.mockReturnValue(q({ _id: member.userId, role: Role.VENDOR }));

    await service.removeMember(access, { id: actorId }, String(member._id));

    expect(userModel.findByIdAndDelete).not.toHaveBeenCalled();
    expect(userModel.updateOne).toHaveBeenCalledWith(
      { _id: member.userId },
      expect.objectContaining({ $inc: { tokenVersion: 1 } }),
    );
  });

  it('keeps a non-vendor account (a customer who joined) and revokes its sessions', async () => {
    const member = memberDoc();
    memberModel.findOne.mockReturnValue(q(member));
    userModel.findById.mockReturnValue(q({ _id: member.userId, role: Role.CUSTOMER }));

    await service.removeMember(access, { id: actorId }, String(member._id));

    expect(userModel.findByIdAndDelete).not.toHaveBeenCalled();
    expect(userModel.updateOne).toHaveBeenCalledWith(
      { _id: member.userId },
      expect.objectContaining({ $inc: { tokenVersion: 1 } }),
    );
  });

  it('refuses removal of the Owner', async () => {
    memberModel.findOne.mockReturnValue(
      q(memberDoc({ role: StoreRole.OWNER, userId: ownerUserId })),
    );

    await expect(
      service.removeMember(access, { id: actorId }, new Types.ObjectId().toHexString()),
    ).rejects.toMatchObject({ errorCode: 'TEAM_OWNER_PROTECTED' });
  });
});
