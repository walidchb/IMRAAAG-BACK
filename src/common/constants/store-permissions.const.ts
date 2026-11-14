import { StoreRole } from './store-roles.enum';

/**
 * The store permission catalogue.
 *
 * Permissions are strings so a caller can assert a single dotted capability and the frontend
 * can mirror the same literal. The Owner receives `['*']`; every other role is resolved through
 * `STORE_ROLE_PERMISSIONS`.
 */
export const StorePermission = {
  DASHBOARD_VIEW: 'dashboard.view',

  STORE_VIEW: 'store.view',
  STORE_UPDATE: 'store.update',
  STORE_TOGGLE_STATUS: 'store.toggle_status',
  STORE_CREATE: 'store.create',

  /** Opens the Products and Categories management pages. */
  PRODUCTS_VIEW: 'products.view',
  /**
   * Reads the store's catalogue (product list, variant matrix/options, category tree) without
   * opening the management pages. Order staff need it to compose order lines; it must not grant
   * the Products/Categories screens.
   */
  PRODUCTS_BROWSE: 'products.browse',
  PRODUCTS_CREATE: 'products.create',
  PRODUCTS_UPDATE: 'products.update',
  PRODUCTS_DELETE: 'products.delete',
  PRODUCTS_DUPLICATE: 'products.duplicate',
  PRODUCTS_CATEGORIES_MANAGE: 'products.categories.manage',
  PRODUCTS_VARIANTS_MANAGE: 'products.variants.manage',
  PRODUCTS_BARCODES_GENERATE: 'products.barcodes.generate',

  ORDERS_VIEW: 'orders.view',
  ORDERS_CREATE: 'orders.create',
  ORDERS_UPDATE: 'orders.update',
  ORDERS_CONFIRM: 'orders.confirm',
  ORDERS_CANCEL: 'orders.cancel',
  ORDERS_DISPATCH: 'orders.dispatch',
  ORDERS_UPDATE_STATUS: 'orders.update_status',
  ORDERS_DELETE: 'orders.delete',
  ORDERS_ARCHIVE: 'orders.archive',
  ORDERS_RETURNS_RECEIVE: 'orders.returns.receive',
  ORDERS_INVENTORY_VIEW: 'orders.inventory.view',
  ORDERS_LABELS_GENERATE: 'orders.labels.generate',
  ORDERS_DELIVERY_STATUS_VIEW: 'orders.delivery_status.view',
  ORDERS_DELIVERY_STATUS_REFRESH: 'orders.delivery_status.refresh',

  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_ADJUST: 'inventory.adjust',
  INVENTORY_BULK_ADJUST: 'inventory.bulk_adjust',
  INVENTORY_MOVEMENTS_VIEW: 'inventory.movements.view',
  INVENTORY_THRESHOLD_UPDATE: 'inventory.threshold.update',

  POS_ACCESS: 'pos.access',
  POS_CREATE_SALE: 'pos.create_sale',
  POS_MANAGE_HOLDS: 'pos.manage_holds',

  DELIVERY_VIEW: 'delivery.view',
  DELIVERY_CONFIGURE: 'delivery.configure',
  DELIVERY_ATTRIBUTIONS_UPDATE: 'delivery.attributions.update',
  DELIVERY_SYNC: 'delivery.sync',
  DELIVERY_FEES_VIEW: 'delivery.fees.view',
  DELIVERY_FEES_UPDATE: 'delivery.fees.update',

  TRACKING_VIEW: 'tracking.view',
  TRACKING_UPDATE: 'tracking.update',

  TEAM_VIEW: 'team.view',
  TEAM_INVITE: 'team.invite',
  TEAM_RESEND_INVITATION: 'team.resend_invitation',
  TEAM_REVOKE_INVITATION: 'team.revoke_invitation',
  TEAM_UPDATE_ROLE: 'team.update_role',
  TEAM_DEACTIVATE: 'team.deactivate',
  TEAM_REACTIVATE: 'team.reactivate',
  TEAM_REMOVE: 'team.remove',
  /** Owner-only, never assignable. */
  TEAM_MANAGE_OWNER: 'team.manage_owner',
} as const;

export type StorePermission = (typeof StorePermission)[keyof typeof StorePermission];

export const WILDCARD_PERMISSION = '*';

const ALL_PERMISSIONS: StorePermission[] = Object.values(StorePermission);

/**
 * Role → permission matrix (implementation plan § 4.3).
 *
 * `OWNER` is not listed: it is resolved as `['*']` (all permissions, present and future) and
 * is never stored in this map.
 *
 * Two conservative decisions from the unresolved list:
 *  - `products.delete` is Owner/Partner only.
 *  - `products.categories.manage` is Owner/Partner/Inventory Staff.
 */
export const STORE_ROLE_PERMISSIONS: Record<Exclude<StoreRole, StoreRole.OWNER>, string[]> = {
  [StoreRole.PARTNER]: ALL_PERMISSIONS.filter(
    (permission) =>
      permission !== StorePermission.STORE_CREATE &&
      permission !== StorePermission.TEAM_MANAGE_OWNER,
  ),

  [StoreRole.ORDER_CONFIRMER]: [
    StorePermission.STORE_VIEW,
    // Read-only catalogue data for the order-line picker. Deliberately NOT `products.view`:
    // this role works from the Orders page only and must never open Products/Categories.
    StorePermission.PRODUCTS_BROWSE,
    StorePermission.ORDERS_VIEW,
    StorePermission.ORDERS_CREATE,
    StorePermission.ORDERS_UPDATE,
    StorePermission.ORDERS_CONFIRM,
    StorePermission.ORDERS_CANCEL,
    StorePermission.ORDERS_DISPATCH,
    StorePermission.ORDERS_UPDATE_STATUS,
    StorePermission.ORDERS_ARCHIVE,
    StorePermission.ORDERS_LABELS_GENERATE,
    StorePermission.ORDERS_DELIVERY_STATUS_VIEW,
    StorePermission.ORDERS_DELIVERY_STATUS_REFRESH,
    // Read-only delivery options are required to create/dispatch an order: the enabled
    // companies, the wilaya attributions, the shipping fees and the DHD/Noest communes.
    // These are reads only — `delivery.configure` / `delivery.attributions.update` /
    // `delivery.sync` stay Owner/Partner-only.
    StorePermission.DELIVERY_VIEW,
    StorePermission.DELIVERY_FEES_VIEW,
  ],

  [StoreRole.INVENTORY_STAFF]: [
    StorePermission.STORE_VIEW,
    // `products.view` opens the management pages; `products.browse` backs their read endpoints.
    StorePermission.PRODUCTS_VIEW,
    StorePermission.PRODUCTS_BROWSE,
    StorePermission.PRODUCTS_CREATE,
    StorePermission.PRODUCTS_UPDATE,
    StorePermission.PRODUCTS_DUPLICATE,
    StorePermission.PRODUCTS_CATEGORIES_MANAGE,
    StorePermission.PRODUCTS_VARIANTS_MANAGE,
    StorePermission.PRODUCTS_BARCODES_GENERATE,
    // `orders.view` only, so the return-receipt screen can open an order; no order mutation.
    StorePermission.ORDERS_VIEW,
    StorePermission.ORDERS_RETURNS_RECEIVE,
    StorePermission.ORDERS_INVENTORY_VIEW,
    StorePermission.INVENTORY_VIEW,
    StorePermission.INVENTORY_ADJUST,
    StorePermission.INVENTORY_BULK_ADJUST,
    StorePermission.INVENTORY_MOVEMENTS_VIEW,
    StorePermission.INVENTORY_THRESHOLD_UPDATE,
    // The orders page and the return dialog read the store's delivery options (company names,
    // shipping fee). Read-only; writes remain Owner/Partner-only.
    StorePermission.DELIVERY_VIEW,
    StorePermission.DELIVERY_FEES_VIEW,
  ],

  [StoreRole.CASHIER]: [
    // The register's shell reads the store identity (name/logo); POS itself needs no delivery
    // or order capability.
    StorePermission.STORE_VIEW,
    StorePermission.POS_ACCESS,
    StorePermission.POS_CREATE_SALE,
    StorePermission.POS_MANAGE_HOLDS,
  ],
};

/**
 * Resolves the effective permissions for a membership.
 *
 * `permissionOverrides` is the frozen extension point for future custom roles: a non-empty
 * array replaces the role map; empty (the MVP default) uses `STORE_ROLE_PERMISSIONS`.
 */
export function permissionsForRole(
  role: StoreRole | null | undefined,
  overrides?: string[] | null,
): string[] {
  if (role === StoreRole.OWNER) return [WILDCARD_PERMISSION];
  if (Array.isArray(overrides) && overrides.length > 0) return [...overrides];
  if (!role) return [];
  return [...(STORE_ROLE_PERMISSIONS[role] ?? [])];
}

/** True when `permissions` contains `permission` or the wildcard. */
export function hasStorePermission(
  permissions: string[] | null | undefined,
  permission: string,
): boolean {
  if (!Array.isArray(permissions)) return false;
  return (
    permissions.includes(WILDCARD_PERMISSION) || permissions.includes(permission)
  );
}
