import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import {
  SubscriptionStatus,
  resolveEffectiveSubscriptionStatus,
} from '../../common/constants/subscription.const';
import { Store, StoreDocument } from '../stores/schemas/store.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { SubscriptionActor } from './plans.service';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionAccessService } from './subscription-access.service';
import { SubscriptionQueryDto } from './dto/subscription.dto';
import {
  Subscription,
  SubscriptionDocument,
} from './schemas/subscription.schema';
import {
  SubscriptionEvent,
  SubscriptionEventDocument,
} from './schemas/subscription-event.schema';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface StoreInfo {
  id: string;
  storeName: string;
  storeSlug: string;
  vendorEmail: string;
  owner: { id: string; fullName: string; email: string } | null;
}

@Injectable()
export class AdminSubscriptionsService {
  private readonly logger = new Logger(AdminSubscriptionsService.name);

  constructor(
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<SubscriptionDocument>,
    @InjectModel(SubscriptionEvent.name)
    private readonly eventModel: Model<SubscriptionEventDocument>,
    @InjectModel(Store.name)
    private readonly storeModel: Model<StoreDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly accessService: SubscriptionAccessService,
  ) {}

  async list(query: SubscriptionQueryDto): Promise<Record<string, unknown>> {
    const filter = await this.buildFilter(query);
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));

    const [docs, total] = await Promise.all([
      this.subscriptionModel
        .find(filter)
        .sort({ createdAt: -1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.subscriptionModel.countDocuments(filter).exec(),
    ]);

    const stores = await this.storeInfoFor(docs.map((d) => String(d.storeId)));
    const items = docs.map((doc) => ({
      ...this.toResponse(doc as unknown as SubscriptionDocument),
      store: stores.get(String(doc.storeId)) ?? null,
    }));

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async get(id: string): Promise<Record<string, unknown>> {
    const doc = await this.findById(id);
    const stores = await this.storeInfoFor([String(doc.storeId)]);
    const events = await this.eventModel
      .find({ subscriptionId: doc._id })
      .sort({ createdAt: -1, _id: -1 })
      .limit(100)
      .lean()
      .exec();
    const usage = await this.accessService.getUsage(String(doc.storeId), doc);
    const capabilities = await this.accessService.getCapabilities(String(doc.storeId));
    return {
      subscription: {
        ...this.toResponse(doc),
        usage: { ...(this.toResponse(doc).usage as Record<string, unknown>), ...usage },
        capabilities,
        store: stores.get(String(doc.storeId)) ?? null,
      },
      events: events.map((event) => ({
        id: String(event._id),
        action: event.action,
        from: event.from ?? null,
        to: event.to ?? null,
        reason: event.reason ?? null,
        actorType: event.actorType,
        adminEmail: event.adminEmail ?? null,
        details: event.details ?? null,
        createdAt: (event as unknown as { createdAt?: Date }).createdAt ?? null,
      })),
    };
  }

  async assign(
    storeId: string,
    planId: string,
    actor: SubscriptionActor,
    replace?: boolean,
  ): Promise<Record<string, unknown>> {
    await this.assertStoreExists(storeId);
    const doc = await this.subscriptionsService.assignPlan(storeId, planId, actor, { replace });
    return this.enriched(doc);
  }

  async grantTrial(
    storeId: string,
    planId: string,
    actor: SubscriptionActor,
    replace?: boolean,
  ): Promise<Record<string, unknown>> {
    await this.assertStoreExists(storeId);
    const doc = await this.subscriptionsService.grantTrial(storeId, planId, actor, { replace });
    return this.enriched(doc);
  }

  async changePlan(
    id: string,
    planId: string,
    actor: SubscriptionActor,
    reason?: string,
  ): Promise<Record<string, unknown>> {
    const doc = await this.subscriptionsService.changePlan(id, planId, actor, reason);
    return this.enriched(doc);
  }

  async extend(
    id: string,
    days: number,
    actor: SubscriptionActor,
    reason?: string,
  ): Promise<Record<string, unknown>> {
    const doc = await this.subscriptionsService.extend(id, days, actor, reason);
    return this.enriched(doc);
  }

  async cancel(
    id: string,
    actor: SubscriptionActor,
    reason?: string,
  ): Promise<Record<string, unknown>> {
    const doc = await this.subscriptionsService.cancel(id, actor, reason);
    return this.enriched(doc);
  }

  async reactivate(
    id: string,
    actor: SubscriptionActor,
    options: { days?: number; reason?: string },
  ): Promise<Record<string, unknown>> {
    const doc = await this.subscriptionsService.reactivate(id, actor, options);
    return this.enriched(doc);
  }

  // ─── Internals ───

  private async findById(id: string): Promise<SubscriptionDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_NOT_FOUND, { id });
    }
    const doc = await this.subscriptionModel.findById(id).exec();
    if (!doc) throw new AppException(AppErrorCode.SUBSCRIPTION_NOT_FOUND, { id });
    return doc;
  }

  private async assertStoreExists(storeId: string): Promise<void> {
    if (!Types.ObjectId.isValid(storeId)) {
      throw new AppException(AppErrorCode.STORE_NOT_FOUND, { id: storeId });
    }
    const exists = await this.storeModel.exists({ _id: new Types.ObjectId(storeId) }).exec();
    if (!exists) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { id: storeId });
  }

  private async buildFilter(query: SubscriptionQueryDto): Promise<Record<string, unknown>> {
    const filter: Record<string, unknown> = {};
    const and: Record<string, unknown>[] = [];

    if (query.planId) filter.planId = new Types.ObjectId(query.planId);
    if (query.storeId) filter.storeId = new Types.ObjectId(query.storeId);

    const now = new Date();

    if (query.status === 'cancelled') {
      filter.status = SubscriptionStatus.CANCELLED;
    } else if (query.status === 'expired') {
      filter.status = { $ne: SubscriptionStatus.CANCELLED };
      and.push({
        $or: [
          { status: SubscriptionStatus.EXPIRED },
          { endDate: { $ne: null, $lte: now } },
        ],
      });
    } else if (query.status === 'trialing') {
      filter.status = SubscriptionStatus.TRIALING;
      filter.isTrial = true;
      and.push({ $or: [{ endDate: null }, { endDate: { $gt: now } }] });
    } else if (query.status === 'active') {
      filter.status = SubscriptionStatus.ACTIVE;
      filter.isTrial = false;
      and.push({ $or: [{ endDate: null }, { endDate: { $gt: now } }] });
    }

    if (query.trial) filter.isTrial = query.trial === 'yes';

    if (query.startFrom) {
      filter.startDate = {
        ...(filter.startDate as Record<string, unknown> | undefined),
        $gte: this.parseDate(query.startFrom, 'startFrom'),
      };
    }
    if (query.startTo) {
      filter.startDate = {
        ...(filter.startDate as Record<string, unknown> | undefined),
        $lte: this.parseDate(query.startTo, 'startTo'),
      };
    }

    const term = query.search?.trim();
    if (term) {
      const regex = new RegExp(escapeRegex(term), 'i');
      const stores = await this.storeModel
        .find({ $or: [{ storeName: regex }, { storeSlug: regex }, { vendorEmail: regex }] })
        .select('_id')
        .lean()
        .exec();
      const users = await this.userModel
        .find({ $or: [{ email: regex }, { fullName: regex }] })
        .select('_id email')
        .lean()
        .exec();
      const emails = users
        .map((user) => (typeof user.email === 'string' ? user.email : null))
        .filter((email): email is string => Boolean(email));

      const storeIds = stores
        .map((store) => String(store._id))
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id));
      if (emails.length > 0) {
        const byEmail = await this.storeModel
          .find({ vendorEmail: { $in: emails } })
          .select('_id')
          .lean()
          .exec();
        byEmail.forEach((store) => storeIds.push(new Types.ObjectId(String(store._id))));
      }
      filter.storeId = { $in: storeIds };
    }

    if (and.length > 0) filter.$and = and;
    return filter;
  }

  private parseDate(value: string, field: string): Date {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, { field, value });
    }
    return date;
  }

  private async storeInfoFor(storeIds: string[]): Promise<Map<string, StoreInfo>> {
    const map = new Map<string, StoreInfo>();
    const validIds = storeIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (validIds.length === 0) return map;

    const stores = await this.storeModel
      .find({ _id: { $in: validIds } })
      .select('_id storeName storeSlug vendorEmail vendorId')
      .lean()
      .exec();

    const userIds = stores
      .map((store) => (store.vendorId ? String(store.vendorId) : null))
      .filter((id): id is string => Boolean(id) && Types.ObjectId.isValid(id as string))
      .map((id) => new Types.ObjectId(id));
    const emails = stores
      .map((store) => (typeof store.vendorEmail === 'string' ? store.vendorEmail.trim() : null))
      .filter((email): email is string => Boolean(email));

    const usersById = new Map<string, { id: string; fullName: string; email: string }>();
    const usersByEmail = new Map<string, { id: string; fullName: string; email: string }>();
    if (userIds.length > 0) {
      const users = await this.userModel
        .find({ _id: { $in: userIds } })
        .select('_id fullName email')
        .lean()
        .exec();
      for (const user of users) {
        const info = {
          id: String(user._id),
          fullName: user.fullName ?? '',
          email: typeof user.email === 'string' ? user.email : '',
        };
        usersById.set(info.id, info);
        if (info.email) usersByEmail.set(info.email.toLowerCase(), info);
      }
    }
    const unresolved = emails.filter((email) => !usersByEmail.has(email.toLowerCase()));
    if (unresolved.length > 0) {
      const users = await this.userModel
        .find({ email: { $in: unresolved } })
        .select('_id fullName email')
        .lean()
        .exec();
      for (const user of users) {
        const info = {
          id: String(user._id),
          fullName: user.fullName ?? '',
          email: typeof user.email === 'string' ? user.email : '',
        };
        if (info.email) usersByEmail.set(info.email.toLowerCase(), info);
      }
    }

    for (const store of stores) {
      const email = typeof store.vendorEmail === 'string' ? store.vendorEmail.trim() : '';
      const owner =
        (store.vendorId ? usersById.get(String(store.vendorId)) : undefined) ??
        (email ? usersByEmail.get(email.toLowerCase()) : undefined) ??
        null;
      map.set(String(store._id), {
        id: String(store._id),
        storeName: store.storeName,
        storeSlug: store.storeSlug,
        vendorEmail: email,
        owner,
      });
    }
    return map;
  }

  private async enriched(doc: SubscriptionDocument): Promise<Record<string, unknown>> {
    const stores = await this.storeInfoFor([String(doc.storeId)]);
    return {
      ...this.toResponse(doc),
      store: stores.get(String(doc.storeId)) ?? null,
    };
  }

  private toResponse(doc: SubscriptionDocument): Record<string, unknown> {
    const now = new Date();
    const effectiveStatus = resolveEffectiveSubscriptionStatus(
      { status: doc.status, isTrial: doc.isTrial, endDate: doc.endDate },
      now,
    );
    return {
      id: String(doc._id),
      storeId: String(doc.storeId),
      planId: doc.planId ? String(doc.planId) : null,
      plan: doc.planSnapshot,
      status: doc.status,
      effectiveStatus,
      isTrial: Boolean(doc.isTrial),
      startDate: doc.startDate,
      endDate: doc.endDate ?? null,
      trialStartedAt: doc.trialStartedAt ?? null,
      trialEndsAt: doc.trialEndsAt ?? null,
      trialUsedAt: doc.trialUsedAt ?? null,
      cancelledAt: doc.cancelledAt ?? null,
      cancelReason: doc.cancelReason ?? null,
      usage: {
        ordersUsed: doc.usage?.ordersUsed ?? 0,
        ordersLimit: doc.planSnapshot?.limits?.maxOrders ?? null,
      },
      source: doc.source,
      createdAt: (doc as unknown as { createdAt?: Date }).createdAt ?? null,
      updatedAt: (doc as unknown as { updatedAt?: Date }).updatedAt ?? null,
    };
  }
}


