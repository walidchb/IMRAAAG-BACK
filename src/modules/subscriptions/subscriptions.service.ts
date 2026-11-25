import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import {
  SubscriptionEventAction,
  SubscriptionStatus,
  SubscriptionPlanSnapshot,
  addDays,
  daysRemainingUntil,
  isSubscriptionEntitled,
  resolveEffectiveSubscriptionStatus,
} from '../../common/constants/subscription.const';
import { openTransactionSession } from '../inventory/services/session.util';
import {
  PlanLimitsDto,
} from './dto/plan.dto';
import { PlansService, SubscriptionActor } from './plans.service';
import {
  Subscription,
  SubscriptionDocument,
} from './schemas/subscription.schema';
import {
  SubscriptionEvent,
  SubscriptionEventDocument,
} from './schemas/subscription-event.schema';
import { SubscriptionPlanDocument } from './schemas/subscription-plan.schema';

export interface VendorSubscriptionView {
  storeId: string;
  subscription: {
    status: SubscriptionStatus;
    effectiveStatus: SubscriptionStatus;
    isTrial: boolean;
    startDate: Date;
    endDate: Date | null;
    trialStartedAt: Date | null;
    trialEndsAt: Date | null;
    daysRemaining: number | null;
    plan: SubscriptionPlanSnapshot;
  } | null;
}

/** Null means unlimited. */
function parseDays(value: unknown, field: string): number {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1) {
    throw new AppException(AppErrorCode.SUBSCRIPTION_INVALID_DATES, { field });
  }
  return days;
}

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<SubscriptionDocument>,
    @InjectModel(SubscriptionEvent.name)
    private readonly eventModel: Model<SubscriptionEventDocument>,
    private readonly plansService: PlansService,
    private readonly configService: ConfigService,
  ) {}

  isEnforcementEnabled(): boolean {
    return this.configService.get<boolean>('subscriptions.enforcementEnabled') === true;
  }

  isEnabled(): boolean {
    return this.configService.get<boolean>('subscriptions.enabled') === true;
  }

  // ─── Reads ───

  async getForStore(
    storeId: string,
    session?: ClientSession,
  ): Promise<SubscriptionDocument | null> {
    if (!storeId || !Types.ObjectId.isValid(storeId)) return null;
    const query = this.subscriptionModel.findOne({ storeId: new Types.ObjectId(storeId) });
    if (session) query.session(session);
    return query.exec();
  }

  async requireForStore(storeId: string, session?: ClientSession): Promise<SubscriptionDocument> {
    const subscription = await this.getForStore(storeId, session);
    if (!subscription) throw new AppException(AppErrorCode.SUBSCRIPTION_NOT_FOUND, { storeId });
    return subscription;
  }

  resolveEffective(
    subscription: { status: SubscriptionStatus | string; isTrial?: boolean; endDate?: Date | null },
    now: Date = new Date(),
  ): SubscriptionStatus {
    return resolveEffectiveSubscriptionStatus(subscription, now);
  }

  isEntitled(subscription: SubscriptionDocument, now: Date = new Date()): boolean {
    return isSubscriptionEntitled(this.resolveEffective(subscription, now));
  }

  async getVendorView(storeId: string): Promise<VendorSubscriptionView> {
    const subscription = await this.getForStore(storeId);
    if (!subscription) {
      return { storeId, subscription: null };
    }
    const now = new Date();
    const effectiveStatus = this.resolveEffective(subscription, now);
    return {
      storeId,
      subscription: {
        status: subscription.status,
        effectiveStatus,
        isTrial: Boolean(subscription.isTrial),
        startDate: subscription.startDate,
        endDate: subscription.endDate ?? null,
        trialStartedAt: subscription.trialStartedAt ?? null,
        trialEndsAt: subscription.trialEndsAt ?? null,
        daysRemaining: daysRemainingUntil(subscription.endDate ?? null, now),
        plan: subscription.planSnapshot,
      },
    };
  }

  // ─── Lifecycle ───

  async assignPlan(
    storeId: string,
    planId: string,
    actor: SubscriptionActor,
    options: { replace?: boolean } = {},
  ): Promise<SubscriptionDocument> {
    this.assertStoreId(storeId);
    const plan = await this.plansService.getActiveById(planId);
    const current = await this.getForStore(storeId);
    this.assertReplaceable(current, options.replace);

    const snapshot = this.plansService.buildSnapshot(plan);
    const now = new Date();
    const endDate = addDays(now, snapshot.durationDays);

    return this.writeWithEvent(
      storeId,
      SubscriptionEventAction.ASSIGNED,
      actor,
      current,
      (session) =>
        this.upsertFromSnapshot(storeId, plan, snapshot, {
          status: SubscriptionStatus.ACTIVE,
          isTrial: false,
          startDate: now,
          endDate,
          trialStartedAt: null,
          trialEndsAt: null,
          trialUsedAt: current?.trialUsedAt ?? null,
          source: 'admin_assigned',
        }, actor, session),
      (created) => ({ status: created.status, startDate: created.startDate, endDate: created.endDate }),
    );
  }

  async grantTrial(
    storeId: string,
    planId: string,
    actor: SubscriptionActor,
    options: { replace?: boolean } = {},
  ): Promise<SubscriptionDocument> {
    this.assertStoreId(storeId);
    const plan = await this.plansService.getActiveById(planId);
    if (!plan.trial?.enabled || !plan.trial.days || plan.trial.days < 1) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_TRIAL_NOT_AVAILABLE, { planId });
    }
    const current = await this.getForStore(storeId);
    this.assertReplaceable(current, options.replace);
    if (current?.trialUsedAt) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_TRIAL_ALREADY_USED, { storeId });
    }

    const snapshot = this.plansService.buildSnapshot(plan);
    const now = new Date();
    const endDate = addDays(now, plan.trial.days);

    return this.writeWithEvent(
      storeId,
      SubscriptionEventAction.TRIAL_GRANTED,
      actor,
      current,
      (session) =>
        this.upsertFromSnapshot(storeId, plan, snapshot, {
          status: SubscriptionStatus.TRIALING,
          isTrial: true,
          startDate: now,
          endDate,
          trialStartedAt: now,
          trialEndsAt: endDate,
          trialUsedAt: now,
          source: 'admin_trial',
        }, actor, session),
      (created) => ({ status: created.status, startDate: created.startDate, endDate: created.endDate }),
    );
  }

  async changePlan(
    subscriptionId: string,
    planId: string,
    actor: SubscriptionActor,
    reason?: string,
  ): Promise<SubscriptionDocument> {
    const current = await this.requireById(subscriptionId);
    const plan = await this.plansService.getActiveById(planId);
    const snapshot = this.plansService.buildSnapshot(plan);
    const now = new Date();
    const endDate = addDays(now, snapshot.durationDays);

    return this.writeWithEvent(
      String(current.storeId),
      SubscriptionEventAction.PLAN_CHANGED,
      actor,
      current,
      (session) =>
        this.applyUpdate(
          current,
          {
            planId: plan._id,
            planSnapshot: snapshot,
            status: SubscriptionStatus.ACTIVE,
            isTrial: false,
            startDate: now,
            endDate,
            trialStartedAt: null,
            trialEndsAt: null,
            cancelledAt: null,
            cancelledByAdminId: null,
            cancelledByAdminEmail: null,
            cancelReason: null,
            'usage.ordersUsed': 0,
            source: 'admin_assigned',
            ...this.actorFields(actor),
          },
          session,
        ),
      undefined,
      reason,
    );
  }

  async extend(
    subscriptionId: string,
    days: number,
    actor: SubscriptionActor,
    reason?: string,
  ): Promise<SubscriptionDocument> {
    const current = await this.requireById(subscriptionId);
    if (current.status === SubscriptionStatus.CANCELLED) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_STATE_CONFLICT, {
        reason: 'cancelled_requires_reactivation',
      });
    }
    if (!current.endDate) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_INVALID_DATES, {
        reason: 'perpetual_cannot_extend',
      });
    }
    const validDays = parseDays(days, 'days');
    const now = new Date();
    const base =
      new Date(current.endDate).getTime() > now.getTime() ? new Date(current.endDate) : now;
    const newEnd = addDays(base, validDays);
    // A stored `expired`/past period revives as active (or trialing for a trial).
    const status =
      this.resolveEffective(current, now) === SubscriptionStatus.EXPIRED
        ? current.isTrial
          ? SubscriptionStatus.TRIALING
          : SubscriptionStatus.ACTIVE
        : current.status;

    return this.writeWithEvent(
      String(current.storeId),
      SubscriptionEventAction.EXTENDED,
      actor,
      current,
      (session) =>
        this.applyUpdate(
          current,
          {
            endDate: newEnd,
            ...(current.isTrial ? { trialEndsAt: newEnd } : {}),
            status,
            ...this.actorFields(actor),
          },
          session,
        ),
      undefined,
      reason,
      { days: validDays, endDate: newEnd },
    );
  }

  async cancel(
    subscriptionId: string,
    actor: SubscriptionActor,
    reason?: string,
  ): Promise<SubscriptionDocument> {
    const current = await this.requireById(subscriptionId);
    if (current.status === SubscriptionStatus.CANCELLED) {
      return current;
    }
    return this.writeWithEvent(
      String(current.storeId),
      SubscriptionEventAction.CANCELLED,
      actor,
      current,
      (session) =>
        this.applyUpdate(
          current,
          {
            status: SubscriptionStatus.CANCELLED,
            cancelledAt: new Date(),
            cancelledByAdminId: actor.id ?? null,
            cancelledByAdminEmail: actor.email ?? null,
            cancelReason: reason?.trim() || null,
            ...this.actorFields(actor),
          },
          session,
        ),
      undefined,
      reason,
    );
  }

  async reactivate(
    subscriptionId: string,
    actor: SubscriptionActor,
    options: { days?: number; reason?: string } = {},
  ): Promise<SubscriptionDocument> {
    const current = await this.requireById(subscriptionId);
    const now = new Date();
    const effective = this.resolveEffective(current, now);
    if (effective !== SubscriptionStatus.CANCELLED && effective !== SubscriptionStatus.EXPIRED) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_ALREADY_ACTIVE, {
        subscriptionId,
      });
    }
    const duration =
      options.days !== undefined
        ? parseDays(options.days, 'days')
        : current.planSnapshot?.durationDays ?? (null as unknown as number);
    if (!duration) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_INVALID_DATES, {
        field: 'durationDays',
      });
    }
    const endDate = addDays(now, duration);

    return this.writeWithEvent(
      String(current.storeId),
      SubscriptionEventAction.REACTIVATED,
      actor,
      current,
      (session) =>
        this.applyUpdate(
          current,
          {
            status: SubscriptionStatus.ACTIVE,
            isTrial: false,
            startDate: now,
            endDate,
            trialStartedAt: null,
            trialEndsAt: null,
            cancelledAt: null,
            cancelledByAdminId: null,
            cancelledByAdminEmail: null,
            cancelReason: null,
            'usage.ordersUsed': 0,
            ...this.actorFields(actor),
          },
          session,
        ),
      undefined,
      options.reason,
      { days: duration },
    );
  }

  /** Persist `expired` for a stored active/trialing period that has passed (sweep only). */
  async observeExpiry(
    subscription: SubscriptionDocument,
    now: Date = new Date(),
  ): Promise<boolean> {
    if (subscription.status === SubscriptionStatus.CANCELLED) return false;
    if (this.resolveEffective(subscription, now) !== SubscriptionStatus.EXPIRED) return false;
    if (subscription.status === SubscriptionStatus.EXPIRED) return false;

    await this.applyUpdate(subscription, { status: SubscriptionStatus.EXPIRED });
    await this.eventModel.create({
      storeId: subscription.storeId,
      subscriptionId: subscription._id,
      action: SubscriptionEventAction.EXPIRED_OBSERVED,
      from: { status: subscription.status, endDate: subscription.endDate },
      to: { status: SubscriptionStatus.EXPIRED, endDate: subscription.endDate },
      actorType: 'system',
    });
    return true;
  }

  // ─── Default signup assignment ───

  /**
   * Assign the configured default plan to a newly-created store when subscriptions are enabled.
   * With enforcement on and no default plan, this fails so the caller can roll the store back —
   * never leave an unusable store behind. With everything off, it is a no-op.
   */
  async assignDefaultSignupPlan(
    storeId: string,
    fallbackCode: string,
  ): Promise<void> {
    if (!this.isEnabled() && !this.isEnforcementEnabled()) return;

    let plan: SubscriptionPlanDocument | null = await this.plansService.getDefaultSignupPlan();
    if (!plan && fallbackCode) {
      plan = await this.plansService.findByCode(fallbackCode);
      if (plan && !plan.isActive) plan = null;
    }
    if (!plan) {
      if (this.isEnforcementEnabled()) {
        throw new AppException(AppErrorCode.SUBSCRIPTION_NOT_CONFIGURED, {
          reason: 'no_default_plan',
        });
      }
      return;
    }

    const snapshot = this.plansService.buildSnapshot(plan);
    const now = new Date();
    await this.subscriptionModel.create({
      storeId: new Types.ObjectId(storeId),
      planId: plan._id,
      planSnapshot: snapshot,
      status: SubscriptionStatus.ACTIVE,
      isTrial: false,
      startDate: now,
      endDate: addDays(now, snapshot.durationDays),
      usage: { ordersUsed: 0 },
      source: 'signup_default',
    });
    await this.eventModel.create({
      storeId: new Types.ObjectId(storeId),
      action: SubscriptionEventAction.ASSIGNED,
      to: {
        status: SubscriptionStatus.ACTIVE,
        startDate: now,
        endDate: addDays(now, snapshot.durationDays),
        planVersion: snapshot.planVersion,
        snapshotName: snapshot.name,
      },
      actorType: 'system',
      details: { source: 'signup_default' },
    });
  }

  // ─── Internals ───

  private assertStoreId(storeId: string): void {
    if (!storeId || !Types.ObjectId.isValid(storeId)) {
      throw new AppException(AppErrorCode.VALIDATION_INVALID_ID, { field: 'storeId' });
    }
  }

  private assertReplaceable(
    current: SubscriptionDocument | null,
    replace?: boolean,
  ): void {
    if (!current) return;
    const effective = this.resolveEffective(current);
    if (
      !replace &&
      (effective === SubscriptionStatus.ACTIVE || effective === SubscriptionStatus.TRIALING)
    ) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_ALREADY_ACTIVE, {
        subscriptionId: String(current._id),
      });
    }
  }

  private async requireById(id: string): Promise<SubscriptionDocument> {
    if (!id || !Types.ObjectId.isValid(id)) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_NOT_FOUND, { id });
    }
    const doc = await this.subscriptionModel.findById(id).exec();
    if (!doc) throw new AppException(AppErrorCode.SUBSCRIPTION_NOT_FOUND, { id });
    return doc;
  }

  private actorFields(actor: SubscriptionActor): Record<string, unknown> {
    return {
      lastUpdatedByAdminId: actor.id ?? null,
      lastUpdatedByAdminEmail: actor.email ?? null,
    };
  }

  private async upsertFromSnapshot(
    storeId: string,
    plan: SubscriptionPlanDocument,
    snapshot: SubscriptionPlanSnapshot,
    fields: {
      status: SubscriptionStatus;
      isTrial: boolean;
      startDate: Date;
      endDate: Date | null;
      trialStartedAt: Date | null;
      trialEndsAt: Date | null;
      trialUsedAt: Date | null;
      source: 'admin_assigned' | 'admin_trial';
    },
    actor: SubscriptionActor,
    session?: ClientSession,
  ): Promise<SubscriptionDocument> {
    const doc = await this.subscriptionModel
      .findOneAndUpdate(
        { storeId: new Types.ObjectId(storeId) },
        {
          $set: {
            planId: plan._id,
            planSnapshot: snapshot,
            status: fields.status,
            isTrial: fields.isTrial,
            startDate: fields.startDate,
            endDate: fields.endDate,
            trialStartedAt: fields.trialStartedAt,
            trialEndsAt: fields.trialEndsAt,
            trialUsedAt: fields.trialUsedAt,
            cancelledAt: null,
            cancelledByAdminId: null,
            cancelledByAdminEmail: null,
            cancelReason: null,
            'usage.ordersUsed': 0,
            source: fields.source,
            createdByAdminId: actor.id ?? null,
            createdByAdminEmail: actor.email ?? null,
            lastUpdatedByAdminId: actor.id ?? null,
            lastUpdatedByAdminEmail: actor.email ?? null,
          },
        },
        { upsert: true, new: true, session },
      )
      .exec();
    return doc as SubscriptionDocument;
  }

  /**
   * Optimistic-concurrency update: the filter carries the previously-read `updatedAt`, so a
   * concurrent admin write loses with `SUBSCRIPTION_STATE_CONFLICT` instead of silently
   * overwriting. `timestamps` advances `updatedAt` on success.
   */
  private async applyUpdate(
    current: SubscriptionDocument,
    set: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<SubscriptionDocument> {
    const updated = await this.subscriptionModel
      .findOneAndUpdate(
        { _id: current._id, updatedAt: (current as unknown as { updatedAt?: Date }).updatedAt },
        { $set: set },
        { new: true, session },
      )
      .exec();
    if (!updated) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_STATE_CONFLICT, {
        subscriptionId: String(current._id),
      });
    }
    return updated;
  }

  /**
   * Run a subscription write + its event in one transaction when MongoDB supports it, else
   * sequentially (subscription first, so a crash can only lose the audit event, never the
   * commercial state). A business error inside the transaction is never retried as a fallback.
   */
  private async writeWithEvent(
    storeId: string,
    action: SubscriptionEventAction,
    actor: SubscriptionActor,
    before: SubscriptionDocument | null,
    work: (session?: ClientSession) => Promise<SubscriptionDocument>,
    toSnapshot?: (doc: SubscriptionDocument) => Record<string, unknown>,
    reason?: string,
    details?: Record<string, unknown> | null,
  ): Promise<SubscriptionDocument> {
    this.logger.log(
      `[subscriptions] ${action} store=${storeId} actor=${actor.email ?? 'system'}`,
    );
    let session: ClientSession | null = null;
    try {
      session = await openTransactionSession(this.subscriptionModel, this.logger);
    } catch (err) {
      if (this.isTransactionsUnavailable(err)) {
        this.logger.warn(
          'MongoDB transactions unavailable; subscription + event written sequentially.',
        );
        session = null;
      } else {
        throw err;
      }
    }

    try {
      const run = async (activeSession?: ClientSession) => {
        const updated = await work(activeSession);
        const eventDoc = {
          storeId: new Types.ObjectId(storeId),
          subscriptionId: updated._id,
          action,
          from: before ? this.eventSnapshot(before) : null,
          to: toSnapshot
            ? { ...this.eventSnapshot(updated), ...toSnapshot(updated) }
            : this.eventSnapshot(updated),
          reason: reason?.trim() || null,
          actorType: 'admin' as const,
          adminId: actor.id ?? null,
          adminEmail: actor.email ?? null,
          details: details ?? null,
        };
        if (activeSession) {
          await this.eventModel.create([eventDoc], { session: activeSession });
        } else {
          await this.eventModel.create(eventDoc);
        }
        return updated;
      };

      if (!session) return await run(undefined);

      let result!: SubscriptionDocument;
      await session.withTransaction(async () => {
        result = await run(session as ClientSession);
      });
      return result;
    } finally {
      if (session) await session.endSession().catch(() => undefined);
    }
  }

  private eventSnapshot(doc: SubscriptionDocument): Record<string, unknown> {
    return {
      status: doc.status,
      startDate: doc.startDate,
      endDate: doc.endDate,
      planVersion: doc.planSnapshot?.planVersion ?? null,
      snapshotName: doc.planSnapshot?.name ?? null,
    };
  }

  private isTransactionsUnavailable(err: unknown): boolean {
    if (err instanceof AppException) {
      return (err.errorParams as Record<string, unknown>)?.reason === 'transactions_unavailable';
    }
    return false;
  }

  /** Kept for the Phase 3 entitlement resolver; exposed so plan limits stay a single shape. */
  limitsOf(snapshot: SubscriptionPlanSnapshot | undefined): PlanLimitsDto {
    return {
      maxOrders: snapshot?.limits?.maxOrders ?? null,
      maxProducts: snapshot?.limits?.maxProducts ?? null,
      maxTeamMembers: snapshot?.limits?.maxTeamMembers ?? null,
    };
  }
}

