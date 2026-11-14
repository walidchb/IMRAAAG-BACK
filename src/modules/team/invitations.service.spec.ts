import { Types } from 'mongoose';
import { InvitationsService } from './invitations.service';
import { StoreRole } from '../../common/constants/store-roles.enum';

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

function pendingDoc(overrides: Record<string, any> = {}) {
  return {
    _id: new Types.ObjectId(),
    storeId: new Types.ObjectId(),
    email: 'employee@example.com',
    role: StoreRole.ORDER_CONFIRMER,
    tokenHash: 'a'.repeat(64),
    status: 'pending',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    acceptedAt: undefined,
    acceptedByUserId: undefined,
    revokedAt: undefined,
    lastSentAt: new Date(),
    sendCount: 1,
    createdAt: new Date(),
    invitedBy: new Types.ObjectId(),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('InvitationsService', () => {
  const store: any = {
    _id: new Types.ObjectId(),
    vendorEmail: 'owner@store.test',
    vendorId: new Types.ObjectId(),
    storeName: 'Test Store',
  };

  let invitationModel: any;
  let memberModel: any;
  let userModel: any;
  let storesService: any;
  let emailService: any;
  let configService: any;
  let auditService: any;
  let service: InvitationsService;

  beforeEach(() => {
    invitationModel = {
      findOne: jest.fn(),
      find: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn(() => q({ modifiedCount: 1 })),
    };
    memberModel = { findOne: jest.fn() };
    userModel = { findOne: jest.fn() };
    storesService = { findOne: jest.fn().mockResolvedValue({ storeName: 'Test Store' }) };
    emailService = { sendTeamInvitationEmail: jest.fn().mockResolvedValue(true) };
    configService = {
      get: jest.fn((key: string) => {
        if (key === 'teamInvitation.expiryHours') return 48;
        if (key === 'teamInvitation.acceptUrl') return '';
        if (key === 'frontendUrl') return 'http://localhost:3001';
        return undefined;
      }),
    };
    auditService = { record: jest.fn() };

    service = new InvitationsService(
      invitationModel,
      memberModel,
      userModel,
      storesService,
      emailService,
      configService,
      auditService,
    );
  });

  const actor = { id: new Types.ObjectId().toHexString(), email: 'owner@store.test', fullName: 'Owner' };

  it('stores only a SHA-256 token hash and never returns the raw token', async () => {
    userModel.findOne.mockReturnValue(q(null));
    invitationModel.findOne.mockReturnValue(q(null));
    const created = pendingDoc();
    invitationModel.create.mockResolvedValue(created);

    const result = await service.create(store, actor, {
      email: 'Employee@Example.com',
      role: StoreRole.ORDER_CONFIRMER,
    });

    const payload = invitationModel.create.mock.calls[0][0];
    expect(payload.email).toBe('employee@example.com');
    expect(payload.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.token).toBeUndefined();
    expect(payload.rawToken).toBeUndefined();
    expect(payload.storeId).toBe(store._id);

    expect(result.emailDelivered).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/"token"/);

    const emailArgs = emailService.sendTeamInvitationEmail.mock.calls[0];
    expect(emailArgs[0]).toBe('employee@example.com');
    expect(emailArgs[1].acceptUrl).toContain('token=');
  });

  describe('accept link', () => {
    async function acceptUrlWith(config: {
      acceptUrl?: string;
      frontendUrl?: string;
      locale?: 'en' | 'fr' | 'ar';
    }) {
      configService.get.mockImplementation((key: string) => {
        if (key === 'teamInvitation.expiryHours') return 48;
        if (key === 'teamInvitation.acceptUrl') return config.acceptUrl ?? '';
        if (key === 'frontendUrl') return config.frontendUrl ?? 'http://localhost:3001';
        return undefined;
      });
      userModel.findOne.mockReturnValue(q(null));
      invitationModel.findOne.mockReturnValue(q(null));
      invitationModel.create.mockResolvedValue(pendingDoc());

      await service.create(store, actor, {
        email: 'employee@example.com',
        role: StoreRole.ORDER_CONFIRMER,
        locale: config.locale,
      });

      return emailService.sendTeamInvitationEmail.mock.calls[0][1].acceptUrl as string;
    }

    it('derives the link from FRONTEND_URL', async () => {
      const url = await acceptUrlWith({ frontendUrl: 'https://vendor.example.com/' });
      expect(url).toMatch(
        /^https:\/\/vendor\.example\.com\/en\/accept-invitation\?token=[0-9a-f]+$/,
      );
    });

    it('uses TEAM_ACCEPT_URL verbatim when it already carries a path', async () => {
      const url = await acceptUrlWith({ acceptUrl: 'https://shop.example.com/accept' });
      expect(url).toMatch(/^https:\/\/shop\.example\.com\/accept\?token=/);
    });

    it('appends the accept path when TEAM_ACCEPT_URL is only an origin', async () => {
      const url = await acceptUrlWith({ acceptUrl: 'https://shop.example.com/' });
      expect(url).toMatch(
        /^https:\/\/shop\.example\.com\/en\/accept-invitation\?token=/,
      );
    });

    it('uses the page locale for the derived link and the email copy', async () => {
      const url = await acceptUrlWith({
        frontendUrl: 'https://vendor.example.com',
        locale: 'fr',
      });
      expect(url).toMatch(
        /^https:\/\/vendor\.example\.com\/fr\/accept-invitation\?token=[0-9a-f]+$/,
      );
      expect(emailService.sendTeamInvitationEmail.mock.calls[0][1].locale).toBe('fr');
    });

    it('swaps the locale segment of a configured accept page', async () => {
      const url = await acceptUrlWith({
        acceptUrl: 'https://shop.example.com/en/accept-invitation',
        locale: 'ar',
      });
      expect(url).toMatch(
        /^https:\/\/shop\.example\.com\/ar\/accept-invitation\?token=/,
      );
    });
  });

  it('keeps the invitation and reports emailDelivered=false when mail fails', async () => {
    userModel.findOne.mockReturnValue(q(null));
    invitationModel.findOne.mockReturnValue(q(null));
    invitationModel.create.mockResolvedValue(pendingDoc());
    emailService.sendTeamInvitationEmail.mockResolvedValue(false);

    const result = await service.create(store, actor, {
      email: 'employee@example.com',
      role: StoreRole.ORDER_CONFIRMER,
    });

    expect(result.emailDelivered).toBe(false);
    expect(result.invitation.email).toBe('employee@example.com');
  });

  it('allows the Owner to invite a different email', async () => {
    // Regression: an earlier check compared the store's `vendorId` with the *actor's* id,
    // which is the Owner's own id and therefore rejected every invite the Owner sent.
    const ownerActor = { ...actor, id: String(store.vendorId) };
    userModel.findOne.mockReturnValue(q(null));
    invitationModel.findOne.mockReturnValue(q(null));
    invitationModel.create.mockResolvedValue(pendingDoc({ invitedBy: store.vendorId }));

    const result = await service.create(store, ownerActor, {
      email: 'employee@example.com',
      role: StoreRole.ORDER_CONFIRMER,
    });

    expect(result.emailDelivered).toBe(true);
    expect(invitationModel.create).toHaveBeenCalled();
  });

  it('refuses the Owner email', async () => {
    await expect(
      service.create(store, actor, { email: 'OWNER@store.test', role: StoreRole.PARTNER }),
    ).rejects.toMatchObject({ errorCode: 'TEAM_INVITATION_OWNER_EMAIL' });
    expect(invitationModel.create).not.toHaveBeenCalled();
  });

  it('refuses an email that already has an active membership in this store', async () => {
    userModel.findOne.mockReturnValue(q({ _id: new Types.ObjectId() }));
    memberModel.findOne.mockReturnValue(
      q({ userId: new Types.ObjectId(), storeId: store._id, status: 'active' }),
    );

    await expect(
      service.create(store, actor, { email: 'employee@example.com', role: StoreRole.PARTNER }),
    ).rejects.toMatchObject({ errorCode: 'TEAM_MEMBER_ALREADY_EXISTS' });
  });

  it('refuses an email that already has an active membership elsewhere (MVP)', async () => {
    userModel.findOne.mockReturnValue(q({ _id: new Types.ObjectId() }));
    memberModel.findOne.mockReturnValue(
      q({ userId: new Types.ObjectId(), storeId: new Types.ObjectId(), status: 'active' }),
    );

    await expect(
      service.create(store, actor, { email: 'employee@example.com', role: StoreRole.PARTNER }),
    ).rejects.toMatchObject({ errorCode: 'TEAM_USER_ALREADY_MEMBER' });
  });

  it('resend rotates the token, extends the expiry and increments sendCount', async () => {
    const doc = pendingDoc({ tokenHash: 'b'.repeat(64), sendCount: 1 });
    const oldHash = doc.tokenHash;
    const oldExpiry = doc.expiresAt;
    invitationModel.findOne.mockReturnValue(q(doc));

    const result = await service.resend(store, actor, String(doc._id));

    expect(doc.save).toHaveBeenCalled();
    expect(doc.tokenHash).not.toBe(oldHash);
    expect(doc.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.expiresAt.getTime()).toBeGreaterThan(oldExpiry.getTime());
    expect(doc.sendCount).toBe(2);
    expect(result.emailDelivered).toBe(true);
    expect(emailService.sendTeamInvitationEmail).toHaveBeenCalled();
  });

  it('resend sends the email in the supplied locale', async () => {
    const doc = pendingDoc();
    invitationModel.findOne.mockReturnValue(q(doc));

    await service.resend(store, actor, String(doc._id), 'fr');

    const emailArgs = emailService.sendTeamInvitationEmail.mock.calls[0][1];
    expect(emailArgs.locale).toBe('fr');
    expect(emailArgs.acceptUrl).toContain('/fr/accept-invitation?token=');
  });

  it('revoke refuses a non-pending invitation', async () => {
    invitationModel.findOne.mockReturnValue(q(pendingDoc({ status: 'accepted' })));

    await expect(
      service.revoke(store, actor, new Types.ObjectId().toHexString()),
    ).rejects.toMatchObject({ errorCode: 'TEAM_INVITATION_NOT_PENDING' });
  });

  it('validateToken reports expiry', async () => {
    invitationModel.findOne.mockReturnValue(
      q(pendingDoc({ expiresAt: new Date(Date.now() - 1000) })),
    );

    await expect(service.validateToken('raw-token')).rejects.toMatchObject({
      errorCode: 'TEAM_INVITATION_EXPIRED',
    });
  });

  it('claim refuses an email mismatch', async () => {
    invitationModel.findOne.mockReturnValue(q(pendingDoc()));

    await expect(
      service.claim('raw-token', 'someone-else@example.com'),
    ).rejects.toMatchObject({ errorCode: 'TEAM_INVITATION_EMAIL_MISMATCH' });
  });

  it('claim loses the atomic race and reports already accepted', async () => {
    invitationModel.findOne
      .mockReturnValueOnce(q(pendingDoc()))
      .mockReturnValueOnce(q(pendingDoc({ status: 'accepted' })));
    invitationModel.findOneAndUpdate.mockReturnValue(q(null));

    await expect(service.claim('raw-token', 'employee@example.com')).rejects.toMatchObject({
      errorCode: 'TEAM_INVITATION_ALREADY_ACCEPTED',
    });
  });

  it('claim returns the claimed invitation without ever exposing a raw token', async () => {
    const rawToken = 'c'.repeat(64);
    const claimed = pendingDoc({ status: 'accepted', acceptedAt: new Date() });
    invitationModel.findOne.mockReturnValue(q(pendingDoc()));
    invitationModel.findOneAndUpdate.mockReturnValue(q(claimed));

    const result = await service.claim(rawToken, 'employee@example.com');

    const filter = invitationModel.findOneAndUpdate.mock.calls[0][0];
    expect(String(filter._id)).toBeDefined();
    expect(filter.status).toBe('pending');
    expect(filter.expiresAt).toBeDefined();
    expect(result.invitation).toBe(claimed);
    expect(JSON.stringify(result)).not.toContain(rawToken);
  });
});
