import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
  addMonthsUtc,
  daysRemainingUntil,
  effectiveOrderAllowance,
  isSubscriptionEntitled,
  resolveEffectiveSubscriptionStatus,
} from '../../common/constants/subscription.const';
import { openTransactionSession } from '../inventory/services/session.util';
import {
  PlanLimitsDto,
} from './dto/plan.dto';
import { PlansService, SubscriptionActor, BillingOptionSnapshotInput } from './plans.service';
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
    inTrial: boolean;
    startDate: Date;
    endDate: Date | null;
    trialStartedAt: Date | null;
    trialEndsAt: Date | null;
    daysRemaining: number | null;
    trialDaysRemaining: number | null;
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
export class SubscriptionsService implements OnModuleInit {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<SubscriptionDocument>,
    @InjectModel(SubscriptionEvent.name)
    private readonly eventModel: Model<SubscriptionEventDocument>,
    private readonly plansService: PlansService,
    private readonly configService: ConfigService,
  ) {}

  /** Non-fatal rollout guard: a feature-gated deployment without a default cannot provision. */
  async onModuleInit(): Promise<void> {
    if (!this.isFeatureEnforcementEnabled()) return;
    try {
      const plan = await this.plansService.getDefaultSignupPlan();
      if (!plan) {
        this.logger.warn(
          '[subscriptions] Feature enforcement is on but no active signup default plan exists. ' +
            'New store creation will fail with SUBSCRIPTION_NOT_CONFIGURED until a default is seeded and activated.',
        );
      }
    } catch (err) {
      this.logger.warn(
        `[subscriptions] Could not verify the signup default plan at boot: ${String(
          (err as Error)?.message ?? err,
        )}`,
      );
    }
  }

  isEnforcementEnabled(): boolean {
    return this.configService.get<boolean>('subscriptions.enforcementEnabled') === true;
  }

  isEnabled(): boolean {
    return this.configService.get<boolean>('subscriptions.enabled') === true;
  }

  /** Broad rollout OR explicit feature flag (the broad switch always implies it). */
  isFeatureEnforcementEnabled(): boolean {
    return (
      this.isEnforcementEnabled() ||
      this.configService.get<boolean>('subscriptions.featureEnforcementEnabled') === true
    );
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
    subscription: {
      status: SubscriptionStatus | string;
      isTrial?: boolean;
      endDate?: Date | null;
      trialEndsAt?: Date | null;
    },
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
        inTrial: effectiveStatus === SubscriptionStatus.TRIALING,
        startDate: subscription.startDate,
        endDate: subscription.endDate ?? null,
        trialStartedAt: subscription.trialStartedAt ?? null,
        trialEndsAt: subscription.trialEndsAt ?? null,
        daysRemaining: daysRemainingUntil(subscription.endDate ?? null, now),
        trialDaysRemaining:
          effectiveStatus === SubscriptionStatus.TRIALING
            ? daysRemainingUntil(subscription.trialEndsAt ?? null, now)
            : null,
        plan: subscription.planSnapshot,
      },
    };
  }

  // ─── Lifecycle ───

  async assignPlan(
    storeId: string,
    planId: string,
    actor: SubscriptionActor,
    options: {
      replace?: boolean;
      durationMonths?: number;
      billingOptionId?: string;
      agreedPriceOverride?: number | null;
      includeTrial?: boolean;
      reason?: string;
    } = {},
  ): Promise<SubscriptionDocument> {
    this.assertStoreId(storeId);
    const plan = await this.plansService.getActiveById(planId);
    const current = await this.getForStore(storeId);
    this.assertReplaceable(current, options.replace);

    const option = await this.plansService.resolveBillingOption(plan, {
      durationMonths: options.durationMonths,
      billingOptionId: options.billingOptionId,
    });
    const snapshot = this.plansService.buildSnapshot(plan, option, {
      agreedPriceOverride: options.agreedPriceOverride,
    });
    const now = new Date();
    const trialDays = this.resolveIncludedTrialDays(plan, options.includeTrial);
    const trialEndsAt = trialDays !== null ? addDays(now, trialDays) : null;
    const paidStart = trialEndsAt ?? now;
    const endDate = this.periodEnd(paidStart, snapshot, option);

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
          trialStartedAt: trialEndsAt ? now : null,
          trialEndsAt,
          trialUsedAt: trialEndsAt ? now : current?.trialUsedAt ?? null,
          source: 'admin_assigned',
        }, actor, session),
      (created) => ({ status: created.status, startDate: created.startDate, endDate: created.endDate }),
      options.reason,
      { ...this.billingEventDetails(snapshot), trialDays, trialEndsAt },
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

    const snapshot = this.plansService.buildSnapshot(plan, null, { trial: true });
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
      undefined,
      this.billingEventDetails(snapshot),
    );
  }

  async changePlan(
    subscriptionId: string,
    planId: string,
    actor: SubscriptionActor,
    options: {
      durationMonths?: number;
      billingOptionId?: string;
      includeTrial?: boolean;
      reason?: string;
    } = {},
  ): Promise<SubscriptionDocument> {
    const current = await this.requireById(subscriptionId);
    const plan = await this.plansService.getActiveById(planId);
    const option = await this.plansService.resolveBillingOption(plan, {
      durationMonths: options.durationMonths,
      billingOptionId: options.billingOptionId,
    });
    const snapshot = this.plansService.buildSnapshot(plan, option);
    const now = new Date();
    const trialDays = this.resolveIncludedTrialDays(plan, options.includeTrial);
    const trialEndsAt = trialDays !== null ? addDays(now, trialDays) : null;
    const paidStart = trialEndsAt ?? now;
    const endDate = this.periodEnd(paidStart, snapshot, option);

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
            trialStartedAt: trialEndsAt ? now : null,
            trialEndsAt,
            ...(trialEndsAt ? { trialUsedAt: now } : {}),
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
      options.reason,
      { ...this.billingEventDetails(snapshot), trialDays, trialEndsAt },
    );
  }

  async extend(
    subscriptionId: string,
    options: { months?: number; days?: number },
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
    const months =
      options.months !== undefined && options.months !== null
        ? this.parseMonths(options.months)
        : undefined;
    const days =
      months === undefined && options.days !== undefined && options.days !== null
        ? parseDays(options.days, 'days')
        : undefined;
    if (months === undefined && days === undefined) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_INVALID_DATES, { field: 'months' });
    }

    const now = new Date();
    const base =
      new Date(current.endDate).getTime() > now.getTime() ? new Date(current.endDate) : now;
    const newEnd = months !== undefined ? addMonthsUtc(base, months) : addDays(base, days as number);
    // A trial that is still running keeps its position ahead of the paid period: extending the
    // subscription shifts the trial end by the same amount so the paid start moves with it.
    // (A pure trial is simply moved to the new end, matching the legacy behaviour.)
    const extensionMs = newEnd.getTime() - base.getTime();
    const currentTrialEnd = current.trialEndsAt ? new Date(current.trialEndsAt) : null;
    const combinedTrialStillActive =
      !current.isTrial && currentTrialEnd !== null && currentTrialEnd.getTime() > now.getTime();
    const newTrialEnd = current.isTrial
      ? newEnd
      : combinedTrialStillActive
        ? new Date(currentTrialEnd.getTime() + extensionMs)
        : currentTrialEnd;
    const { snapshot, addedAllowance, allowancePolicy } = this.extendSnapshotAllowance(
      current.planSnapshot,
      months,
      days,
    );
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
            ...(current.isTrial || combinedTrialStillActive ? { trialEndsAt: newTrialEnd } : {}),
            ...(snapshot ? { planSnapshot: snapshot } : {}),
            status,
            ...this.actorFields(actor),
          },
          session,
        ),
      undefined,
      reason,
      { months, days, endDate: newEnd, addedAllowance, allowancePolicy },
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
    options: {
      durationMonths?: number;
      billingOptionId?: string;
      sameTerms?: boolean;
      months?: number;
      days?: number;
      reason?: string;
    } = {},
  ): Promise<SubscriptionDocument> {
    const current = await this.requireById(subscriptionId);
    const now = new Date();
    const effective = this.resolveEffective(current, now);
    if (effective !== SubscriptionStatus.CANCELLED && effective !== SubscriptionStatus.EXPIRED) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_ALREADY_ACTIVE, {
        subscriptionId,
      });
    }

    const currentSnapshot = current.planSnapshot;
    const snapshotDurationMonths =
      currentSnapshot?.billing?.durationMonths ??
      currentSnapshot?.entitlements?.durationMonths ??
      null;
    const isMonthlySnapshot =
      currentSnapshot?.billing?.priceSource === 'calculated' ||
      currentSnapshot?.billing?.priceSource === 'override';
    const planId = current.planId ? String(current.planId) : null;
    const livePlan = planId ? await this.plansService.getDocumentById(planId) : null;
    // A pure trial has no paid billing record. It may be a monthly plan's trial
    // (`buildSnapshot(..., {trial:true})` stores `billing: null`, `durationMonths: null`) or a
    // legacy plan's trial. An *included* trial on a paid subscription is `isTrial: false`.
    const isPureTrial =
      current.isTrial === true ||
      (!currentSnapshot?.billing && livePlan?.billingMode === 'monthly');

    let snapshot: SubscriptionPlanSnapshot = currentSnapshot;
    let endDate: Date;

    if (options.sameTerms === true && !currentSnapshot?.billing) {
      // There are no paid terms to reuse: a blind reactivation would look paid but carry the
      // trial's 1× allowance with no billing record.
      throw new AppException(AppErrorCode.SUBSCRIPTION_STATE_CONFLICT, {
        reason: 'same_terms_requires_billing',
      });
    } else if (options.sameTerms === true && currentSnapshot.billing) {
      // Grandfathered deal: reuse the snapshot billing terms and its period length.
      endDate =
        snapshotDurationMonths !== null
          ? addMonthsUtc(now, snapshotDurationMonths)
          : addDays(now, options.days !== undefined ? parseDays(options.days, 'days') : currentSnapshot.durationDays);
    } else if (isPureTrial && livePlan?.billingMode === 'monthly') {
      // Converting a monthly trial requires an explicit paid term and produces a fresh paid
      // snapshot with its billing record and allowance.
      if (
        (options.durationMonths === undefined || options.durationMonths === null) &&
        !options.billingOptionId
      ) {
        throw new AppException(AppErrorCode.SUBSCRIPTION_BILLING_OPTION_REQUIRED, {
          subscriptionId,
          reason: 'trial_conversion_requires_paid_terms',
        });
      }
      if (!livePlan.isActive) {
        throw new AppException(AppErrorCode.SUBSCRIPTION_BILLING_OPTION_REQUIRED, {
          subscriptionId,
          reason: 'plan_inactive_or_missing',
        });
      }
      const option = await this.plansService.resolveBillingOption(livePlan, {
        durationMonths: options.durationMonths,
        billingOptionId: options.billingOptionId,
      });
      snapshot = this.plansService.buildSnapshot(livePlan, option);
      endDate = this.periodEnd(now, snapshot, option);
    } else if (isPureTrial) {
      // Legacy trial conversion: an explicit admin period is required and the historical
      // snapshot is preserved (legacy plans have no billing record by design).
      if (
        (options.months === undefined || options.months === null) &&
        (options.days === undefined || options.days === null)
      ) {
        throw new AppException(AppErrorCode.SUBSCRIPTION_INVALID_DATES, {
          field: 'months',
          reason: 'trial_conversion_requires_period',
        });
      }
      endDate =
        options.months !== undefined && options.months !== null
          ? addMonthsUtc(now, this.parseMonths(options.months))
          : addDays(now, parseDays(options.days, 'days'));
    } else if (isMonthlySnapshot) {
      const plan = livePlan ?? (planId ? await this.plansService.getDocumentById(planId) : null);
      if (!plan || !plan.isActive) {
        throw new AppException(AppErrorCode.SUBSCRIPTION_BILLING_OPTION_REQUIRED, {
          subscriptionId,
          reason: 'plan_inactive_or_missing',
        });
      }
      const option = await this.plansService.resolveBillingOption(plan, {
        durationMonths: options.durationMonths,
        billingOptionId: options.billingOptionId,
      });
      snapshot = this.plansService.buildSnapshot(plan, option);
      endDate = this.periodEnd(now, snapshot, option);
    } else {
      // Legacy plan: keep the snapshot; the period comes from days override or the snapshot.
      if (options.months !== undefined && options.months !== null) {
        endDate = addMonthsUtc(now, this.parseMonths(options.months));
      } else {
        const duration =
          options.days !== undefined && options.days !== null
            ? parseDays(options.days, 'days')
            : currentSnapshot?.durationDays;
        if (!duration) {
          throw new AppException(AppErrorCode.SUBSCRIPTION_INVALID_DATES, {
            field: 'durationDays',
          });
        }
        endDate = addDays(now, duration);
      }
    }

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
            planSnapshot: snapshot,
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
      {
        ...this.billingEventDetails(snapshot),
        ...(isPureTrial ? { convertedFromTrial: true } : {}),
      },
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
   * Assign the configured default plan to a newly-created store whenever subscription
   * enforcement is on. With enforcement on and no usable default plan, this fails so the caller
   * can roll the store back — never leave an unusable store behind. With all enforcement off it
   * is a no-op.
   *
   * The condition is the **feature** gate (broad OR explicit feature flag), not the broad switch
   * alone: otherwise the documented feature-only rollout creates stores with no subscription,
   * which every product/team/POS/order gate then refuses.
   */
  async assignDefaultSignupPlan(
    storeId: string,
    fallbackCode: string,
  ): Promise<void> {
    if (!this.isFeatureEnforcementEnabled()) return;

    let plan: SubscriptionPlanDocument | null = await this.plansService.getDefaultSignupPlan();
    if (!plan && fallbackCode) {
      plan = await this.plansService.findByCode(fallbackCode);
      if (plan && !plan.isActive) plan = null;
    }
    if (!plan) {
      if (this.isFeatureEnforcementEnabled()) {
        throw new AppException(AppErrorCode.SUBSCRIPTION_NOT_CONFIGURED, {
          reason: 'no_default_plan',
        });
      }
      return;
    }

    let option: BillingOptionSnapshotInput | null = null;
    if (plan.billingMode === 'monthly') {
      try {
        option = await this.plansService.resolveBillingOption(plan);
      } catch (err) {
        if (this.isFeatureEnforcementEnabled()) {
          throw new AppException(AppErrorCode.SUBSCRIPTION_NOT_CONFIGURED, {
            reason: 'no_default_billing_option',
          });
        }
        return;
      }
    }

    const snapshot = this.plansService.buildSnapshot(plan, option);
    const now = new Date();
    // A new store receives the plan's trial automatically when the plan offers one. The trial
    // runs first, then the paid period starts on the day the trial ends.
    const trialDays = this.includedTrialDaysForPlan(plan);
    const trialEndsAt = trialDays !== null ? addDays(now, trialDays) : null;
    const paidStart = trialEndsAt ?? now;
    const endDate = this.periodEnd(paidStart, snapshot, option);
    const effectiveStatus = resolveEffectiveSubscriptionStatus(
      { status: SubscriptionStatus.ACTIVE, isTrial: false, endDate, trialEndsAt },
      now,
    );
    await this.subscriptionModel.create({
      storeId: new Types.ObjectId(storeId),
      planId: plan._id,
      planSnapshot: snapshot,
      status: SubscriptionStatus.ACTIVE,
      isTrial: false,
      startDate: now,
      endDate,
      trialStartedAt: trialEndsAt ? now : null,
      trialEndsAt,
      trialUsedAt: trialEndsAt ? now : null,
      usage: { ordersUsed: 0 },
      source: 'signup_default',
    });
    await this.eventModel.create({
      storeId: new Types.ObjectId(storeId),
      action: SubscriptionEventAction.ASSIGNED,
      to: {
        status: SubscriptionStatus.ACTIVE,
        startDate: now,
        endDate,
        trialStartedAt: trialEndsAt ? now : null,
        trialEndsAt,
        planVersion: snapshot.planVersion,
        snapshotName: snapshot.name,
      },
      actorType: 'system',
      details: {
        source: 'signup_default',
        effectiveStatus,
        trialDays,
        trialEndsAt,
        ...this.billingEventDetails(snapshot),
      },
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

  private parseMonths(value: unknown): number {
    const months = Number(value);
    if (!Number.isInteger(months) || months < 1 || months > 36) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_INVALID_DATES, { field: 'months' });
    }
    return months;
  }

  /** Trial days configured on a plan, or `null` when the plan does not offer a trial. */
  private includedTrialDaysForPlan(plan: SubscriptionPlanDocument): number | null {
    const enabled = Boolean(plan.trial?.enabled);
    const days = Number(plan.trial?.days ?? 0);
    if (!enabled || !Number.isInteger(days) || days < 1) return null;
    return days;
  }

  /**
   * Trial days to prepend to a paid period. Explicitly requesting a trial on a plan that
   * cannot provide one is an error (never silently drop the admin's intent).
   */
  private resolveIncludedTrialDays(
    plan: SubscriptionPlanDocument,
    includeTrial?: boolean,
  ): number | null {
    if (!includeTrial) return null;
    const days = this.includedTrialDaysForPlan(plan);
    if (days === null) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_TRIAL_NOT_AVAILABLE, {
        planId: String(plan._id),
        reason: 'trial_disabled',
      });
    }
    return days;
  }

  /** Monthly purchases use calendar months; legacy/trial keep day arithmetic. */
  private periodEnd(
    start: Date,
    snapshot: SubscriptionPlanSnapshot,
    option: { durationMonths: number } | null,
  ): Date {
    if (option && Number.isInteger(option.durationMonths) && option.durationMonths > 0) {
      return addMonthsUtc(start, option.durationMonths);
    }
    return addDays(start, snapshot.durationDays);
  }

  private billingEventDetails(snapshot: SubscriptionPlanSnapshot): Record<string, unknown> {
    return {
      billingOptionId: snapshot.billing?.optionId ?? null,
      durationMonths: snapshot.billing?.durationMonths ?? null,
      durationDays: snapshot.billing?.durationDays ?? snapshot.durationDays ?? null,
      finalPrice: snapshot.billing?.finalPrice ?? snapshot.price ?? null,
      price: snapshot.billing?.finalPrice ?? snapshot.price ?? null,
      ordersAllowance: snapshot.entitlements?.ordersAllowance ?? null,
    };
  }

  /**
   * Add the extension's allowance to the subscription's authoritative total.
   *
   * Only a **paid monthly** snapshot has a monthly base that can be multiplied by the extension
   * length. A legacy snapshot's `limits.maxOrders` is a period total (not a monthly base), so
   * extending the period leaves its historical allowance untouched. The classifier reads the
   * snapshot's billing record — not `effectiveEntitlements().isLegacy`, which is already false
   * for a legacy row that a previous (buggy) extension gave a synthetic entitlements block.
   */
  private extendSnapshotAllowance(
    snapshot: SubscriptionPlanSnapshot | undefined,
    months?: number,
    days?: number,
  ): { snapshot: SubscriptionPlanSnapshot | null; addedAllowance: number | null; allowancePolicy: string } {
    if (!snapshot) {
      return { snapshot: null, addedAllowance: null, allowancePolicy: 'no_snapshot' };
    }
    const billing = snapshot.billing;
    const isMonthly =
      !!billing &&
      (billing.priceSource === 'calculated' || billing.priceSource === 'override') &&
      billing.durationMonths !== null;
    if (!isMonthly) {
      return {
        snapshot: null,
        addedAllowance: null,
        allowancePolicy: 'legacy_period_total_unchanged',
      };
    }
    const currentAllowance = effectiveOrderAllowance(snapshot);
    if (currentAllowance === null) {
      return { snapshot: null, addedAllowance: null, allowancePolicy: 'unlimited_unchanged' };
    }
    const delta = this.plansService.extensionAllowance(snapshot, { months, days });
    if (delta === null) {
      return { snapshot: null, addedAllowance: null, allowancePolicy: 'unlimited_unchanged' };
    }
    const monthlyOrders =
      snapshot.entitlements?.monthlyOrders ?? snapshot.limits?.maxOrders ?? null;
    if (monthlyOrders === null) {
      return {
        snapshot: null,
        addedAllowance: null,
        allowancePolicy: 'legacy_period_total_unchanged',
      };
    }

    return {
      snapshot: {
        ...snapshot,
        entitlements: {
          monthlyOrders,
          ordersAllowance: currentAllowance + delta,
          maxProducts: snapshot.entitlements?.maxProducts ?? snapshot.limits?.maxProducts ?? null,
          maxTeamMembers:
            snapshot.entitlements?.maxTeamMembers ?? snapshot.limits?.maxTeamMembers ?? null,
          features: snapshot.entitlements?.features ?? snapshot.features ?? { pos: false },
          durationMonths: snapshot.entitlements?.durationMonths ?? null,
        },
      },
      addedAllowance: delta,
      allowancePolicy: 'monthly_allowance_added',
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

