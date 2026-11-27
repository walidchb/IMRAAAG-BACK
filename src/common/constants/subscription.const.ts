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

/**
 * How a plan's `price` is interpreted.
 * - `legacy`: the price is for one fixed period of `durationDays` (the pre-billing model).
 * - `monthly`: the price is the **monthly base price**; the plan stores a discount for each of
 *   the four globally supported durations (`1/3/6/12`) and the final price is always derived.
 */
export type BillingMode = 'legacy' | 'monthly';

export const SUBSCRIPTION_BILLING_MODES: BillingMode[] = ['legacy', 'monthly'];

/**
 * The only supported monthly purchase durations. Billing durations are a **global** platform
 * setting: every monthly plan offers the same subset, controlled once by the admin
 * (`subscriptionbillingconfigs`). Per-plan variation is limited to the discount percentage.
 * The 1-month duration always exists and cannot be disabled.
 */
export const SUPPORTED_BILLING_DURATIONS = [1, 3, 6, 12] as const;
export type SupportedBillingDuration = (typeof SUPPORTED_BILLING_DURATIONS)[number];

export const DEFAULT_ENABLED_BILLING_DURATIONS: SupportedBillingDuration[] = [1, 3, 6, 12];

export function isSupportedBillingDuration(value: unknown): value is SupportedBillingDuration {
  return (
    typeof value === 'number' &&
    (SUPPORTED_BILLING_DURATIONS as readonly number[]).includes(value)
  );
}

/**
 * Sanitise a duration list: keep only supported values, de-duplicate, sort ascending and always
 * re-add the mandatory 1-month duration. Pure — used by the config service and its DTO path.
 */
export function normalizeBillingDurationList(input: unknown): SupportedBillingDuration[] {
  const values = Array.isArray(input) ? input : [];
  const set = new Set<SupportedBillingDuration>([1]);
  for (const value of values) {
    const parsed = Number(value);
    if (isSupportedBillingDuration(parsed)) set.add(parsed);
  }
  return Array.from(set).sort((a, b) => a - b);
}

/** Where a snapshot's final price came from. `legacy`/`trial` never carry billing options. */
export type SubscriptionBillingPriceSource = 'calculated' | 'override' | 'legacy' | 'trial';

export const SUBSCRIPTION_BILLING_PRICE_SOURCES: SubscriptionBillingPriceSource[] = [
  'calculated',
  'override',
  'legacy',
  'trial',
];

/** Immutable purchase record: the duration/discount combination a subscription was sold at. */
export interface SubscriptionBillingSnapshot {
  /** Stored as a string so later option deletion/disablement cannot affect the purchase. */
  optionId: string | null;
  optionLabel?: string | null;
  durationMonths: number | null;
  /** Display/legacy mirror (`durationMonths * 30` when derived from options). */
  durationDays: number | null;
  /** Plan monthly base price at purchase time. */
  monthlyBasePrice: number;
  listPrice: number;
  discountPercent: number;
  priceOverride: number | null;
  finalPrice: number;
  savings: number;
  priceSource: SubscriptionBillingPriceSource;
  currency: 'DZD';
}

/**
 * The authoritative totals used for enforcement and display for THIS subscription.
 * `ordersAllowance` is the cumulative total for the whole purchased period (marked `null`
 * only when the plan's monthly base may be `null` for unlimited is *not* implied — see
 * `monthlyOrders`). Concurrent limits and features are never multiplied by duration.
 */
export interface SubscriptionEntitlementSnapshot {
  /** Plan monthly base order allowance (display + extension math). */
  monthlyOrders: number | null;
  /** Total order allowance for this subscription (`monthlyOrders × durationMonths`). */
  ordersAllowance: number | null;
  maxProducts: number | null;
  maxTeamMembers: number | null;
  features: SubscriptionFeatures;
  durationMonths: number | null;
}

/** Immutable commercial terms copied onto a subscription at assignment time. */
export interface SubscriptionPlanSnapshot {
  planVersion: number;
  name: string;
  /** Legacy single-language description (mirrors `descriptionEn` when present). */
  description?: string;
  descriptionEn?: string;
  descriptionFr?: string;
  descriptionAr?: string;
  price: number;
  currency: 'DZD';
  durationDays: number;
  limits: SubscriptionLimits;
  features: SubscriptionFeatures;
  trial: SubscriptionTrialConfig;
  /** Purchase record; absent on legacy snapshots. */
  billing?: SubscriptionBillingSnapshot | null;
  /** Authoritative entitlements; absent on legacy snapshots. */
  entitlements?: SubscriptionEntitlementSnapshot | null;
}

export interface EffectiveEntitlements {
  monthlyOrders: number | null;
  ordersAllowance: number | null;
  maxProducts: number | null;
  maxTeamMembers: number | null;
  features: SubscriptionFeatures;
  durationMonths: number | null;
  isLegacy: boolean;
}

function isValidNullableInt(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

/**
 * Top-level snapshot shape check. A malformed snapshot must fail closed whenever anything is
 * enforced; it is also the first input to the public order-acceptance composition.
 */
export function hasValidSubscriptionSnapshot(
  snapshot?: SubscriptionPlanSnapshot | null,
): boolean {
  return Boolean(
    snapshot &&
      typeof snapshot === 'object' &&
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
}

/**
 * Corruption rule: a malformed `entitlements` block is treated as absent so the resolver falls
 * back to the plan `limits` at 1× (never silently unlimited). If `limits` is also malformed the
 * existing snapshot-validity check fails closed while enforcement is on.
 */
function sanitizeEntitlements(
  ent: SubscriptionEntitlementSnapshot | null | undefined,
): SubscriptionEntitlementSnapshot | null {
  if (!ent || typeof ent !== 'object') return null;
  const valid =
    isValidNullableInt(ent.ordersAllowance) &&
    isValidNullableInt(ent.monthlyOrders) &&
    isValidNullableInt(ent.maxProducts) &&
    isValidNullableInt(ent.maxTeamMembers) &&
    (ent.durationMonths === null || Number.isInteger(ent.durationMonths)) &&
    Boolean(ent.features) &&
    typeof ent.features === 'object';
  return valid ? ent : null;
}

/**
 * Consistency check for a present `entitlements` block. A malformed block, or a finite monthly
 * base with no period allowance (which `effectiveEntitlements` would otherwise read as
 * unlimited), must fail closed while enforcement is on. A snapshot with **no** entitlement block
 * is a valid legacy snapshot and keeps its documented 1× `limits` fallback.
 *
 * Deliberately does **not** require `ordersAllowance === monthlyOrders × durationMonths`:
 * extensions legitimately add allowance.
 */
export function hasConsistentEntitlements(
  snapshot?: SubscriptionPlanSnapshot | null,
): boolean {
  const raw = snapshot?.entitlements ?? null;
  if (!raw) return true;
  const sanitized = sanitizeEntitlements(raw);
  if (!sanitized) return false;
  if (sanitized.monthlyOrders !== null && sanitized.ordersAllowance === null) return false;
  return true;
}

/**
 * Resolve the authoritative entitlements for a snapshot, falling back to the legacy plan
 * `limits` at **1×** when an `entitlements` block is absent (pre-billing subscriptions).
 * Concurrent limits and features are never multiplied. Must stay pure — every read path
 * (usage, capabilities, public states, admin/vendor views) consumes this helper so billing
 * and enforcement math lives in exactly one place.
 */
export function effectiveEntitlements(
  snapshot?: SubscriptionPlanSnapshot | null,
): EffectiveEntitlements {
  const limits: SubscriptionLimits =
    snapshot?.limits ?? { maxOrders: null, maxProducts: null, maxTeamMembers: null };
  const ent = sanitizeEntitlements(snapshot?.entitlements ?? null);
  const isLegacy = !ent;
  return {
    monthlyOrders: ent?.monthlyOrders ?? limits.maxOrders,
    // Legacy 1×: never retroactively multiply an existing allowance.
    ordersAllowance: ent?.ordersAllowance ?? limits.maxOrders,
    maxProducts: ent?.maxProducts ?? limits.maxProducts,
    maxTeamMembers: ent?.maxTeamMembers ?? limits.maxTeamMembers,
    features: ent?.features ?? snapshot?.features ?? { pos: false },
    durationMonths: ent?.durationMonths ?? null,
    isLegacy,
  };
}

/** The total order allowance used by the atomic reservation predicate. */
export function effectiveOrderAllowance(
  snapshot?: SubscriptionPlanSnapshot | null,
): number | null {
  return effectiveEntitlements(snapshot).ordersAllowance;
}

/** Minimal shape the effective-status derivation needs. */
export interface EffectiveStatusInput {
  status: SubscriptionStatus | string;
  /** `true` only for a **pure** trial (no paid period yet). */
  isTrial?: boolean;
  endDate?: Date | null;
  /**
   * End of an included trial. A subscription may carry a trial **before** a paid period, in
   * which case `isTrial` is `false` (it is a paid subscription) but `trialEndsAt` is set until
   * the trial window closes.
   */
  trialEndsAt?: Date | null;
}

/**
 * True while `now` is inside the trial window — either a pure trial (`isTrial`) or the trial
 * that precedes a paid period (`trialEndsAt`). A historical `trialEndsAt` means the window has
 * closed.
 */
export function isWithinTrial(
  input: { isTrial?: boolean; trialEndsAt?: Date | null },
  now: Date = new Date(),
): boolean {
  if (input.trialEndsAt) {
    return now.getTime() < new Date(input.trialEndsAt).getTime();
  }
  return Boolean(input.isTrial);
}

/**
 * Derive the effective status from the stored status + dates (§8.2).
 *
 * Date is authoritative: a stored `active`/`trialing` whose `endDate` has passed is effectively
 * `expired` without any cron. `cancelled` is terminal and never becomes `expired`.
 *
 * A subscription that started with a trial before its paid period is stored as `active` with
 * `trialEndsAt` set; it is effectively `trialing` until that date, then `active` with no write.
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
  if (isWithinTrial(input, now)) return SubscriptionStatus.TRIALING;
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

/**
 * Add calendar months in UTC, clamping the day to the last day of the target month
 * (Jan 31 + 1 month = Feb 28/29). Time-of-day is preserved. Algeria is UTC+1 year-round, so
 * UTC arithmetic has no DST edge.
 */
export function addMonthsUtc(start: Date, months: number): Date {
  if (!Number.isInteger(months) || months < 0) {
    throw new Error(`addMonthsUtc: months must be a non-negative integer (got ${months})`);
  }
  const result = new Date(start.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const daysInTarget = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, daysInTarget));
  return result;
}
