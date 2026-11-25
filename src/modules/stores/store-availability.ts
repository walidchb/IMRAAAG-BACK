import {
  StoreAdminStatus,
  StoreOwnerStatus,
  StoreStatus,
} from './schemas/store-status.enum';

/**
 * The minimum shape needed to evaluate a store's public availability. This intentionally
 * accepts plain/lean objects and Mongoose documents alike.
 */
export interface StoreAvailabilitySource {
  status?: StoreStatus | string | null;
  ownerStatus?: StoreOwnerStatus | string | null;
  adminStatus?: StoreAdminStatus | string | null;
}

export interface StoreAvailability {
  ownerStatus: StoreOwnerStatus;
  adminStatus: StoreAdminStatus;
  /** Both independent decisions allow the store to operate. */
  available: boolean;
  /** Which side blocks availability, if any. `null` when the store is available. */
  blockedBy: 'owner' | 'admin' | null;
}

const OWNER_VALUES = new Set<string>(Object.values(StoreOwnerStatus));
const ADMIN_VALUES = new Set<string>(Object.values(StoreAdminStatus));

/**
 * Resolve the owner-controlled status.
 *
 * Legacy rows only carry `status`:
 * - `Paused` was the seller's own switch, so it maps to Disabled.
 * - `Closed` was a platform-level closure, so its owner side is Enabled; only the admin
 *   side (`adminStatus: Suspended`) blocks it. This preserves the old admin "Activate"
 *   behaviour: reactivating a closed store makes it available again.
 * - `Active` (and a missing/unknown value) maps to Enabled so a schema rollout can never
 *   accidentally disable an existing store.
 */
export function resolveOwnerStatus(source: StoreAvailabilitySource): StoreOwnerStatus {
  const raw = typeof source.ownerStatus === 'string' ? source.ownerStatus : null;
  if (raw && OWNER_VALUES.has(raw)) return raw as StoreOwnerStatus;

  const legacy = typeof source.status === 'string' ? source.status : null;
  return legacy === StoreStatus.PAUSED
    ? StoreOwnerStatus.DISABLED
    : StoreOwnerStatus.ENABLED;
}

/**
 * Resolve the admin-controlled status.
 *
 * Only the legacy `Closed` state represented a platform-level closure. `Paused` was the
 * seller's own choice, so it must not become an admin suspension during the transition.
 */
export function resolveAdminStatus(source: StoreAvailabilitySource): StoreAdminStatus {
  const raw = typeof source.adminStatus === 'string' ? source.adminStatus : null;
  if (raw && ADMIN_VALUES.has(raw)) return raw as StoreAdminStatus;

  const legacy = typeof source.status === 'string' ? source.status : null;
  return legacy === StoreStatus.CLOSED
    ? StoreAdminStatus.SUSPENDED
    : StoreAdminStatus.ACTIVE;
}

/**
 * The legacy `status` mirror. It is derived, never authoritative.
 *
 * Admin suspension wins over an owner disable so the public/vendor UI can always explain
 * the stronger, platform-level block. The actual availability decision still ANDs both
 * fields (see `evaluateStoreAvailability`).
 */
export function deriveStoreStatus(
  ownerStatus: StoreOwnerStatus,
  adminStatus: StoreAdminStatus,
): StoreStatus {
  if (adminStatus === StoreAdminStatus.SUSPENDED) return StoreStatus.CLOSED;
  if (ownerStatus === StoreOwnerStatus.DISABLED) return StoreStatus.PAUSED;
  return StoreStatus.ACTIVE;
}

/**
 * The single availability rule for every backend consumer.
 *
 * **Do NOT fold subscription state into this function.** Store availability answers "may this
 * store be accessed/shown at all?" (owner decision + platform decision). Subscription answers
 * "which commercial operations is this store entitled to?" — a *separate* entitlement state
 * resolved by `SubscriptionAccessService`. Adding expiry here would make an expired store render
 * `StoreDisabledView`, hide the storefront like an admin suspension, and conflate commercial
 * status with operational status. Subscription expiry must never be written into
 * `adminStatus`, `ownerStatus`, or the legacy `status` mirror. See
 * `PLANS_AND_SUBSCRIPTIONS_IMPLEMENTATION_PLAN.md` §3.2/§6.3/§11.1.
 */
export function evaluateStoreAvailability(
  source: StoreAvailabilitySource,
): StoreAvailability {
  const ownerStatus = resolveOwnerStatus(source);
  const adminStatus = resolveAdminStatus(source);
  const adminBlocked = adminStatus !== StoreAdminStatus.ACTIVE;
  const ownerBlocked = ownerStatus !== StoreOwnerStatus.ENABLED;

  return {
    ownerStatus,
    adminStatus,
    available: !adminBlocked && !ownerBlocked,
    blockedBy: adminBlocked ? 'admin' : ownerBlocked ? 'owner' : null,
  };
}

export function isStoreAvailable(source: StoreAvailabilitySource): boolean {
  return evaluateStoreAvailability(source).available;
}

/**
 * MongoDB filter for an available store.
 *
 * The legacy `status` clause keeps pre-migration rows correct; the `$ne` clauses make the
 * filter resilient if a document only has the new fields. Both `$ne` clauses also match a
 * missing field, so existing data never disappears during the rollout.
 */
export function availableStoreFilter(): Record<string, unknown> {
  return {
    status: StoreStatus.ACTIVE,
    ownerStatus: { $ne: StoreOwnerStatus.DISABLED },
    adminStatus: { $ne: StoreAdminStatus.SUSPENDED },
  };
}

