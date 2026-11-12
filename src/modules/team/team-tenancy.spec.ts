import { Types } from 'mongoose';
import { TeamController } from './team.controller';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { StoreRole } from '../../common/constants/store-roles.enum';

describe('TeamController tenancy', () => {
  const storeA = new Types.ObjectId();
  const storeB = new Types.ObjectId();
  const ownerA = new Types.ObjectId();

  const accessA: any = {
    store: { _id: storeA, vendorId: ownerA, vendorEmail: 'a@store.test', storeName: 'A' },
    storeId: storeA,
    storeRole: StoreRole.OWNER,
    isOwner: true,
    permissions: ['*'],
    memberId: null,
  };

  let teamService: any;
  let invitationsService: any;
  let storeAccessService: any;
  let controller: TeamController;

  beforeEach(() => {
    teamService = {
      listMembers: jest.fn().mockResolvedValue([]),
      updateMember: jest.fn(),
      removeMember: jest.fn(),
    };
    invitationsService = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      resend: jest.fn(),
      revoke: jest.fn(),
    };
    storeAccessService = { resolveForUserOrThrow: jest.fn().mockResolvedValue(accessA) };
    controller = new TeamController(teamService, invitationsService, storeAccessService);
  });

  const req = (extra: Record<string, any> = {}) => ({
    user: { id: String(ownerA), email: 'a@store.test', role: 'VENDOR' },
    storeAccess: accessA,
    body: {},
    ...extra,
  });

  it('always uses the session store, never a body storeId', async () => {
    const dto: any = { email: 'new@example.com', role: StoreRole.PARTNER };
    const r = req({ body: { storeId: String(storeB) } });
    invitationsService.create.mockResolvedValue({ emailDelivered: true });

    await controller.invite(dto, r);

    expect(invitationsService.create).toHaveBeenCalledWith(accessA.store, r.user, dto);
    expect(invitationsService.create.mock.calls[0][0]._id).toBe(storeA);
  });

  it('propagates a cross-store 404 from the scoped service', async () => {
    invitationsService.resend.mockRejectedValue(
      new AppException(AppErrorCode.TEAM_INVITATION_NOT_FOUND, { id: 'foreign' }),
    );

    await expect(controller.resend('foreign', req())).rejects.toMatchObject({
      errorCode: 'TEAM_INVITATION_NOT_FOUND',
    });
    expect(invitationsService.resend).toHaveBeenCalledWith(
      accessA.store,
      expect.objectContaining({ id: String(ownerA) }),
      'foreign',
    );
  });

  it('refuses to operate when the resolved access has no store', async () => {
    const adminLike: any = { store: null, permissions: ['*'] };

    await expect(
      controller.invitations(req({ storeAccess: adminLike })),
    ).rejects.toMatchObject({ errorCode: 'STORE_NOT_FOUND' });
    expect(invitationsService.list).not.toHaveBeenCalled();
  });

  it('GET /team/me reports the session role and permissions', async () => {
    const result = await controller.me(req());
    expect(result).toEqual({
      storeId: String(storeA),
      storeRole: StoreRole.OWNER,
      isOwner: true,
      permissions: ['*'],
    });
  });
});
