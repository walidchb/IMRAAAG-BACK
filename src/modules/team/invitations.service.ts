import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import * as crypto from 'crypto';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/constants/audit-action.enum';
import { ResourceType } from '../../common/constants/resource-type.enum';
import {
  ASSIGNABLE_STORE_ROLES,
  StoreInvitationStatus,
  StoreMemberStatus,
  StoreRole,
} from '../../common/constants/store-roles.enum';
import { User, UserDocument } from '../users/schemas/user.schema';
import { StoreDocument } from '../stores/schemas/store.schema';
import { StoresService } from '../stores/stores.service';
import { EmailService } from '../email/email.service';
import {
  StoreInvitation,
  StoreInvitationDocument,
} from './schemas/store-invitation.schema';
import { StoreMember, StoreMemberDocument } from './schemas/store-member.schema';
import { InviteEmployeeDto } from './dto/invite-employee.dto';
import {
  AppLocale,
  normalizeLocale,
  SUPPORTED_LOCALES,
} from '../../common/constants/locales.const';
import type { AccessUser } from './store-access.service';

export interface InvitationView {
  id: string;
  email: string;
  role: StoreRole;
  status: StoreInvitationStatus | 'expired';
  expiresAt: Date;
  createdAt: Date;
  lastSentAt: Date | null;
  sendCount: number;
}

export interface ClaimedInvitation {
  invitation: StoreInvitationDocument;
  storeId: string;
}

export interface InviterActor extends AccessUser {
  fullName?: string;
  email?: string;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeEmail(email: string): string {
  return (email || '').trim().toLowerCase();
}

function newRawToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Invitation lifecycle (implementation plan § 5).
 *
 * Security invariants enforced here:
 *  - the raw token exists only in the return value of the email send and the accept URL;
 *    only `sha256(rawToken)` is persisted, logged nowhere;
 *  - `pending && expiresAt < now` is "expired" logically, never a stored status;
 *  - create/resend rotates the same pending row;
 *  - revoke only transitions a pending invitation.
 */
@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    @InjectModel(StoreInvitation.name)
    private readonly invitationModel: Model<StoreInvitationDocument>,
    @InjectModel(StoreMember.name)
    private readonly memberModel: Model<StoreMemberDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly storesService: StoresService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
  ) {}

  async list(store: StoreDocument): Promise<InvitationView[]> {
    const rows = await this.invitationModel
      .find({ storeId: store._id })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean()
      .exec();
    return rows.map((row) => this.toView(row));
  }

  async create(
    store: StoreDocument,
    actor: InviterActor,
    dto: InviteEmployeeDto,
  ): Promise<{ invitation: InvitationView; emailDelivered: boolean }> {
    const email = normalizeEmail(dto.email);
    if (!ASSIGNABLE_STORE_ROLES.includes(dto.role)) {
      throw new AppException(AppErrorCode.TEAM_ROLE_INVALID, { role: dto.role });
    }

    if (email === normalizeEmail(store.vendorEmail)) {
      throw new AppException(AppErrorCode.TEAM_INVITATION_OWNER_EMAIL);
    }

    await this.assertEmailCanJoin(store, email);

    const { rawToken, expiresAt, invitation } = await this.rotateOrCreate(
      store,
      actor,
      email,
      dto.role,
    );

    const invitedByName = actor.fullName || actor.email || 'A store owner';
    const emailDelivered = await this.sendInvitationEmail(
      store,
      email,
      dto.role,
      invitedByName,
      rawToken,
      dto.locale,
    );

    this.auditService.record({
      action: AuditAction.TEAM_INVITATION_CREATED,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      storeId: String(store._id),
      resourceType: ResourceType.STORE,
      resourceId: String(store._id),
      details: { email, role: dto.role, expiresAt },
    });

    return { invitation: this.toView(invitation), emailDelivered };
  }

  async resend(
    store: StoreDocument,
    actor: InviterActor,
    invitationId: string,
    locale?: AppLocale,
  ): Promise<{ invitation: InvitationView; emailDelivered: boolean }> {
    const invitation = await this.findScoped(store, invitationId);
    if (invitation.status !== StoreInvitationStatus.PENDING) {
      throw new AppException(AppErrorCode.TEAM_INVITATION_NOT_PENDING, {
        status: invitation.status,
      });
    }

    const { rawToken, expiresAt } = this.rotateValues();
    invitation.tokenHash = sha256(rawToken);
    invitation.expiresAt = expiresAt;
    invitation.lastSentAt = new Date();
    invitation.sendCount = (invitation.sendCount ?? 0) + 1;
    await invitation.save();

    const invitedByName = actor.fullName || actor.email || 'A store owner';
    const emailDelivered = await this.sendInvitationEmail(
      store,
      invitation.email,
      invitation.role,
      invitedByName,
      rawToken,
      locale,
    );

    this.auditService.record({
      action: AuditAction.TEAM_INVITATION_RESENT,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      storeId: String(store._id),
      resourceType: ResourceType.STORE,
      resourceId: String(store._id),
      details: { email: invitation.email, role: invitation.role, expiresAt },
    });

    return { invitation: this.toView(invitation), emailDelivered };
  }

  async revoke(
    store: StoreDocument,
    actor: InviterActor,
    invitationId: string,
  ): Promise<InvitationView> {
    const invitation = await this.findScoped(store, invitationId);
    if (invitation.status !== StoreInvitationStatus.PENDING) {
      throw new AppException(AppErrorCode.TEAM_INVITATION_NOT_PENDING, {
        status: invitation.status,
      });
    }

    invitation.status = StoreInvitationStatus.REVOKED;
    invitation.revokedAt = new Date();
    invitation.revokedBy = this.toObjectId(actor.id);
    await invitation.save();

    this.auditService.record({
      action: AuditAction.TEAM_INVITATION_REVOKED,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      storeId: String(store._id),
      resourceType: ResourceType.STORE,
      resourceId: String(store._id),
      details: { email: invitation.email, role: invitation.role },
    });

    return this.toView(invitation);
  }

  /**
   * Public info for the accept page. Never reveals the token or any credential.
   */
  async validateToken(rawToken: string): Promise<{
    invitationId: string;
    storeName: string;
    email: string;
    role: StoreRole;
    expiresAt: Date;
    requiresAccount: boolean;
  }> {
    const invitation = await this.findByRawToken(rawToken);
    const now = new Date();
    this.assertPendingUsable(invitation, now);

    const store = await this.loadStore(String(invitation.storeId));
    const existingUser = await this.userModel
      .findOne({ email: invitation.email })
      .select('_id')
      .lean()
      .exec();

    return {
      invitationId: String(invitation._id),
      storeName: store?.storeName ?? '',
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      requiresAccount: !existingUser,
    };
  }

  /**
   * Atomically claims a pending, unexpired invitation. The caller then creates the user (new
   * account) and calls `join`, or calls `consume` for an existing account.
   */
  async claim(
    rawToken: string,
    accepterEmail: string,
    acceptedByUserId?: string,
  ): Promise<ClaimedInvitation> {
    const invitation = await this.findByRawToken(rawToken);
    const now = new Date();
    this.assertPendingUsable(invitation, now);

    if (normalizeEmail(accepterEmail) !== normalizeEmail(invitation.email)) {
      throw new AppException(AppErrorCode.TEAM_INVITATION_EMAIL_MISMATCH);
    }

    const claimed = await this.invitationModel
      .findOneAndUpdate(
        {
          _id: invitation._id,
          status: StoreInvitationStatus.PENDING,
          expiresAt: { $gt: now },
        },
        {
          $set: {
            status: StoreInvitationStatus.ACCEPTED,
            acceptedAt: now,
            ...(acceptedByUserId && Types.ObjectId.isValid(acceptedByUserId)
              ? { acceptedByUserId: new Types.ObjectId(acceptedByUserId) }
              : {}),
          },
        },
        { new: true },
      )
      .exec();

    if (!claimed) {
      // Lost the race, or it changed between the read and the claim. Re-read for the reason.
      const current = await this.findByRawToken(rawToken);
      this.assertPendingUsable(current, new Date());
      throw new AppException(AppErrorCode.TEAM_INVITATION_ALREADY_ACCEPTED);
    }

    return { invitation: claimed, storeId: String(claimed.storeId) };
  }

  /**
   * Creates the membership for a successfully claimed invitation. Idempotency is provided by
   * `claim`; the `(storeId, userId)` unique index is the final backstop.
   */
  async join(
    claimed: ClaimedInvitation,
    userId: string,
    actor?: InviterActor,
  ): Promise<ClaimedInvitation> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new AppException(AppErrorCode.USER_NOT_FOUND, { id: userId });
    }
    const userObjectId = new Types.ObjectId(userId);
    const { storeId } = claimed;

    const existing = await this.memberModel
      .findOne({ storeId: new Types.ObjectId(storeId), userId: userObjectId })
      .exec();
    if (existing) {
      await this.revertClaim(claimed);
      throw new AppException(AppErrorCode.TEAM_MEMBER_ALREADY_EXISTS, { userId });
    }

    try {
      await this.memberModel.create({
        storeId: new Types.ObjectId(storeId),
        userId: userObjectId,
        role: claimed.invitation.role,
        status: StoreMemberStatus.ACTIVE,
        invitedBy: claimed.invitation.invitedBy,
        joinedAt: new Date(),
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        await this.revertClaim(claimed);
        throw new AppException(AppErrorCode.TEAM_MEMBER_ALREADY_EXISTS, { userId });
      }
      throw err;
    }

    if (!claimed.invitation.acceptedByUserId) {
      claimed.invitation.acceptedByUserId = userObjectId;
      await claimed.invitation.save();
    }

    this.auditService.record({
      action: AuditAction.TEAM_MEMBER_JOINED,
      actorId: actor?.id ?? userId,
      actorEmail: actor?.email ?? null,
      storeId,
      resourceType: ResourceType.USER,
      resourceId: userId,
      details: { role: claimed.invitation.role, email: claimed.invitation.email },
    });
    this.auditService.record({
      action: AuditAction.TEAM_INVITATION_ACCEPTED,
      actorId: actor?.id ?? userId,
      actorEmail: actor?.email ?? claimed.invitation.email,
      storeId,
      resourceType: ResourceType.STORE,
      resourceId: storeId,
      details: { role: claimed.invitation.role, email: claimed.invitation.email },
    });

    return claimed;
  }

  /** Claim + join for an existing authenticated account. */
  async consume(user: InviterActor, rawToken: string): Promise<ClaimedInvitation> {
    const claimed = await this.claim(rawToken, user.email ?? '', user.id);
    try {
      return await this.join(claimed, user.id, user);
    } catch (err) {
      // `join` already reverted the claim on a duplicate membership; re-throw the reason.
      throw err;
    }
  }

  /**
   * Refuses an invitation for the Owner's email, an active member of this store, or (MVP) an
   * email that already has an active membership anywhere.
   */
  private async assertEmailCanJoin(store: StoreDocument, email: string): Promise<void> {
    const existingUser = await this.userModel
      .findOne({ email })
      .select('_id')
      .lean()
      .exec();

    if (!existingUser) return;

    if (store.vendorId && String(existingUser._id) === String(store.vendorId)) {
      throw new AppException(AppErrorCode.TEAM_INVITATION_OWNER_EMAIL);
    }

    const activeMembership = await this.memberModel
      .findOne({
        userId: existingUser._id,
        status: StoreMemberStatus.ACTIVE,
      })
      .lean()
      .exec();

    if (!activeMembership) return;

    if (String(activeMembership.storeId) === String(store._id)) {
      throw new AppException(AppErrorCode.TEAM_MEMBER_ALREADY_EXISTS, { email });
    }
    // MVP: one active membership per employee.
    throw new AppException(AppErrorCode.TEAM_USER_ALREADY_MEMBER, { email });
  }

  private async rotateOrCreate(
    store: StoreDocument,
    actor: InviterActor,
    email: string,
    role: StoreRole,
  ): Promise<{
    rawToken: string;
    expiresAt: Date;
    invitation: StoreInvitationDocument;
  }> {
    const { rawToken, expiresAt } = this.rotateValues();
    const tokenHash = sha256(rawToken);

    const pending = await this.invitationModel
      .findOne({
        storeId: store._id,
        email,
        status: StoreInvitationStatus.PENDING,
      })
      .exec();

    if (pending) {
      pending.role = role;
      pending.tokenHash = tokenHash;
      pending.expiresAt = expiresAt;
      pending.lastSentAt = new Date();
      pending.sendCount = (pending.sendCount ?? 0) + 1;
      await pending.save();
      return { rawToken, expiresAt, invitation: pending };
    }

    try {
      const created = await this.invitationModel.create({
        storeId: store._id,
        email,
        role,
        tokenHash,
        status: StoreInvitationStatus.PENDING,
        invitedBy: this.toObjectId(actor.id),
        expiresAt,
        lastSentAt: new Date(),
        sendCount: 1,
      });
      return { rawToken, expiresAt, invitation: created as StoreInvitationDocument };
    } catch (err: any) {
      if (err?.code === 11000) {
        // Concurrent create for the same (store, email): rotate the winner's row instead of
        // surfacing a duplicate-key error.
        const winner = await this.invitationModel
          .findOne({
            storeId: store._id,
            email,
            status: StoreInvitationStatus.PENDING,
          })
          .exec();
        if (winner) {
          winner.role = role;
          winner.tokenHash = tokenHash;
          winner.expiresAt = expiresAt;
          winner.lastSentAt = new Date();
          winner.sendCount = (winner.sendCount ?? 0) + 1;
          await winner.save();
          return { rawToken, expiresAt, invitation: winner };
        }
      }
      throw err;
    }
  }

  private rotateValues(): { rawToken: string; expiresAt: Date } {
    const hours = this.configService.get<number>('teamInvitation.expiryHours') ?? 48;
    return {
      rawToken: newRawToken(),
      expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000),
    };
  }

  private async sendInvitationEmail(
    store: StoreDocument,
    email: string,
    role: StoreRole,
    invitedByName: string,
    rawToken: string,
    locale?: string,
  ): Promise<boolean> {
    const hours = this.configService.get<number>('teamInvitation.expiryHours') ?? 48;
    const normalizedLocale = normalizeLocale(locale);
    const acceptUrl = this.buildAcceptUrl(rawToken, normalizedLocale);

    try {
      return await this.emailService.sendTeamInvitationEmail(email, {
        storeName: store.storeName,
        role,
        invitedByName,
        acceptUrl,
        expiresInHours: hours,
        locale: normalizedLocale,
      });
    } catch (err) {
      // Never log the URL/token. Delivery failure keeps the invitation row.
      this.logger.error(
        `Team invitation email failed for ${email}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Builds the emailed accept link in the language the invitation was sent in.
   *
   * `TEAM_ACCEPT_URL` wins when set. It may be the full accept page
   * (e.g. `https://vendor.example.com/en/accept-invitation`) or just the dashboard origin
   * (e.g. `https://vendor.example.com`), in which case the localized accept path is appended.
   * A full page whose first path segment is a supported locale has that segment replaced, so
   * the acceptance page always matches the email. Otherwise the link is derived from
   * `FRONTEND_URL` (the dashboard origin).
   */
  private buildAcceptUrl(rawToken: string, locale: AppLocale): string {
    const configured = (this.configService.get<string>('teamInvitation.acceptUrl') ?? '').trim();
    const frontendUrl = (
      this.configService.get<string>('frontendUrl') || 'http://localhost:3001'
    ).replace(/\/+$/, '');

    if (!configured) {
      return `${frontendUrl}/${locale}/accept-invitation?token=${rawToken}`;
    }

    const base = configured.replace(/\/+$/, '');
    const originOnly = /^https?:\/\/[^/?#]+$/i.test(base);
    const acceptPage = originOnly
      ? `${base}/${locale}/accept-invitation`
      : this.replaceLocaleSegment(base, locale);

    return `${acceptPage}${acceptPage.includes('?') ? '&' : '?'}token=${rawToken}`;
  }

  /** Swaps the leading locale segment of an absolute URL; leaves an unlocalized path intact. */
  private replaceLocaleSegment(url: string, locale: AppLocale): string {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (!segments.length || !(SUPPORTED_LOCALES as readonly string[]).includes(segments[0])) {
        return url;
      }
      segments[0] = locale;
      parsed.pathname = `/${segments.join('/')}`;
      return parsed.toString().replace(/\/+$/, '');
    } catch {
      return url;
    }
  }

  private async findByRawToken(rawToken: string): Promise<StoreInvitationDocument> {
    if (!rawToken) {
      throw new AppException(AppErrorCode.TEAM_INVITATION_NOT_FOUND);
    }
    const invitation = await this.invitationModel
      .findOne({ tokenHash: sha256(rawToken) })
      .exec();
    if (!invitation) {
      throw new AppException(AppErrorCode.TEAM_INVITATION_NOT_FOUND);
    }
    return invitation;
  }

  private assertPendingUsable(
    invitation: StoreInvitationDocument,
    now: Date,
  ): void {
    if (invitation.status === StoreInvitationStatus.ACCEPTED) {
      throw new AppException(AppErrorCode.TEAM_INVITATION_ALREADY_ACCEPTED);
    }
    if (invitation.status === StoreInvitationStatus.REVOKED) {
      throw new AppException(AppErrorCode.TEAM_INVITATION_REVOKED);
    }
    if (!(invitation.expiresAt instanceof Date) || invitation.expiresAt.getTime() <= now.getTime()) {
      throw new AppException(AppErrorCode.TEAM_INVITATION_EXPIRED);
    }
  }

  /** Reverts an accepted claim (used when a later step of the accept flow fails). */
  async releaseClaim(claimed: ClaimedInvitation): Promise<void> {
    await this.revertClaim(claimed);
  }

  private async revertClaim(claimed: ClaimedInvitation): Promise<void> {
    await this.invitationModel
      .updateOne(
        { _id: claimed.invitation._id, status: StoreInvitationStatus.ACCEPTED },
        {
          $set: { status: StoreInvitationStatus.PENDING },
          $unset: { acceptedAt: 1, acceptedByUserId: 1 },
        },
      )
      .exec()
      .catch(() => undefined);
  }

  private async findScoped(
    store: StoreDocument,
    invitationId: string,
  ): Promise<StoreInvitationDocument> {
    if (!Types.ObjectId.isValid(invitationId)) {
      throw new AppException(AppErrorCode.TEAM_INVITATION_NOT_FOUND, { id: invitationId });
    }
    const invitation = await this.invitationModel
      .findOne({ _id: new Types.ObjectId(invitationId), storeId: store._id })
      .exec();
    if (!invitation) {
      throw new AppException(AppErrorCode.TEAM_INVITATION_NOT_FOUND, { id: invitationId });
    }
    return invitation;
  }

  private async loadStore(storeId: string): Promise<{ storeName: string } | null> {
    try {
      const store = await this.storesService.findOne(storeId, { skipStatusCheck: true });
      return store ? { storeName: (store as any).storeName } : null;
    } catch {
      return null;
    }
  }

  private toView(row: any): InvitationView {
    const expired =
      row.status === StoreInvitationStatus.PENDING &&
      row.expiresAt instanceof Date &&
      row.expiresAt.getTime() <= Date.now();
    return {
      id: String(row._id),
      email: row.email,
      role: row.role,
      status: expired ? 'expired' : row.status,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      lastSentAt: row.lastSentAt ?? null,
      sendCount: row.sendCount ?? 0,
    };
  }

  private toObjectId(value?: string | null): Types.ObjectId | undefined {
    return value && Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : undefined;
  }
}
