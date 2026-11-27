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
  daysRemainingUntil,
  effectiveEntitlements,
  effectiveOrderAllowance,
  hasConsistentEntitlements,
  hasValidSubscriptionSnapshot,
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
import { openTransactionSession } from '../inventory/services/session.util';

export interface SubscriptionUsage {
  ordersUsed: number;
  /** Total order allowance for the purchased period (semantic change from the old monthly base). */
  ordersLimit: number | null;
  ordersAllowance: number | null;
  ordersRemaining: number | null;
  ordersPercent: number | null;
  ordersMonthlyAllowance: number | null;
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
  /**
   * Whether the plan includes team management at all. A plan whose seat limit is `1` (or `0`)
   * covers only the Owner, so the team page is closed — distinct from `canInviteTeam`, which is
   * about free seats on a plan that does include a team.
   */
  canManageTeam: boolean;
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

/** Context handed to cap-sensitive writes inside the per-store serialization point. */
export interface StoreCapLockContext {
  /** `null` when feature enforcement is off or transactions are unavailable (dev fallback). */
  session: ClientSession | null;
  entitlement: SubscriptionEntitlement;
  usage: SubscriptionUsage;
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
    // A corrupt/missing/inconsistent snapshot must fail closed for enforcement — never silent
    // unlimited. Both helpers are shared with the public-state composition so the rules cannot
    // drift between the order writer and every display surface.
    const snapshot = subscription.planSnapshot;
    const snapshotValid =
      hasValidSubscriptionSnapshot(snapshot) && hasConsistentEntitlements(snapshot);
    const entitled =
      isSubscriptionEntitled(effectiveStatus) &&
      (!enforcement || snapshotValid);
    const effective = effectiveEntitlements(subscription.planSnapshot);
    return {
      subscription,
      effectiveStatus,
      entitled,
      limits: {
        maxOrders: effective.monthlyOrders,
        maxProducts: effective.maxProducts,
        maxTeamMembers: effective.maxTeamMembers,
      },
      features: effective.features,
    };
  }

  async getUsage(
    storeId: string,
    subscription?: SubscriptionDocument | null,
    session?: ClientSession,
  ): Promise<SubscriptionUsage> {
    const sub = subscription ?? (await this.getSubscription(storeId, session));
    const filter = storeIdFilter(storeId) as unknown as Types.ObjectId;
    const now = new Date();

    const count = (query: any) => {
      if (session) query.session(session);
      return query.exec();
    };

    const [activeProducts, activeMembers, ownerMembers, pendingInvitations] = await Promise.all([
      count(
        this.productModel.countDocuments({
          storeId: filter,
          published: true,
          isArchived: { $ne: true },
        }),
      ),
      count(this.memberModel.countDocuments({ storeId: filter, status: StoreMemberStatus.ACTIVE })),
      count(
        this.memberModel.countDocuments({
          storeId: filter,
          status: StoreMemberStatus.ACTIVE,
          role: StoreRole.OWNER,
        }),
      ),
      count(
        this.invitationModel.countDocuments({
          storeId: filter,
          status: StoreInvitationStatus.PENDING,
          expiresAt: { $gt: now },
        }),
      ),
    ]);

    // Owner occupies one seat. Legacy stores may lack an Owner membership row, so count one.
    const teamSeats = activeMembers + (ownerMembers > 0 ? 0 : 1);
    const effective = effectiveEntitlements(sub?.planSnapshot ?? null);
    const ordersUsed = sub?.usage?.ordersUsed ?? 0;
    const ordersAllowance = effective.ordersAllowance;
    const ordersRemaining =
      ordersAllowance === null ? null : Math.max(0, ordersAllowance - ordersUsed);
    const ordersPercent =
      ordersAllowance === null
        ? null
        : ordersAllowance <= 0
          ? ordersUsed > 0
            ? 100
            : 0
          : Math.min(100, Math.floor((ordersUsed / ordersAllowance) * 100));

    return {
      ordersUsed,
      ordersLimit: ordersAllowance,
      ordersAllowance,
      ordersRemaining,
      ordersPercent,
      ordersMonthlyAllowance: effective.monthlyOrders,
      activeProducts,
      productsLimit: effective.maxProducts,
      teamSeats,
      teamLimit: effective.maxTeamMembers,
      pendingInvitations,
    };
  }

  /**
   * Serialize a cap-sensitive read-count-then-write across API instances.
   *
   * A conditional `$inc` on the store's subscription row (`usage.capVersion`) forces a write
   * conflict between concurrent cap operations, so the count and the caller's write commit in
   * one transaction. Live counts remain authoritative; `capVersion` is only a lock version.
   *
   * With feature enforcement off this runs the work directly (session `null`) — the caps are not
   * enforced anyway. On a single-node datastore without transactions it logs once and falls back
   * to the previous check-then-act behaviour (development only).
   */
  async withStoreCapLock<T>(
    storeId: string,
    work: (ctx: StoreCapLockContext) => Promise<T>,
  ): Promise<T> {
    if (!storeId || !this.isFeatureEnforcementEnabled()) {
      const entitlement = await this.getEntitlement(storeId);
      const usage = await this.getUsage(storeId, entitlement.subscription);
      return work({ session: null, entitlement, usage });
    }

    let session: ClientSession;
    try {
      session = await openTransactionSession(this.subscriptionModel, this.logger);
    } catch (err) {
      if (
        err instanceof AppException &&
        err.errorCode === AppErrorCode.INVALID_COMBINATION
      ) {
        this.logger.warn(
          '[subscriptions] transactions unavailable; cap-sensitive write falls back to ' +
            'check-then-act (development only).',
        );
        const entitlement = await this.getEntitlement(storeId);
        const usage = await this.getUsage(storeId, entitlement.subscription);
        return work({ session: null, entitlement, usage });
      }
      throw err;
    }

    try {
      let result!: T;
      await session.withTransaction(async () => {
        const bumped = await this.subscriptionModel
          .findOneAndUpdate(
            { storeId: storeIdFilter(storeId) as unknown as Types.ObjectId },
            { $inc: { 'usage.capVersion': 1 } },
            { new: true, session },
          )
          .exec();
        if (!bumped) {
          throw new AppException(AppErrorCode.SUBSCRIPTION_INACTIVE, { storeId });
        }
        const entitlement = await this.getEntitlement(storeId, session);
        if (!entitlement.entitled) {
          throw new AppException(AppErrorCode.SUBSCRIPTION_INACTIVE, { storeId });
        }
        const usage = await this.getUsage(storeId, entitlement.subscription, session);
        result = await work({ session, entitlement, usage });
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  private isBelowLimit(used: number, limit: number | null): boolean {
    return limit === null || used < limit;
  }

  /**
   * The single order-acceptance rule used by vendor capabilities, public state and the order
   * writer's pre-check:
   * - feature enforcement off -> orders open (flag-off no-op);
   * - feature enforcement on -> requires an entitled subscription with a valid/inconsistent-free
   *   snapshot (the same rule `assertOrderCreationEntitled` enforces);
   * - broad enforcement on -> additionally requires capacity under the period order allowance.
   */
  async getOrderAcceptance(
    storeId: string,
    entitlement?: SubscriptionEntitlement,
    usage?: SubscriptionUsage,
  ): Promise<boolean> {
    if (!this.isFeatureEnforcementEnabled()) return true;
    const ent = entitlement ?? (await this.getEntitlement(storeId));
    if (!ent.entitled) return false;
    if (!this.isEnforcementEnabled()) return true;
    const use = usage ?? (await this.getUsage(storeId, ent.subscription));
    return this.isBelowLimit(use.ordersUsed, use.ordersAllowance);
  }

  async getCapabilities(
    storeId: string,
    entitlement?: SubscriptionEntitlement,
    usage?: SubscriptionUsage,
  ): Promise<SubscriptionCapabilities> {
    const ent = entitlement ?? (await this.getEntitlement(storeId));
    const use = usage ?? (await this.getUsage(storeId, ent.subscription));
    const featureEnforcement = this.isFeatureEnforcementEnabled();
    const broadEnforcement = this.isEnforcementEnabled();
    const entitled = ent.entitled;

    // Order acceptance follows the feature gate (matching `assertOrderCreationEntitled`) and,
    // when the broad rollout is on, the period quota. Team, POS and product
    // creation/activation follow the feature gate, so product limits go live wherever team
    // seats do.
    const acceptingOrders =
      !featureEnforcement ||
      (entitled &&
        (!broadEnforcement || this.isBelowLimit(use.ordersUsed, use.ordersAllowance)));

    return {
      acceptingOrders,
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
      // A one-seat plan (the Owner only) does not include team management, so the team page is
      // unavailable even though the Owner occupies that single seat. `null` stays unlimited.
      // This is a plan-shape fact, not an entitlement fact: an expired subscription keeps the
      // page viewable (invites stay blocked by `canInviteTeam`), matching the existing rule that
      // an inactive subscription never hides the store's data.
      canManageTeam: !featureEnforcement || use.teamLimit === null || use.teamLimit > 1,
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
    const daysRemaining = daysRemainingUntil(sub.endDate, now);
    const trialDaysRemaining =
      entitlement.effectiveStatus === SubscriptionStatus.TRIALING
        ? daysRemainingUntil(sub.trialEndsAt ?? null, now)
        : null;

    return {
      storeId,
      subscription: {
        status: sub.status,
        effectiveStatus: entitlement.effectiveStatus,
        isTrial: Boolean(sub.isTrial),
        inTrial: entitlement.effectiveStatus === SubscriptionStatus.TRIALING,
        startDate: sub.startDate,
        endDate: sub.endDate ?? null,
        trialStartedAt: sub.trialStartedAt ?? null,
        trialEndsAt: sub.trialEndsAt ?? null,
        daysRemaining,
        trialDaysRemaining,
        plan: sub.planSnapshot,
        billing: sub.planSnapshot?.billing ?? null,
        entitlements: effectiveEntitlements(sub.planSnapshot),
      },
      usage,
      capabilities,
      enforcementEnabled: this.isEnforcementEnabled(),
      featureEnforcementEnabled: this.isFeatureEnforcementEnabled(),
    };
  }

  /**
   * Public projection. Only `acceptingOrders` + a minimal state leave the server — never plan
   * price, limits, admin actor or event history. It uses the same feature-gate + snapshot
   * validity rule as order creation, plus the period quota when the broad rollout is on. While
   * all enforcement is off, ordering is never blocked, so the flag stays true (flag-off no-op).
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

    const featureEnforcement = this.isFeatureEnforcementEnabled();
    const broadEnforcement = this.isEnforcementEnabled();
    for (const storeId of storeIds) {
      const sub = byStore.get(storeId) ?? null;
      if (!sub) {
        result.set(storeId, {
          acceptingOrders: !featureEnforcement,
          subscriptionState: 'none',
        });
        continue;
      }
      const effective = resolveEffectiveSubscriptionStatus(sub);
      const snapshotValid =
        hasValidSubscriptionSnapshot(sub.planSnapshot) &&
        hasConsistentEntitlements(sub.planSnapshot);
      const entitled =
        isSubscriptionEntitled(effective) && (!featureEnforcement || snapshotValid);
      const limit = effectiveOrderAllowance(sub.planSnapshot);
      const used = sub.usage?.ordersUsed ?? 0;
      const capacity = !broadEnforcement || this.isBelowLimit(used, limit);
      result.set(storeId, {
        acceptingOrders: !featureEnforcement || (entitled && capacity),
        subscriptionState: effective,
      });
    }
    return result;
  }

  async getPublicState(storeId: string): Promise<PublicSubscriptionState> {
    const map = await this.getPublicStates([storeId]);
    return (
      map.get(storeId) ?? {
        acceptingOrders: !this.isFeatureEnforcementEnabled(),
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

    const limit = effectiveOrderAllowance(subscription.planSnapshot);
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




