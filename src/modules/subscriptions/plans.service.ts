import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import type { AppErrorCodeType } from '../../common/errors/error-codes.enum';
import {
  SubscriptionEventAction,
  SubscriptionFeatures,
  SubscriptionLimits,
  SubscriptionPlanSnapshot,
  SubscriptionStatus,
  SubscriptionTrialConfig,
  type SupportedBillingDuration,
  SUPPORTED_BILLING_DURATIONS,
  isSupportedBillingDuration,
  resolveEffectiveSubscriptionStatus,
} from '../../common/constants/subscription.const';
import {
  PlanBillingOption,
  SubscriptionPlan,
  SubscriptionPlanDocument,
} from './schemas/subscription-plan.schema';
import {
  SubscriptionEvent,
  SubscriptionEventDocument,
} from './schemas/subscription-event.schema';
import { Subscription, SubscriptionDocument } from './schemas/subscription.schema';
import {
  CreatePlanDto,
  PlanQueryDto,
  UpdatePlanDto,
} from './dto/plan.dto';
import { allowanceForExtension, computeBillingOption, computeOrdersAllowance } from './subscription-billing';
import { SubscriptionBillingConfigService } from './subscription-billing-config.service';
import { openTransactionSession } from '../inventory/services/session.util';

export interface SubscriptionActor {
  id?: string | null;
  email?: string | null;
}

export interface PlanStoreCounts {
  storeCount: number;
  activeStoreCount: number;
}

export interface PlanListResult {
  items: Array<Record<string, unknown>>;
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Structural input accepted by `buildSnapshot` for a selected billing duration. */
export interface BillingOptionSnapshotInput {
  _id?: unknown;
  durationMonths: number;
  discountPercent: number;
}

/** How a caller selects a monthly duration for a new purchase. */
export interface BillingSelection {
  durationMonths?: number | null;
  billingOptionId?: string | null;
}

const DEFAULT_LIMITS: SubscriptionLimits = {
  maxOrders: null,
  maxProducts: null,
  maxTeamMembers: null,
};
const DEFAULT_FEATURES: SubscriptionFeatures = { pos: false };
const DEFAULT_TRIAL: SubscriptionTrialConfig = { enabled: false, days: null };

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeNameKey(name: string): string {
  return name.trim().toLowerCase();
}

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    @InjectModel(SubscriptionPlan.name)
    private readonly planModel: Model<SubscriptionPlanDocument>,
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<SubscriptionDocument>,
    @InjectModel(SubscriptionEvent.name)
    private readonly eventModel: Model<SubscriptionEventDocument>,
    private readonly billingConfig: SubscriptionBillingConfigService,
  ) {}

  // ─── Reads ───

  async list(query: PlanQueryDto): Promise<PlanListResult> {
    const filter: Record<string, unknown> = {};
    if (query.status === 'active') filter.isActive = true;
    if (query.status === 'inactive') filter.isActive = false;

    const term = query.search?.trim();
    if (term) {
      const regex = new RegExp(escapeRegex(term), 'i');
      filter.$or = [
        { name: regex },
        { description: regex },
        { descriptionEn: regex },
        { descriptionFr: regex },
        { descriptionAr: regex },
      ];
    }

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const sortField =
      query.sort === 'name' ? 'name' : query.sort === 'price' ? 'price' : 'createdAt';
    const sortOrder: 1 | -1 = query.order === 'asc' ? 1 : -1;

    const [docs, total] = await Promise.all([
      this.planModel
        .find(filter)
        .sort({ [sortField]: sortOrder, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.planModel.countDocuments(filter).exec(),
    ]);

    const counts = await this.storeCountsFor(docs.map((d) => d._id as Types.ObjectId));
    const enabledDurations = await this.billingConfig.getEnabledDurations();
    const items = docs.map((doc) =>
      this.toPlanResponse(doc, counts.get(String(doc._id)), enabledDurations),
    );

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async get(id: string): Promise<Record<string, unknown>> {
    this.assertValidId(id, AppErrorCode.SUBSCRIPTION_PLAN_NOT_FOUND);
    const plan = await this.planModel.findById(id).lean().exec();
    if (!plan) throw new AppException(AppErrorCode.SUBSCRIPTION_PLAN_NOT_FOUND, { id });
    const counts = await this.storeCountsFor([plan._id as Types.ObjectId]);
    const enabledDurations = await this.billingConfig.getEnabledDurations();
    return {
      plan: this.toPlanResponse(plan, counts.get(String(plan._id)), enabledDurations),
      subscribers: await this.subscriberSummary(plan._id as Types.ObjectId),
    };
  }

  /** All active plans for assignment pickers (admin describes the store's current plan too). */
  async listActive(): Promise<Record<string, unknown>[]> {
    const docs = await this.planModel
      .find({ isActive: true })
      .sort({ price: 1, name: 1 })
      .lean()
      .exec();
    const enabledDurations = await this.billingConfig.getEnabledDurations();
    return docs.map((doc) => this.toPlanResponse(doc, undefined, enabledDurations));
  }

  /**
   * Public catalogue for the storefront pricing page. Includes inactive plans (flagged with
   * `isActive: false` so the UI can dim them) and only the commercial fields a visitor may
   * see — no subscriber counts or admin actor metadata. Active plans sort first.
   */
  async listPublic(): Promise<Record<string, unknown>[]> {
    const docs = await this.planModel
      .find({})
      .sort({ isActive: -1, price: 1, name: 1 })
      .lean()
      .exec();
    const enabledDurations = await this.billingConfig.getEnabledDurations();

    return docs.map((doc) => ({
      id: String(doc._id),
      name: doc.name,
      description: doc.description ?? null,
      descriptionEn: doc.descriptionEn ?? null,
      descriptionFr: doc.descriptionFr ?? null,
      descriptionAr: doc.descriptionAr ?? null,
      image: doc.image ?? null,
      price: doc.price,
      currency: doc.currency,
      durationDays: doc.durationDays,
      billingMode: doc.billingMode ?? 'legacy',
      billingOptions: this.computeBillingOptionRows(doc, enabledDurations).filter(
        (option) => option.isEnabled,
      ),
      isActive: Boolean(doc.isActive),
      isDefaultForSignup: Boolean(doc.isDefaultForSignup),
      limits: {
        maxOrders: doc.limits?.maxOrders ?? null,
        maxProducts: doc.limits?.maxProducts ?? null,
        maxTeamMembers: doc.limits?.maxTeamMembers ?? null,
      },
      features: { pos: Boolean(doc.features?.pos) },
      trial: {
        enabled: Boolean(doc.trial?.enabled),
        days: doc.trial?.enabled ? (doc.trial.days ?? null) : null,
      },
    }));
  }

  async getActiveById(id: string): Promise<SubscriptionPlanDocument> {
    this.assertValidId(id, AppErrorCode.SUBSCRIPTION_PLAN_NOT_FOUND);
    const plan = await this.planModel.findById(id).exec();
    if (!plan) throw new AppException(AppErrorCode.SUBSCRIPTION_PLAN_NOT_FOUND, { id });
    if (!plan.isActive) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_PLAN_INACTIVE, { id });
    }
    return plan;
  }

  /** Internal document lookup (active or not) for lifecycle callers that validate state themselves. */
  async getDocumentById(id: string): Promise<SubscriptionPlanDocument | null> {
    if (!id || !Types.ObjectId.isValid(id)) return null;
    return this.planModel.findById(id).exec();
  }

  /** Resolve the single active default signup plan (used at store creation). */
  async getDefaultSignupPlan(): Promise<SubscriptionPlanDocument | null> {
    return this.planModel
      .findOne({ isActive: true, isDefaultForSignup: true })
      .exec();
  }

  async findByCode(code: string): Promise<SubscriptionPlanDocument | null> {
    if (!code) return null;
    return this.planModel.findOne({ code }).exec();
  }

  /**
   * Immutable commercial snapshot used by subscription assignment (§7.2).
   *
   * - **Legacy plan / no option**: only the pre-billing fields are written, so existing
   *   snapshots stay byte-for-byte identical and the resolver falls back to `limits` at 1×.
   * - **Monthly plan + option**: adds the `billing` purchase record and cumulative
   *   `entitlements`. Concurrent limits and features are copied, never multiplied.
   * - **Trial**: `billing = null` and a 1× auditable `entitlements` block.
   */
  buildSnapshot(
    plan: SubscriptionPlanDocument,
    option?: BillingOptionSnapshotInput | null,
    overrides: { trial?: boolean; agreedPriceOverride?: number | null } = {},
  ): SubscriptionPlanSnapshot {
    // `plan` is a Mongoose document: `limits`/`features`/`trial` are single-nested subdocuments
    // whose fields are prototype getters. `{ ...subdoc }` would copy only the *defaults* (and
    // internal keys), silently turning a real `maxOrders` into `null` and yielding an
    // `ordersAllowance` of `null` (the 1× fallback bug). Always read them through the helper.
    const limits: SubscriptionLimits = this.readLimits(plan.limits);
    const features: SubscriptionFeatures = this.readFeatures(plan.features);
    const snapshot: SubscriptionPlanSnapshot = {
      planVersion: plan.version,
      name: plan.name,
      description: plan.description,
      descriptionEn: plan.descriptionEn,
      descriptionFr: plan.descriptionFr,
      descriptionAr: plan.descriptionAr,
      price: plan.price,
      currency: 'DZD',
      durationDays: plan.durationDays,
      limits,
      features,
      trial: this.readTrial(plan.trial),
    };

    if (overrides.trial) {
      snapshot.billing = null;
      snapshot.entitlements = {
        monthlyOrders: limits.maxOrders,
        ordersAllowance: limits.maxOrders,
        maxProducts: limits.maxProducts,
        maxTeamMembers: limits.maxTeamMembers,
        features,
        durationMonths: null,
      };
      return snapshot;
    }

    if (plan.billingMode === 'monthly' && option) {
      const computation = computeBillingOption(plan.price, option);
      let finalPrice = computation.finalPrice;
      let priceSource: 'calculated' | 'override' = computation.priceSource;
      let priceOverride: number | null = null;

      if (overrides.agreedPriceOverride !== undefined && overrides.agreedPriceOverride !== null) {
        const agreed = Math.round(Number(overrides.agreedPriceOverride));
        if (!Number.isInteger(agreed) || agreed < 0 || agreed > computation.listPrice) {
          throw new AppException(AppErrorCode.SUBSCRIPTION_BILLING_INVALID_PRICE_OVERRIDE, {
            priceOverride: overrides.agreedPriceOverride,
            listPrice: computation.listPrice,
          });
        }
        finalPrice = agreed;
        priceOverride = agreed;
        priceSource = 'override';
      }

      const savings = computation.listPrice - finalPrice;
      snapshot.durationDays = option.durationMonths * 30;
      snapshot.billing = {
        optionId: option._id ? String(option._id) : null,
        optionLabel: null,
        durationMonths: option.durationMonths,
        durationDays: option.durationMonths * 30,
        monthlyBasePrice: plan.price,
        listPrice: computation.listPrice,
        discountPercent: option.discountPercent,
        priceOverride,
        finalPrice,
        savings,
        priceSource,
        currency: 'DZD',
      };
      snapshot.entitlements = {
        monthlyOrders: limits.maxOrders,
        ordersAllowance: computeOrdersAllowance(limits.maxOrders, option.durationMonths),
        maxProducts: limits.maxProducts,
        maxTeamMembers: limits.maxTeamMembers,
        features,
        durationMonths: option.durationMonths,
      };
    }

    return snapshot;
  }

  /**
   * Resolve the duration a monthly plan is being purchased at. Selection may be an explicit
   * `durationMonths` (preferred) or a legacy `billingOptionId`. The duration must exist on the
   * plan **and** be globally enabled. With no selection, the mandatory 1-month term is used.
   */
  async resolveBillingOption(
    plan: SubscriptionPlanDocument,
    selection: BillingSelection = {},
  ): Promise<PlanBillingOption | null> {
    if (plan.billingMode !== 'monthly') {
      return null;
    }
    const options = (plan.billingOptions ?? []) as PlanBillingOption[];
    const enabled = new Set<number>(await this.billingConfig.getEnabledDurations());
    const stored = new Map<number, PlanBillingOption>();
    for (const option of options) {
      if (isSupportedBillingDuration(option?.durationMonths)) {
        stored.set(option.durationMonths, option);
      }
    }
    const synthesize = (durationMonths: number): PlanBillingOption =>
      ({ durationMonths, discountPercent: 0 }) as PlanBillingOption;

    let match: PlanBillingOption | undefined;

    if (selection.durationMonths !== undefined && selection.durationMonths !== null) {
      const duration = Number(selection.durationMonths);
      if (!isSupportedBillingDuration(duration)) {
        throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, {
          field: 'durationMonths',
          value: selection.durationMonths,
        });
      }
      match = stored.get(duration) ?? synthesize(duration);
    } else if (selection.billingOptionId) {
      match = options.find(
        (option) => String((option as any)._id) === String(selection.billingOptionId),
      );
      if (!match) {
        throw new AppException(AppErrorCode.SUBSCRIPTION_BILLING_OPTION_NOT_FOUND, {
          billingOptionId: selection.billingOptionId,
        });
      }
    } else {
      // The mandatory 1-month term always exists (synthesised at 0 % when not yet stored).
      match = stored.get(1) ?? synthesize(1);
    }

    if (!enabled.has(match.durationMonths) || !isSupportedBillingDuration(match.durationMonths)) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_BILLING_OPTION_INACTIVE, {
        durationMonths: match.durationMonths,
      });
    }

    // Never leak legacy per-plan overrides/labels into a new snapshot: only duration/discount
    // are part of the new model. `_id` is kept only for the deprecated option-id lookup.
    return {
      _id: (match as any)._id,
      durationMonths: match.durationMonths,
      discountPercent: Number(match.discountPercent) || 0,
    } as PlanBillingOption;
  }

  /** Allowance delta for an admin extension, for event/report details. */
  extensionAllowance(
    snapshot: SubscriptionPlanSnapshot | undefined,
    options: { months?: number; days?: number },
  ): number | null {
    const monthlyOrders = snapshot?.entitlements?.monthlyOrders ?? snapshot?.limits?.maxOrders ?? null;
    return allowanceForExtension(monthlyOrders, options.months, options.days);
  }

  // ─── Writes ───

  async create(dto: CreatePlanDto, actor: SubscriptionActor): Promise<Record<string, unknown>> {
    const nameKey = normalizeNameKey(dto.name);
    const existing = await this.planModel.findOne({ nameKey }).lean().exec();
    if (existing) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_PLAN_NAME_TAKEN, { name: dto.name });
    }

    const descriptions = this.cleanDescriptions(dto);
    const legacyDescription =
      descriptions.description ??
      descriptions.descriptionEn ??
      descriptions.descriptionFr ??
      descriptions.descriptionAr;

    const billingMode = dto.billingMode ?? 'monthly';
    const durationDays = this.resolveDurationDays(billingMode, dto.durationDays);
    const billingOptions = this.normalizeBillingOptions(dto.billingOptions, dto.price, billingMode);
    const isActive = dto.isActive ?? true;
    this.assertMonthlyPlanConfigurable(billingMode, isActive, billingOptions);
    // A default signup plan must be active: the partial unique index only covers active
    // defaults, so an inactive default is both confusing and a future E11000 trap.
    if (dto.isDefaultForSignup && !isActive) {
      throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, {
        field: 'isDefaultForSignup',
        reason: 'default_requires_active',
      });
    }

    const payload = {
      name: dto.name.trim(),
      nameKey,
      description: legacyDescription,
      descriptionEn: descriptions.descriptionEn,
      descriptionFr: descriptions.descriptionFr,
      descriptionAr: descriptions.descriptionAr,
      image: dto.image?.trim() || undefined,
      price: dto.price,
      currency: 'DZD',
      durationDays,
      billingMode,
      billingOptions,
      isActive,
      isDefaultForSignup: dto.isDefaultForSignup ?? false,
      version: 1,
      limits: { ...DEFAULT_LIMITS, ...(dto.limits ?? {}) },
      features: { ...DEFAULT_FEATURES, ...(dto.features ?? {}) },
      trial: this.normalizeTrial(dto.trial),
      createdByAdminId: actor.id ?? null,
      createdByAdminEmail: actor.email ?? null,
      lastEditedByAdminId: actor.id ?? null,
      lastEditedByAdminEmail: actor.email ?? null,
    };

    let created!: SubscriptionPlanDocument;
    if (payload.isDefaultForSignup) {
      // Clear the previous default and create the new one atomically. When transactions are
      // unavailable this fails before any write, leaving the previous default intact.
      const session = await openTransactionSession(this.planModel, this.logger);
      try {
        await session.withTransaction(async () => {
          await this.planModel.updateMany(
            { isDefaultForSignup: true },
            { $set: { isDefaultForSignup: false } },
            { session },
          );
          const [doc] = await this.planModel.create([payload], { session });
          created = doc as SubscriptionPlanDocument;
        });
      } catch (err) {
        this.mapPlanWriteError(err, dto.name);
      } finally {
        await session.endSession();
      }
    } else {
      try {
        created = await this.planModel.create(payload);
      } catch (err) {
        this.mapPlanWriteError(err, dto.name);
      }
    }

    await this.recordPlanEvent(
      SubscriptionEventAction.PLAN_CREATED,
      created._id as Types.ObjectId,
      actor,
      null,
      this.planEventSnapshot(created),
      { name: created.name },
    );

    const enabledDurations = await this.billingConfig.getEnabledDurations();
    return this.toPlanResponse(created.toObject(), undefined, enabledDurations);
  }

  async update(
    id: string,
    dto: UpdatePlanDto,
    actor: SubscriptionActor,
  ): Promise<Record<string, unknown>> {
    this.assertValidId(id, AppErrorCode.SUBSCRIPTION_PLAN_NOT_FOUND);
    const plan = await this.planModel.findById(id).exec();
    if (!plan) throw new AppException(AppErrorCode.SUBSCRIPTION_PLAN_NOT_FOUND, { id });

    const before = this.planEventSnapshot(plan);
    const changed: string[] = [];

    if (dto.name !== undefined && normalizeNameKey(dto.name) !== plan.nameKey) {
      const nameKey = normalizeNameKey(dto.name);
      const clash = await this.planModel
        .findOne({ nameKey, _id: { $ne: plan._id } })
        .lean()
        .exec();
      if (clash) {
        throw new AppException(AppErrorCode.SUBSCRIPTION_PLAN_NAME_TAKEN, { name: dto.name });
      }
      plan.name = dto.name.trim();
      plan.nameKey = nameKey;
      changed.push('name');
    }
    const descriptions = this.cleanDescriptions(dto);
    if (Object.keys(descriptions).length > 0) {
      if ('descriptionEn' in descriptions) plan.descriptionEn = descriptions.descriptionEn;
      if ('descriptionFr' in descriptions) plan.descriptionFr = descriptions.descriptionFr;
      if ('descriptionAr' in descriptions) plan.descriptionAr = descriptions.descriptionAr;
      if ('description' in descriptions) {
        plan.description = descriptions.description;
      } else {
        plan.description =
          plan.descriptionEn ?? plan.descriptionFr ?? plan.descriptionAr;
      }
      changed.push('description');
    }
    if (dto.image !== undefined) {
      plan.image = dto.image.trim() || undefined;
      changed.push('image');
    }
    if (dto.price !== undefined && dto.price !== plan.price) {
      plan.price = dto.price;
      changed.push('price');
    }

    const nextBillingMode = dto.billingMode ?? plan.billingMode ?? 'legacy';
    if (dto.billingMode !== undefined && dto.billingMode !== plan.billingMode) {
      plan.billingMode = dto.billingMode;
      changed.push('billingMode');
    }

    if (nextBillingMode === 'monthly') {
      if (dto.durationDays !== undefined && dto.durationDays !== 30) {
        throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, {
          field: 'durationDays',
          reason: 'monthly_plans_use_30_days',
        });
      }
      if (plan.durationDays !== 30) {
        plan.durationDays = 30;
        changed.push('durationDays');
      }
    } else if (dto.durationDays !== undefined && dto.durationDays !== plan.durationDays) {
      plan.durationDays = dto.durationDays;
      changed.push('durationDays');
    }

    if (dto.billingOptions !== undefined) {
      const effectivePrice = dto.price !== undefined ? dto.price : plan.price;
      plan.billingOptions = this.normalizeBillingOptions(
        dto.billingOptions,
        effectivePrice,
        nextBillingMode,
      );
      changed.push('billingOptions');
    } else if (nextBillingMode === 'legacy' && (plan.billingOptions?.length ?? 0) > 0) {
      plan.billingOptions = [];
      changed.push('billingOptions');
    }

    if (dto.price !== undefined && dto.billingOptions === undefined) {
      // A price change must not leave a stored legacy override above the new list price.
      for (const option of (plan.billingOptions ?? []) as PlanBillingOption[]) {
        if (!isSupportedBillingDuration(option.durationMonths)) continue;
        computeBillingOption(plan.price, {
          durationMonths: option.durationMonths,
          discountPercent: Number(option.discountPercent) || 0,
        });
      }
    }

    this.assertMonthlyPlanConfigurable(
      nextBillingMode,
      plan.isActive,
      (plan.billingOptions ?? []) as PlanBillingOption[],
    );
    if (dto.limits !== undefined) {
      plan.limits = { ...this.readLimits(plan.limits), ...this.cleanLimits(dto.limits) };
      changed.push('limits');
    }
    if (dto.features !== undefined) {
      plan.features = { ...this.readFeatures(plan.features), ...this.cleanFeatures(dto.features) };
      changed.push('features');
    }
    if (dto.trial !== undefined) {
      plan.trial = this.normalizeTrial({ ...this.readTrial(plan.trial), ...dto.trial });
      changed.push('trial');
    }
    if (dto.isDefaultForSignup !== undefined) {
      plan.isDefaultForSignup = dto.isDefaultForSignup;
      changed.push('isDefaultForSignup');
    }

    // A plan can only be the signup default while it is active (the unique partial index
    // covers active defaults only, so allowing an inactive one would poison a later activation).
    if (plan.isDefaultForSignup && !plan.isActive) {
      throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, {
        field: 'isDefaultForSignup',
        reason: 'default_requires_active',
      });
    }

    plan.version += 1;
    plan.lastEditedByAdminId = actor.id ?? null;
    plan.lastEditedByAdminEmail = actor.email ?? null;

    if (dto.isDefaultForSignup) {
      // Clear the previous default and save this plan in one transaction, so a failure cannot
      // leave zero valid defaults. Transactions-unavailable fails before any write.
      const session = await openTransactionSession(this.planModel, this.logger);
      try {
        await session.withTransaction(async () => {
          await this.planModel.updateMany(
            { _id: { $ne: plan._id }, isDefaultForSignup: true },
            { $set: { isDefaultForSignup: false } },
            { session },
          );
          await plan.save({ session });
        });
      } catch (err) {
        this.mapPlanWriteError(err, plan.name);
      } finally {
        await session.endSession();
      }
    } else {
      try {
        await plan.save();
      } catch (err) {
        this.mapPlanWriteError(err, plan.name);
      }
    }

    await this.recordPlanEvent(
      SubscriptionEventAction.PLAN_UPDATED,
      plan._id as Types.ObjectId,
      actor,
      before,
      this.planEventSnapshot(plan),
      { changedFields: changed },
    );

    // A plan edit never touches subscriptions. This is the snapshot invariant (§7.2).
    const enabledDurations = await this.billingConfig.getEnabledDurations();
    return this.toPlanResponse(plan.toObject(), undefined, enabledDurations);
  }

  async setAvailability(
    id: string,
    isActive: boolean,
    actor: SubscriptionActor,
  ): Promise<Record<string, unknown>> {
    this.assertValidId(id, AppErrorCode.SUBSCRIPTION_PLAN_NOT_FOUND);
    const plan = await this.planModel.findById(id).exec();
    if (!plan) throw new AppException(AppErrorCode.SUBSCRIPTION_PLAN_NOT_FOUND, { id });

    if (plan.isActive !== isActive) {
      if (isActive) {
        this.assertMonthlyPlanConfigurable(
          plan.billingMode ?? 'legacy',
          true,
          (plan.billingOptions ?? []) as PlanBillingOption[],
        );
      }
      plan.isActive = isActive;
      if (!isActive) plan.isDefaultForSignup = false;
      plan.lastEditedByAdminId = actor.id ?? null;
      plan.lastEditedByAdminEmail = actor.email ?? null;

      if (isActive && plan.isDefaultForSignup) {
        // Activating a legacy inactive default repairs the state: demote any other active
        // default and activate this one atomically.
        const session = await openTransactionSession(this.planModel, this.logger);
        try {
          await session.withTransaction(async () => {
            await this.planModel.updateMany(
              { _id: { $ne: plan._id }, isDefaultForSignup: true },
              { $set: { isDefaultForSignup: false } },
              { session },
            );
            await plan.save({ session });
          });
        } catch (err) {
          this.mapPlanWriteError(err, plan.name);
        } finally {
          await session.endSession();
        }
      } else {
        try {
          await plan.save();
        } catch (err) {
          this.mapPlanWriteError(err, plan.name);
        }
      }
      await this.recordPlanEvent(
        isActive
          ? SubscriptionEventAction.PLAN_ACTIVATED
          : SubscriptionEventAction.PLAN_DEACTIVATED,
        plan._id as Types.ObjectId,
        actor,
        { isActive: !isActive },
        { isActive },
        null,
      );
    }

    const enabledDurations = await this.billingConfig.getEnabledDurations();
    return this.toPlanResponse(plan.toObject(), undefined, enabledDurations);
  }

  // ─── Helpers ───

  /**
   * Map a duplicate-key/write race to a domain conflict instead of a bare 500. `withTransaction`
   * already retries transient write conflicts; this covers the unique indexes that can still
   * collide (name, code, active default).
   */
  private mapPlanWriteError(err: unknown, name?: string): never {
    const anyErr = err as { code?: number; keyPattern?: Record<string, unknown>; message?: string };
    if (anyErr?.code === 11000) {
      const keys = Object.keys(anyErr.keyPattern ?? {});
      if (keys.includes('nameKey')) {
        throw new AppException(AppErrorCode.SUBSCRIPTION_PLAN_NAME_TAKEN, {
          name: name ?? '',
        });
      }
      if (keys.includes('code')) {
        throw new AppException(AppErrorCode.SUBSCRIPTION_STATE_CONFLICT, {
          reason: 'plan_code_taken',
        });
      }
      throw new AppException(AppErrorCode.SUBSCRIPTION_STATE_CONFLICT, {
        reason: 'default_plan_conflict',
      });
    }
    throw err;
  }

  private cleanDescriptions(input: {
    description?: string;
    descriptionEn?: string;
    descriptionFr?: string;
    descriptionAr?: string;
  }): {
    description?: string;
    descriptionEn?: string;
    descriptionFr?: string;
    descriptionAr?: string;
  } {
    const out: {
      description?: string;
      descriptionEn?: string;
      descriptionFr?: string;
      descriptionAr?: string;
    } = {};
    for (const key of [
      'description',
      'descriptionEn',
      'descriptionFr',
      'descriptionAr',
    ] as const) {
      if (input[key] === undefined) continue;
      out[key] = input[key]!.trim() || undefined;
    }
    return out;
  }

  private normalizeTrial(input?: Partial<SubscriptionTrialConfig> | null): SubscriptionTrialConfig {
    const enabled = Boolean(input?.enabled);
    const days = enabled ? Number(input?.days ?? 0) : null;
    if (enabled && (!Number.isInteger(days) || (days as number) < 1)) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_TRIAL_NOT_AVAILABLE, {
        reason: 'trial_days_invalid',
      });
    }
    return { enabled, days: enabled ? (days as number) : null };
  }

  private cleanLimits(input: Partial<SubscriptionLimits>): Partial<SubscriptionLimits> {
    const out: Partial<SubscriptionLimits> = {};
    for (const key of ['maxOrders', 'maxProducts', 'maxTeamMembers'] as const) {
      if (input[key] === undefined) continue;
      out[key] = input[key] === null ? null : Number(input[key]);
    }
    return out;
  }

  private cleanFeatures(input: Partial<SubscriptionFeatures>): Partial<SubscriptionFeatures> {
    const out: Partial<SubscriptionFeatures> = {};
    if (input.pos !== undefined) out.pos = Boolean(input.pos);
    return out;
  }

  /**
   * Normalise a plan field that may be a Mongoose single-nested subdocument, a hydrated
   * document, a `.lean()` plain object, or `undefined`.
   *
   * The reason this exists: on a hydrated document `plan.limits`/`plan.features`/`plan.trial`
   * are `SingleNested` values whose fields are prototype getters. Spreading them
   * (`{ ...plan.limits }`) copies **none** of the fields — only internal keys — so a real
   * `maxOrders: 1` silently becomes `null`. Reading through `toObject()` (or the plain object
   * itself) keeps every value and drops `_id`/internal keys.
   */
  private subdocumentValue(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object') return {};
    const candidate = value as { toObject?: () => Record<string, unknown> };
    const source =
      typeof candidate.toObject === 'function'
        ? candidate.toObject()
        : (value as Record<string, unknown>);
    const rest: Record<string, unknown> = { ...source };
    delete rest._id;
    return rest;
  }

  private readLimits(value: Partial<SubscriptionLimits> | null | undefined): SubscriptionLimits {
    const source = this.subdocumentValue(value);
    return {
      maxOrders: (source.maxOrders as number | null | undefined) ?? null,
      maxProducts: (source.maxProducts as number | null | undefined) ?? null,
      maxTeamMembers: (source.maxTeamMembers as number | null | undefined) ?? null,
    };
  }

  private readFeatures(
    value: Partial<SubscriptionFeatures> | null | undefined,
  ): SubscriptionFeatures {
    return { pos: this.subdocumentValue(value).pos === true };
  }

  private readTrial(
    value: Partial<SubscriptionTrialConfig> | null | undefined,
  ): SubscriptionTrialConfig {
    const source = this.subdocumentValue(value);
    return {
      enabled: source.enabled === true,
      days: (source.days as number | null | undefined) ?? null,
    };
  }

  private resolveDurationDays(
    billingMode: 'legacy' | 'monthly',
    durationDays?: number,
  ): number {
    if (billingMode === 'monthly') {
      if (durationDays !== undefined && durationDays !== 30) {
        throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, {
          field: 'durationDays',
          reason: 'monthly_plans_use_30_days',
        });
      }
      return 30;
    }
    if (!Number.isInteger(durationDays) || (durationDays as number) < 1) {
      throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, { field: 'durationDays' });
    }
    return durationDays as number;
  }

  /**
   * Normalise monthly billing discounts. Only the four supported durations are accepted; the
   * array is always stored with all four (missing durations default to 0 %). There is no label,
   * no per-plan availability and no per-plan price override — those were removed so billing
   * durations are global and prices are always derived from the monthly base.
   */
  private normalizeBillingOptions(
    input: Array<{ durationMonths?: unknown; discountPercent?: unknown }> | undefined,
    price: number,
    billingMode: 'legacy' | 'monthly',
  ): PlanBillingOption[] {
    if (billingMode !== 'monthly') return [];

    const byDuration = new Map<number, number>();
    for (const row of input ?? []) {
      const durationMonths = Number(row?.durationMonths);
      if (!isSupportedBillingDuration(durationMonths)) {
        throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, {
          field: 'durationMonths',
          value: row?.durationMonths,
        });
      }
      if (byDuration.has(durationMonths)) {
        throw new AppException(AppErrorCode.SUBSCRIPTION_BILLING_OPTION_DUPLICATE_DURATION, {
          durationMonths,
        });
      }
      const discountPercent = Number(row?.discountPercent ?? 0);
      // computeBillingOption throws the billing error codes for an invalid discount.
      computeBillingOption(price, { durationMonths, discountPercent });
      byDuration.set(durationMonths, discountPercent);
    }

    return SUPPORTED_BILLING_DURATIONS.map(
      (durationMonths) =>
        ({
          durationMonths,
          discountPercent: byDuration.get(durationMonths) ?? 0,
        }) as PlanBillingOption,
    );
  }

  /**
   * The 1-month term is synthesised when absent and `normalizeBillingOptions` always persists
   * the four supported durations, so a monthly plan is inherently configurable. Kept as a
   * single seam so activation cannot regress without touching callers.
   */
  private assertMonthlyPlanConfigurable(
    _billingMode: 'legacy' | 'monthly',
    _isActive: boolean,
    _options: PlanBillingOption[],
  ): void {
    return;
  }

  /**
   * Computed duration rows for admin/public responses (never persisted). Missing durations are
   * synthesised at 0 % so the fixed four-duration catalogue always renders, even before the
   * migration has rewritten a legacy monthly plan.
   */
  private computeBillingOptionRows(
    plan: Record<string, any>,
    enabledDurations: number[],
  ): Record<string, unknown>[] {
    if ((plan.billingMode ?? 'legacy') !== 'monthly') return [];
    const monthlyOrders = plan.limits?.maxOrders ?? null;
    const stored = new Map<number, number>();
    for (const option of (plan.billingOptions ?? []) as PlanBillingOption[]) {
      const duration = Number(option?.durationMonths);
      if (!isSupportedBillingDuration(duration)) continue;
      const discount = Number(option?.discountPercent);
      stored.set(duration, Number.isFinite(discount) ? discount : 0);
    }
    const enabled = new Set<number>(enabledDurations);

    return SUPPORTED_BILLING_DURATIONS.map((durationMonths) => {
      const discountPercent = stored.get(durationMonths) ?? 0;
      const computation = computeBillingOption(plan.price, {
        durationMonths,
        discountPercent,
      });
      const isEnabled = enabled.has(durationMonths);
      return {
        id: null,
        label: null,
        durationMonths,
        discountPercent,
        priceOverride: null,
        isActive: isEnabled,
        isEnabled,
        isDefault: durationMonths === 1,
        sortOrder: SUPPORTED_BILLING_DURATIONS.indexOf(durationMonths),
        listPrice: computation.listPrice,
        calculatedPrice: computation.calculatedPrice,
        finalPrice: computation.finalPrice,
        savings: computation.savings,
        effectiveDiscountPercent: computation.effectiveDiscountPercent,
        ordersAllowance: computeOrdersAllowance(monthlyOrders, durationMonths),
        priceSource: computation.priceSource,
      };
    });
  }

  private assertValidId(id: string, code: AppErrorCodeType): void {
    if (!Types.ObjectId.isValid(id)) throw new AppException(code, { id });
  }

  private async storeCountsFor(
    planIds: Types.ObjectId[],
  ): Promise<Map<string, PlanStoreCounts>> {
    const result = new Map<string, PlanStoreCounts>();
    if (planIds.length === 0) return result;

    const rows = await this.subscriptionModel
      .aggregate<{
        _id: Types.ObjectId;
        storeCount: number;
        statuses: string[];
        endDates: (Date | null)[];
        trialEnds: (Date | null)[];
        isTrials: boolean[];
      }>([
        { $match: { planId: { $in: planIds } } },
        {
          $group: {
            _id: '$planId',
            storeCount: { $sum: 1 },
            statuses: { $push: '$status' },
            endDates: { $push: '$endDate' },
            trialEnds: { $push: '$trialEndsAt' },
            isTrials: { $push: '$isTrial' },
          },
        },
      ])
      .exec();

    const now = new Date();
    for (const row of rows as Array<Record<string, any>>) {
      const statuses: string[] = row.statuses ?? [];
      const endDates: (Date | null)[] = row.endDates ?? [];
      const trialEnds: (Date | null)[] = row.trialEnds ?? [];
      const isTrials: boolean[] = row.isTrials ?? [];
      let activeStoreCount = 0;
      statuses.forEach((status, i) => {
        const effective = resolveEffectiveSubscriptionStatus(
          {
            status,
            endDate: endDates[i] ?? null,
            isTrial: isTrials[i],
            trialEndsAt: trialEnds[i] ?? null,
          },
          now,
        );
        if (effective === SubscriptionStatus.ACTIVE || effective === SubscriptionStatus.TRIALING) {
          activeStoreCount += 1;
        }
      });
      result.set(String(row._id), { storeCount: row.storeCount ?? 0, activeStoreCount });
    }
    return result;
  }

  private async subscriberSummary(planId: Types.ObjectId): Promise<Record<string, number>> {
    const counts = await this.storeCountsFor([planId]);
    const entry = counts.get(String(planId)) ?? { storeCount: 0, activeStoreCount: 0 };
    return {
      storeCount: entry.storeCount,
      activeStoreCount: entry.activeStoreCount,
      expiredOrCancelledStoreCount: entry.storeCount - entry.activeStoreCount,
    };
  }

  private planEventSnapshot(plan: {
    isActive?: boolean;
    version?: number;
    name?: string;
  }): {
    status?: string;
    planVersion?: number | null;
    snapshotName?: string | null;
  } {
    return { status: plan.isActive ? 'active' : 'inactive', planVersion: plan.version, snapshotName: plan.name };
  }

  private async recordPlanEvent(
    action: SubscriptionEventAction,
    planId: Types.ObjectId,
    actor: SubscriptionActor,
    from: Record<string, unknown> | null,
    to: Record<string, unknown> | null,
    details: Record<string, unknown> | null,
  ): Promise<void> {
    try {
      await this.eventModel.create({
        planId,
        action,
        from,
        to,
        actorType: 'admin',
        adminId: actor.id ?? null,
        adminEmail: actor.email ?? null,
        details,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to write subscription event ${action}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private toPlanResponse(
    doc: Record<string, any>,
    counts?: PlanStoreCounts,
    enabledDurations: SupportedBillingDuration[] = [...SUPPORTED_BILLING_DURATIONS],
  ): Record<string, unknown> {
    const billingOptions = this.computeBillingOptionRows(doc, enabledDurations);
    const defaultOption =
      billingOptions.find((option) => option.isDefault && option.isEnabled) ??
      billingOptions.find((option) => option.isEnabled) ??
      null;
    return {
      id: String(doc._id),
      name: doc.name,
      description: doc.description ?? null,
      descriptionEn: doc.descriptionEn ?? null,
      descriptionFr: doc.descriptionFr ?? null,
      descriptionAr: doc.descriptionAr ?? null,
      image: doc.image ?? null,
      price: doc.price,
      currency: doc.currency,
      durationDays: doc.durationDays,
      billingMode: doc.billingMode ?? 'legacy',
      billingOptions,
      enabledBillingDurations: enabledDurations,
      defaultBillingOptionId: defaultOption ? (defaultOption.id as string | null) : null,
      isActive: doc.isActive,
      isDefaultForSignup: Boolean(doc.isDefaultForSignup),
      version: doc.version,
      limits: doc.limits ?? DEFAULT_LIMITS,
      features: doc.features ?? DEFAULT_FEATURES,
      trial: doc.trial ?? DEFAULT_TRIAL,
      storeCount: counts?.storeCount ?? 0,
      activeStoreCount: counts?.activeStoreCount ?? 0,
      createdByAdminEmail: doc.createdByAdminEmail ?? null,
      lastEditedByAdminEmail: doc.lastEditedByAdminEmail ?? null,
      createdAt: doc.createdAt ?? null,
      updatedAt: doc.updatedAt ?? null,
    };
  }
}



