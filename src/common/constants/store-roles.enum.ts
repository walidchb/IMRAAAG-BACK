/**
 * Store-level roles (Team Management).
 *
 * These are deliberately separate from the platform `Role` enum: an employee is a platform
 * `VENDOR` (`User.role`), and this enum says what they may do inside their store. `PARTNER`
 * is the store-level "Partner / Admin" and must not be confused with platform `Role.ADMIN`.
 *
 * `OWNER` is never assignable through the API; it is the projection of `Store.vendorId`.
 */
export enum StoreRole {
  OWNER = 'OWNER',
  PARTNER = 'PARTNER',
  ORDER_CONFIRMER = 'ORDER_CONFIRMER',
  INVENTORY_STAFF = 'INVENTORY_STAFF',
  CASHIER = 'CASHIER',
}

export enum StoreMemberStatus {
  ACTIVE = 'active',
  DEACTIVATED = 'deactivated',
}

export enum StoreInvitationStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  REVOKED = 'revoked',
}

/** Roles an Owner/Partner may assign. `OWNER` is intentionally absent. */
export const ASSIGNABLE_STORE_ROLES: StoreRole[] = [
  StoreRole.PARTNER,
  StoreRole.ORDER_CONFIRMER,
  StoreRole.INVENTORY_STAFF,
  StoreRole.CASHIER,
];
