/**
 * Plans & Subscriptions (V1) — shared vocabulary.
 *
 * The subscription is a **separate entitlement state** from store availability. Expiry must
 * never write `Store.ownerStatus`, `Store.adminStatus` or `Store.status`, and it must never
 * delete business data. See `PLANS_AND_SUBSCRIPTIONS_IMPLEMENTATION_PLAN.md` §6.3/§11.1.
 */

/** Stored lifecycle status of one store's current subscription. */
export enum SubscriptionStatus {
  TRIALING = 'trialing',
  ACTIVE = 'active',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

export const SUBSCRIPTION_STATUS_VALUES: string[] = Object.values(SubscriptionStatus);

/** Statuses that grant entitlement while the current period has not ended. */
export const SUBSCRIPTION_ACTIVE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.ACTIVE,
];

/** How a subscription came to exist. */
export type SubscriptionSource =
  | 'admin_assigned'
  | 'admin_trial'
  | 'legacy_backfill'
  | 'signup_default';

/** The single commercial feature flag a plan can carry in V1. */
export type SubscriptionFeatureKey = 'pos';

/** Append-only audit action names recorded in `subscriptionevents`. */
export enum SubscriptionEventAction {
  ASSIGNED = 'assigned',
  TRIAL_GRANTED = 'trial_granted',
  PLAN_CHANGED = 'plan_changed',
  EXTENDED = 'extended',
  CANCELLED = 'cancelled',
  REACTIVATED = 'reactivated',
  EXPIRED_OBSERVED = 'expired_observed',
  PLAN_EDITED = 'plan_edited',
  PLAN_CREATED = 'plan_created',
  PLAN_UPDATED = 'plan_updated',
  PLAN_ACTIVATED = 'plan_activated',
  PLAN_DEACTIVATED = 'plan_deactivated',
  USAGE_RECONCILED = 'usage_reconciled',
}

export const SUBSCRIPTION_EVENT_ACTION_VALUES: string[] = Object.values(
  SubscriptionEventAction,
);

/** Actor of a subscription event. */
export type SubscriptionActorType = 'admin' | 'system';

/** A plan's numeric allowance. `null` means unlimited. */
export interface SubscriptionLimits {
  maxOrders: number | null;
  maxProducts: number | null;
  maxTeamMembers: number | null;
}

export interface SubscriptionFeatures {
  pos: boolean;
}

export interface SubscriptionTrialConfig {
  enabled: boolean;
  days: number | null;
}

/** Immutable commercial terms copied onto a subscription at assignment time. */
export interface SubscriptionPlanSnapshot {
  planVersion: number;
  name: string;
  description?: string;
  price: number;
  currency: 'DZD';
  durationDays: number;
  limits: SubscriptionLimits;
  features: SubscriptionFeatures;
  trial: SubscriptionTrialConfig;
}

/** Minimal shape the effective-status derivation needs. */
export interface EffectiveStatusInput {
  status: SubscriptionStatus | string;
  isTrial?: boolean;
  endDate?: Date | null;
}

/**
 * Derive the effective status from the stored status + dates (§8.2).
 *
 * Date is authoritative: a stored `active`/`trialing` whose `endDate` has passed is effectively
 * `expired` without any cron. `cancelled` is terminal and never becomes `expired`.
 */
export function resolveEffectiveSubscriptionStatus(
  input: EffectiveStatusInput,
  now: Date = new Date(),
): SubscriptionStatus {
  const stored = input.status as SubscriptionStatus;
  if (stored === SubscriptionStatus.CANCELLED) return SubscriptionStatus.CANCELLED;
  if (input.endDate && now.getTime() >= new Date(input.endDate).getTime()) {
    return SubscriptionStatus.EXPIRED;
  }
  if (stored === SubscriptionStatus.EXPIRED) return SubscriptionStatus.EXPIRED;
  if (input.isTrial) return SubscriptionStatus.TRIALING;
  return SubscriptionStatus.ACTIVE;
}

/** True when the effective status grants entitlement. */
export function isSubscriptionEntitled(status: SubscriptionStatus): boolean {
  return SUBSCRIPTION_ACTIVE_STATUSES.includes(status);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days remaining until `endDate`. `null` means perpetual (no end). A past date returns 0.
 * Ceil is used so "ends in 6h" reads as 1 day, matching the seller-facing warning thresholds.
 */
export function daysRemainingUntil(endDate: Date | null | undefined, now: Date = new Date()): number | null {
  if (!endDate) return null;
  const remaining = new Date(endDate).getTime() - now.getTime();
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / MS_PER_DAY);
}

/** Add whole days to a date, returning a new Date. */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}
