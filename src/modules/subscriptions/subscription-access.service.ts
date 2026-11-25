import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import {
  SubscriptionFeatures,
  SubscriptionLimits,
  SubscriptionStatus,
  isSubscriptionEntitled,
  resolveEffectiveSubscriptionStatus,
} from '../../common/constants/subscription.const';
import { StoreInvitationStatus, StoreMemberStatus, StoreRole } from '../../common/constants/store-roles.enum';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { StoreMember, StoreMemberDocument } from '../team/schemas/store-member.schema';
import {
  StoreInvitation,
  StoreInvitationDocument,
} from '../team/schemas/store-invitation.schema';
import { Subscription, SubscriptionDocument } from './schemas/subscription.schema';

export interface SubscriptionUsage {
  ordersUsed: number;
  ordersLimit: number | null;
  activeProducts: number;
  productsLimit: number | null;
  teamSeats: number;
  teamLimit: number | null;
  pendingInvitations: number;
}

export interface SubscriptionCapabilities {
  acceptingOrders: boolean;
  canUsePos: boolean;
  canCreateProduct: boolean;
  canActivateProduct: boolean;
  canInviteTeam: boolean;
}

export interface SubscriptionEntitlement {
  subscription: SubscriptionDocument | null;
  effectiveStatus: SubscriptionStatus | 'none';
  entitled: boolean;
  limits: SubscriptionLimits;
  features: SubscriptionFeatures;
}

export interface PublicSubscriptionState {
  acceptingOrders: boolean;
  subscriptionState: SubscriptionStatus | 'none';
}

const UNLIMITED: SubscriptionLimits = { maxOrders: null, maxProducts: null, maxTeamMembers: null };

/** Both BSON shapes, so a Mixed-cast storeId still matches (see AGENTS.md schema quirk). */
function storeIdFilter(storeId: string): { $in: (Types.ObjectId | string)[] } {
  const values: (Types.ObjectId | string)[] = [storeId];
  if (Types.ObjectId.isValid(storeId)) values.push(new Types.ObjectId(storeId));
  return { $in: values };
}

/**
 * The single read-side entitlement resolver. Every backend capability check and every
 * display surface asks this service, so the effective-status rule lives in exactly one place.
 * It never writes store status; expiry is a commercial state only (plan §6.3).
 */
@Injectable()
export class SubscriptionAccessService {
  private readonly logger = new Logger(SubscriptionAccessService.name);

  constructor(
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<SubscriptionDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(StoreMember.name)
    private readonly memberModel: Model<StoreMemberDocument>,
    @InjectModel(StoreInvitation.name)
    private readonly invitationModel: Model<StoreInvitationDocument>,
    private readonly configService: ConfigService,
  ) {}

  isEnabled(): boolean {
    return this.configService.get<boolean>('subscriptions.enabled') === true;
  }

  isEnforcementEnabled(): boolean {
    return this.configService.get<boolean>('subscriptions.enforcementEnabled') === true;
  }

  /**
   * Team/POS/product-quota gating. This is deliberately independent of the broad rollout switch
   * so a live plan controls seats, POS and the product cap without also enforcing the order
   * quota. The broad switch always implies feature enforcement.
   */
  isFeatureEnforcementEnabled(): boolean {
    return (
      this.isEnforcementEnabled() ||
      this.configService.get<boolean>('subscriptions.featureEnforcementEnabled') === true
    );
  }


  async getSubscription(
    storeId: string,
    session?: ClientSession,
  ): Promise<SubscriptionDocument | null> {
    if (!storeId || !Types.ObjectId.isValid(storeId)) return null;
    const query = this.subscriptionModel.findOne({
      storeId: storeIdFilter(storeId) as unknown as Types.ObjectId,
    });
    if (session) query.session(session);
    return query.exec();
  }

  effectiveStatus(subscription: SubscriptionDocument | null): SubscriptionStatus | 'none' {
    if (!subscription) return 'none';
    return resolveEffectiveSubscriptionStatus(subscription);
  }

  /**
   * A missing subscription is only "entitled" while enforcement is off: with enforcement on we
   * fail closed (never silently grant unlimited access). The backfill means this should not be
   * reachable for a live store.
   */
  async getEntitlement(
    storeId: string,
    session?: ClientSession,
  ): Promise<SubscriptionEntitlement> {
    // Missing/corrupt records must fail closed whenever anything is enforced. With only the
    // feature gate on, orders/products stay permissive via `getCapabilities`, but team/POS
    // must not silently inherit unlimited access.
    const enforcement = this.isFeatureEnforcementEnabled();
    const subscription = await this.getSubscription(storeId, session);
    if (!subscription) {
      return {
        subscription: null,
        effectiveStatus: 'none',
        entitled: !enforcement,
        limits: UNLIMITED,
        features: enforcement ? { pos: false } : { pos: true },
      };
    }
    const effectiveStatus = resolveEffectiveSubscriptionStatus(subscription);
    // A corrupt/missing snapshot must fail closed for enforcement — never silent unlimited.
    const snapshot = subscription.planSnapshot;
    const snapshotValid = Boolean(
      snapshot &&
        typeof snapshot.name === 'string' &&
        snapshot.name.trim().length > 0 &&
        Number.isInteger(snapshot.durationDays) &&
        snapshot.durationDays >= 1 &&
        Number.isInteger(snapshot.planVersion) &&
        snapshot.limits &&
        typeof snapshot.limits === 'object' &&
        snapshot.features &&
        typeof snapshot.features === 'object',
    );
    const entitled =
      isSubscriptionEntitled(effectiveStatus) &&
      (!enforcement || snapshotValid);
    return {
      subscription,
      effectiveStatus,
      entitled,
      limits: { ...UNLIMITED, ...(subscription.planSnapshot?.limits ?? {}) },
      features: { pos: subscription.planSnapshot?.features?.pos ?? false },
    };
  }

  async getUsage(
    storeId: string,
    subscription?: SubscriptionDocument | null,
  ): Promise<SubscriptionUsage> {
    const sub = subscription ?? (await this.getSubscription(storeId));
    const filter = storeIdFilter(storeId) as unknown as Types.ObjectId;
    const now = new Date();

    const [activeProducts, activeMembers, ownerMembers, pendingInvitations] = await Promise.all([
      this.productModel
        .countDocuments({ storeId: filter, published: true, isArchived: { $ne: true } })
        .exec(),
      this.memberModel
        .countDocuments({ storeId: filter, status: StoreMemberStatus.ACTIVE })
        .exec(),
      this.memberModel
        .countDocuments({
          storeId: filter,
          status: StoreMemberStatus.ACTIVE,
          role: StoreRole.OWNER,
        })
        .exec(),
      this.invitationModel
        .countDocuments({
          storeId: filter,
          status: StoreInvitationStatus.PENDING,
          expiresAt: { $gt: now },
        })
        .exec(),
    ]);

    // Owner occupies one seat. Legacy stores may lack an Owner membership row, so count one.
    const teamSeats = activeMembers + (ownerMembers > 0 ? 0 : 1);
    const limits = { ...UNLIMITED, ...(sub?.planSnapshot?.limits ?? {}) };

    return {
      ordersUsed: sub?.usage?.ordersUsed ?? 0,
      ordersLimit: limits.maxOrders,
      activeProducts,
      productsLimit: limits.maxProducts,
      teamSeats,
      teamLimit: limits.maxTeamMembers,
      pendingInvitations,
    };
  }

  private isBelowLimit(used: number, limit: number | null): boolean {
    return limit === null || used < limit;
  }

  async getCapabilities(
    storeId: string,
    entitlement?: SubscriptionEntitlement,
    usage?: SubscriptionUsage,
  ): Promise<SubscriptionCapabilities> {
    const ent = entitlement ?? (await this.getEntitlement(storeId));
    const use = usage ?? (await this.getUsage(storeId, ent.subscription));
    const orderEnforcement = this.isEnforcementEnabled();
    const featureEnforcement = this.isFeatureEnforcementEnabled();
    const entitled = ent.entitled;

    // Order acceptance is the only quota on the broad rollout switch. Team, POS and product
    // creation/activation follow the feature gate (which the broad switch implies), so product
    // limits go live wherever team seats do.
    return {
      acceptingOrders:
        !orderEnforcement ||
        (entitled && this.isBelowLimit(use.ordersUsed, use.ordersLimit)),
      canUsePos:
        !featureEnforcement || (entitled && ent.features.pos === true),
      // Both product capabilities consult the same active-product cap. `canCreateProduct`
      // mirrors `canInviteTeam`: it is the seller-facing gate for the Add Product action, so a
      // store at its cap cannot start another product from the dashboard. ProductsService
      // enforces the same cap on create/duplicate/publish/restore and allows editing existing
      // products below it.
      canCreateProduct:
        !featureEnforcement ||
        (entitled && this.isBelowLimit(use.activeProducts, use.productsLimit)),
      canActivateProduct:
        !featureEnforcement ||
        (entitled && this.isBelowLimit(use.activeProducts, use.productsLimit)),
      canInviteTeam:
        !featureEnforcement ||
        (entitled &&
          this.isBelowLimit(use.teamSeats + use.pendingInvitations, use.teamLimit)),
    };
  }

  /** Full seller view: plan/status/dates + live usage + convenience booleans. */
  async getVendorSubscriptionView(storeId: string): Promise<Record<string, unknown>> {
    const entitlement = await this.getEntitlement(storeId);
    const usage = await this.getUsage(storeId, entitlement.subscription);
    const capabilities = await this.getCapabilities(storeId, entitlement, usage);
    const sub = entitlement.subscription;

    if (!sub) {
      return {
        storeId,
        subscription: null,
        usage,
        capabilities,
        enforcementEnabled: this.isEnforcementEnabled(),
        featureEnforcementEnabled: this.isFeatureEnforcementEnabled(),
      };
    }

    const now = new Date();
    const daysRemaining =
      sub.endDate === null || sub.endDate === undefined
        ? null
        : Math.max(0, Math.ceil((new Date(sub.endDate).getTime() - now.getTime()) / 86_400_000));

    return {
      storeId,
      subscription: {
        status: sub.status,
        effectiveStatus: entitlement.effectiveStatus,
        isTrial: Boolean(sub.isTrial),
        startDate: sub.startDate,
        endDate: sub.endDate ?? null,
        trialStartedAt: sub.trialStartedAt ?? null,
        trialEndsAt: sub.trialEndsAt ?? null,
        daysRemaining,
        plan: sub.planSnapshot,
      },
      usage,
      capabilities,
      enforcementEnabled: this.isEnforcementEnabled(),
      featureEnforcementEnabled: this.isFeatureEnforcementEnabled(),
    };
  }

  /**
   * Public projection. Only `acceptingOrders` + a minimal state leave the server — never plan
   * price, limits, admin actor or event history. While enforcement is off, ordering is never
   * blocked, so the flag stays true (flag-off no-op, plan §19.3).
   */
  async getPublicStates(
    storeIds: string[],
  ): Promise<Map<string, PublicSubscriptionState>> {
    const result = new Map<string, PublicSubscriptionState>();
    if (storeIds.length === 0) return result;

    const validIds = storeIds.filter((id) => Types.ObjectId.isValid(id));
    const objectIds = validIds.map((id) => new Types.ObjectId(id));
    const subs = await this.subscriptionModel
      .find({ storeId: { $in: [...objectIds, ...validIds] } })
      .exec();
    const byStore = new Map<string, SubscriptionDocument>();
    for (const sub of subs) byStore.set(String(sub.storeId), sub);

    const enforcement = this.isEnforcementEnabled();
    for (const storeId of storeIds) {
      const sub = byStore.get(storeId) ?? null;
      if (!sub) {
        result.set(storeId, {
          acceptingOrders: !enforcement,
          subscriptionState: 'none',
        });
        continue;
      }
      const effective = resolveEffectiveSubscriptionStatus(sub);
      const entitled = isSubscriptionEntitled(effective);
      const limit = sub.planSnapshot?.limits?.maxOrders ?? null;
      const used = sub.usage?.ordersUsed ?? 0;
      const capacity = limit === null || used < limit;
      result.set(storeId, {
        acceptingOrders: enforcement ? entitled && capacity : true,
        subscriptionState: effective,
      });
    }
    return result;
  }

  async getPublicState(storeId: string): Promise<PublicSubscriptionState> {
    const map = await this.getPublicStates([storeId]);
    return (
      map.get(storeId) ?? {
        acceptingOrders: !this.isEnforcementEnabled(),
        subscriptionState: 'none',
      }
    );
  }

  /** Phase 5 uses this single predicate for order acceptance. */
  async isAcceptingOrders(storeId: string): Promise<boolean> {
    const state = await this.getPublicState(storeId);
    return state.acceptingOrders;
  }

  /**
   * Atomically consume one order slot (plan §10.1.2). The conditional `$inc` checks the stored
   * status, the period and the limit in the same operation, so concurrent requests at
   * `limit - 1` cannot both succeed. A no-op while enforcement is off.
   *
   * Returns `true` when a slot was consumed so the caller knows to release it on failure.
   */
  async reserveOrderSlot(storeId: string, session?: ClientSession): Promise<boolean> {
    if (!this.isEnforcementEnabled()) return false;
    if (!storeId || !Types.ObjectId.isValid(storeId)) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_INACTIVE, { storeId });
    }

    const subscription = await this.getSubscription(storeId, session);
    if (!subscription) {
      throw new AppException(AppErrorCode.SUBSCRIPTION_INACTIVE, { storeId });
    }

    const now = new Date();
    const effective = resolveEffectiveSubscriptionStatus(subscription, now);
    if (!isSubscriptionEntitled(effective)) {
      this.logger.warn(
        `[subscriptions] order rejected: inactive store=${storeId} status=${effective}`,
      );
      throw new AppException(AppErrorCode.SUBSCRIPTION_INACTIVE, { storeId });
    }

    const limit = subscription.planSnapshot?.limits?.maxOrders ?? null;
    const filter: Record<string, unknown> = {
      _id: subscription._id,
      status: { $in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] },
      $or: [{ endDate: null }, { endDate: { $gt: now } }],
    };
    if (limit !== null) {
      filter.$expr = { $lt: ['$usage.ordersUsed', limit] };
    }

    const updated = await this.subscriptionModel
      .findOneAndUpdate(
        filter,
        { $inc: { 'usage.ordersUsed': 1 } },
        { new: true, session },
      )
      .exec();

    if (!updated) {
      // Distinguish "period ended / cancelled" from "quota exhausted" for the caller's copy.
      const current = await this.getSubscription(storeId, session);
      const currentEffective = current ? resolveEffectiveSubscriptionStatus(current, now) : 'none';
      if (!current || !isSubscriptionEntitled(currentEffective as SubscriptionStatus)) {
        throw new AppException(AppErrorCode.SUBSCRIPTION_INACTIVE, { storeId });
      }
      this.logger.warn(
        `[subscriptions] order rejected: limit reached store=${storeId} used=${current.usage?.ordersUsed ?? 0} limit=${limit}`,
      );
      throw new AppException(AppErrorCode.SUBSCRIPTION_ORDER_LIMIT_REACHED, {
        used: current.usage?.ordersUsed ?? 0,
        limit,
      });
    }
    return true;
  }

  /**
   * Compensate a reservation that never produced an order. The `$gt: 0` guard makes a double
   * release harmless. No-op while enforcement is off.
   */
  async releaseOrderSlot(storeId: string, session?: ClientSession): Promise<void> {
    if (!this.isEnforcementEnabled()) return;
    if (!storeId || !Types.ObjectId.isValid(storeId)) return;
    await this.subscriptionModel
      .updateOne(
        { storeId: storeIdFilter(storeId) as unknown as Types.ObjectId, 'usage.ordersUsed': { $gt: 0 } },
        { $inc: { 'usage.ordersUsed': -1 } },
        { session },
      )
      .exec();
  }
}




