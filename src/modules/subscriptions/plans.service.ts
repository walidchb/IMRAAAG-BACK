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
  resolveEffectiveSubscriptionStatus,
} from '../../common/constants/subscription.const';
import {
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
  ) {}

  // ─── Reads ───

  async list(query: PlanQueryDto): Promise<PlanListResult> {
    const filter: Record<string, unknown> = {};
    if (query.status === 'active') filter.isActive = true;
    if (query.status === 'inactive') filter.isActive = false;

    const term = query.search?.trim();
    if (term) {
      const regex = new RegExp(escapeRegex(term), 'i');
      filter.$or = [{ name: regex }, { description: regex }];
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
    const items = docs.map((doc) => this.toPlanResponse(doc, counts.get(String(doc._id))));

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
    return {
      plan: this.toPlanResponse(plan, counts.get(String(plan._id))),
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
    return docs.map((doc) => this.toPlanResponse(doc));
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

  /** Immutable commercial snapshot used by subscription assignment (§7.2). */
  buildSnapshot(plan: SubscriptionPlanDocument): SubscriptionPlanSnapshot {
    return {
      planVersion: plan.version,
      name: plan.name,
      description: plan.description,
      price: plan.price,
      currency: 'DZD',
      durationDays: plan.durationDays,
      limits: { ...DEFAULT_LIMITS, ...(plan.limits ?? {}) },
      features: { ...DEFAULT_FEATURES, ...(plan.features ?? {}) },
      trial: { ...DEFAULT_TRIAL, ...(plan.trial ?? {}) },
    };
  }

  // ─── Writes ───

  async create(dto: CreatePlanDto, actor: SubscriptionActor): Promise<Record<string, unknown>> {
    const nameKey = normalizeNameKey(dto.name);
    const existing = await this.planModel.findOne({ nameKey }).lean().exec();
    if (existing) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_PLAN_NAME_TAKEN, { name: dto.name });
    }

    if (dto.isDefaultForSignup) {
      await this.planModel
        .updateMany({ isDefaultForSignup: true }, { $set: { isDefaultForSignup: false } })
        .exec();
    }

    const created = await this.planModel.create({
      name: dto.name.trim(),
      nameKey,
      description: dto.description?.trim() || undefined,
      price: dto.price,
      currency: 'DZD',
      durationDays: dto.durationDays,
      isActive: dto.isActive ?? true,
      isDefaultForSignup: dto.isDefaultForSignup ?? false,
      version: 1,
      limits: { ...DEFAULT_LIMITS, ...(dto.limits ?? {}) },
      features: { ...DEFAULT_FEATURES, ...(dto.features ?? {}) },
      trial: this.normalizeTrial(dto.trial),
      createdByAdminId: actor.id ?? null,
      createdByAdminEmail: actor.email ?? null,
      lastEditedByAdminId: actor.id ?? null,
      lastEditedByAdminEmail: actor.email ?? null,
    });

    await this.recordPlanEvent(
      SubscriptionEventAction.PLAN_CREATED,
      created._id as Types.ObjectId,
      actor,
      null,
      this.planEventSnapshot(created),
      { name: created.name },
    );

    return this.toPlanResponse(created.toObject());
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
    if (dto.description !== undefined) {
      plan.description = dto.description.trim() || undefined;
      changed.push('description');
    }
    if (dto.price !== undefined && dto.price !== plan.price) {
      plan.price = dto.price;
      changed.push('price');
    }
    if (dto.durationDays !== undefined && dto.durationDays !== plan.durationDays) {
      plan.durationDays = dto.durationDays;
      changed.push('durationDays');
    }
    if (dto.limits !== undefined) {
      plan.limits = { ...plan.limits, ...this.cleanLimits(dto.limits) };
      changed.push('limits');
    }
    if (dto.features !== undefined) {
      plan.features = { ...plan.features, ...this.cleanFeatures(dto.features) };
      changed.push('features');
    }
    if (dto.trial !== undefined) {
      plan.trial = this.normalizeTrial({ ...plan.trial, ...dto.trial });
      changed.push('trial');
    }
    if (dto.isDefaultForSignup !== undefined) {
      plan.isDefaultForSignup = dto.isDefaultForSignup;
      changed.push('isDefaultForSignup');
    }

    if (dto.isDefaultForSignup) {
      await this.planModel
        .updateMany(
          { _id: { $ne: plan._id }, isDefaultForSignup: true },
          { $set: { isDefaultForSignup: false } },
        )
        .exec();
    }

    plan.version += 1;
    plan.lastEditedByAdminId = actor.id ?? null;
    plan.lastEditedByAdminEmail = actor.email ?? null;
    await plan.save();

    await this.recordPlanEvent(
      SubscriptionEventAction.PLAN_UPDATED,
      plan._id as Types.ObjectId,
      actor,
      before,
      this.planEventSnapshot(plan),
      { changedFields: changed },
    );

    // A plan edit never touches subscriptions. This is the snapshot invariant (§7.2).
    return this.toPlanResponse(plan.toObject());
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
      plan.isActive = isActive;
      if (!isActive) plan.isDefaultForSignup = false;
      plan.lastEditedByAdminId = actor.id ?? null;
      plan.lastEditedByAdminEmail = actor.email ?? null;
      await plan.save();
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

    return this.toPlanResponse(plan.toObject());
  }

  // ─── Helpers ───

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

  private assertValidId(id: string, code: AppErrorCodeType): void {
    if (!Types.ObjectId.isValid(id)) throw new AppException(code, { id });
  }

  private async storeCountsFor(
    planIds: Types.ObjectId[],
  ): Promise<Map<string, PlanStoreCounts>> {
    const result = new Map<string, PlanStoreCounts>();
    if (planIds.length === 0) return result;

    const rows = await this.subscriptionModel
      .aggregate<{ _id: Types.ObjectId; storeCount: number; statuses: string[]; endDates: (Date | null)[] }>([
        { $match: { planId: { $in: planIds } } },
        {
          $group: {
            _id: '$planId',
            storeCount: { $sum: 1 },
            statuses: { $push: '$status' },
            endDates: { $push: '$endDate' },
            isTrials: { $push: '$isTrial' },
          },
        },
      ])
      .exec();

    const now = new Date();
    for (const row of rows as Array<Record<string, any>>) {
      const statuses: string[] = row.statuses ?? [];
      const endDates: (Date | null)[] = row.endDates ?? [];
      const isTrials: boolean[] = row.isTrials ?? [];
      let activeStoreCount = 0;
      statuses.forEach((status, i) => {
        const effective = resolveEffectiveSubscriptionStatus(
          { status, endDate: endDates[i] ?? null, isTrial: isTrials[i] },
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

  private toPlanResponse(doc: Record<string, any>, counts?: PlanStoreCounts): Record<string, unknown> {
    return {
      id: String(doc._id),
      name: doc.name,
      description: doc.description ?? null,
      price: doc.price,
      currency: doc.currency,
      durationDays: doc.durationDays,
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



