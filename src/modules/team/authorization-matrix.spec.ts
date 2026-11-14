import { PERMISSIONS_KEY } from './decorators/require-permissions.decorator';
import {
  permissionsForRole,
  hasStorePermission,
  StorePermission,
} from '../../common/constants/store-permissions.const';
import { StoreRole } from '../../common/constants/store-roles.enum';
import { OrdersController } from '../orders/orders.controller';
import { ProductsController } from '../products/products.controller';
import { InventoryController } from '../inventory/inventory.controller';
import { VariantsController } from '../inventory/variants.controller';
import { PosController } from '../pos/pos.controller';
import { TeamController } from './team.controller';
import { DeliveryController } from '../delivery/delivery.controller';
import { DeliveryFeesController } from '../delivery-fees/delivery-fees.controller';
import { DeliveryStatusController } from '../delivery/delivery-status/delivery-status.controller';
import { TrackingController } from '../tracking/tracking.controller';
import { UploadController } from '../upload/upload.controller';
import { StoresController } from '../stores/stores.controller';
import { AnalyticsController } from '../analytics/analytics.controller';
import { CategoriesController } from '../categories/categories.controller';
import { OrderLabelsController } from '../order-labels/order-labels.controller';

/** Handler metadata wins over class metadata, mirroring `PermissionsGuard`. */
function permissionsOf(controller: any, method: string): string[] | undefined {
  return (
    Reflect.getMetadata(PERMISSIONS_KEY, controller.prototype[method]) ??
    Reflect.getMetadata(PERMISSIONS_KEY, controller)
  );
}

describe('Authorization matrix — route wiring', () => {
  const expectations: Array<[any, string, string[] | undefined]> = [
    [OrdersController, 'createVendor', [StorePermission.ORDERS_CREATE]],
    [OrdersController, 'updateVendor', [StorePermission.ORDERS_UPDATE]],
    [OrdersController, 'findAll', [StorePermission.ORDERS_VIEW]],
    [OrdersController, 'findOne', [StorePermission.ORDERS_VIEW]],
    [OrdersController, 'update', [StorePermission.ORDERS_UPDATE]],
    [OrdersController, 'remove', [StorePermission.ORDERS_DELETE]],
    [OrdersController, 'archive', [StorePermission.ORDERS_ARCHIVE]],
    [OrdersController, 'restore', [StorePermission.ORDERS_ARCHIVE]],
    [OrdersController, 'bulkAction', [StorePermission.ORDERS_VIEW]],
    [OrdersController, 'bulkShip', [StorePermission.ORDERS_DISPATCH]],
    [OrdersController, 'getOrderInventory', [StorePermission.ORDERS_INVENTORY_VIEW]],
    [OrdersController, 'receiveReturn', [StorePermission.ORDERS_RETURNS_RECEIVE]],

    [ProductsController, 'create', [StorePermission.PRODUCTS_CREATE]],
    [ProductsController, 'findVendorProducts', [StorePermission.PRODUCTS_BROWSE]],
    [ProductsController, 'searchSuggestions', [StorePermission.PRODUCTS_BROWSE]],
    [ProductsController, 'update', [StorePermission.PRODUCTS_UPDATE]],
    [ProductsController, 'remove', [StorePermission.PRODUCTS_DELETE]],
    [ProductsController, 'duplicate', [StorePermission.PRODUCTS_DUPLICATE]],

    [InventoryController, 'listInventory', [StorePermission.INVENTORY_VIEW]],
    [InventoryController, 'getInventoryStats', [StorePermission.INVENTORY_VIEW]],
    [InventoryController, 'setOnHand', [StorePermission.INVENTORY_ADJUST]],
    [InventoryController, 'adjust', [StorePermission.INVENTORY_ADJUST]],
    [InventoryController, 'bulkAdjust', [StorePermission.INVENTORY_BULK_ADJUST]],
    [InventoryController, 'listMovements', [StorePermission.INVENTORY_MOVEMENTS_VIEW]],
    [InventoryController, 'listStoreMovements', [StorePermission.INVENTORY_MOVEMENTS_VIEW]],
    [InventoryController, 'setThreshold', [StorePermission.INVENTORY_THRESHOLD_UPDATE]],

    [VariantsController, 'matrix', [StorePermission.PRODUCTS_BROWSE]],
    [VariantsController, 'options', [StorePermission.PRODUCTS_BROWSE]],
    [VariantsController, 'createOption', [StorePermission.PRODUCTS_VARIANTS_MANAGE]],
    [VariantsController, 'generateCodes', [StorePermission.PRODUCTS_BARCODES_GENERATE]],

    [PosController, 'search', [StorePermission.POS_ACCESS]],
    [PosController, 'createSale', [StorePermission.POS_CREATE_SALE]],
    [PosController, 'createHold', [StorePermission.POS_MANAGE_HOLDS]],
    [
      PosController,
      'completeHold',
      [StorePermission.POS_MANAGE_HOLDS, StorePermission.POS_CREATE_SALE],
    ],

    [TeamController, 'members', [StorePermission.TEAM_VIEW]],
    [TeamController, 'invite', [StorePermission.TEAM_INVITE]],
    [TeamController, 'resend', [StorePermission.TEAM_RESEND_INVITATION]],
    [TeamController, 'revoke', [StorePermission.TEAM_REVOKE_INVITATION]],
    [TeamController, 'removeMember', [StorePermission.TEAM_REMOVE]],

    [DeliveryController, 'getConfigs', [StorePermission.DELIVERY_VIEW]],
    [DeliveryController, 'saveConfig', [StorePermission.DELIVERY_CONFIGURE]],
    [DeliveryController, 'saveAttributions', [StorePermission.DELIVERY_ATTRIBUTIONS_UPDATE]],
    [DeliveryController, 'syncNoestDesks', [StorePermission.DELIVERY_SYNC]],
    [DeliveryFeesController, 'getFees', [StorePermission.DELIVERY_FEES_VIEW]],
    [DeliveryFeesController, 'updateFee', [StorePermission.DELIVERY_FEES_UPDATE]],
    [DeliveryFeesController, 'seed', [StorePermission.DELIVERY_FEES_UPDATE]],

    [DeliveryStatusController, 'getOrderStatus', [StorePermission.ORDERS_DELIVERY_STATUS_VIEW]],
    [DeliveryStatusController, 'getParcelStatus', [StorePermission.ORDERS_DELIVERY_STATUS_VIEW]],
    [DeliveryStatusController, 'getSyncHealth', [StorePermission.DELIVERY_VIEW]],
    [DeliveryStatusController, 'refreshParcel', [StorePermission.ORDERS_DELIVERY_STATUS_REFRESH]],

    [TrackingController, 'getConfig', [StorePermission.TRACKING_VIEW]],
    [TrackingController, 'updateConfig', [StorePermission.TRACKING_UPDATE]],
    [TrackingController, 'testConfig', [StorePermission.TRACKING_UPDATE]],

    [UploadController, 'uploadProductImage', [StorePermission.PRODUCTS_UPDATE]],
    [UploadController, 'uploadStoreLogo', [StorePermission.STORE_UPDATE]],
    [UploadController, 'uploadCategoryImage', [StorePermission.PRODUCTS_CATEGORIES_MANAGE]],
    [UploadController, 'deleteFile', undefined],

    [StoresController, 'findMine', [StorePermission.STORE_VIEW]],
    [StoresController, 'updateMine', [StorePermission.STORE_UPDATE]],
    [StoresController, 'toggleStatus', [StorePermission.STORE_TOGGLE_STATUS]],

    [AnalyticsController, 'summary', [StorePermission.DASHBOARD_VIEW]],
    [CategoriesController, 'findMine', [StorePermission.PRODUCTS_BROWSE]],
    [CategoriesController, 'create', [StorePermission.PRODUCTS_CATEGORIES_MANAGE]],
    [OrderLabelsController, 'generate', [StorePermission.ORDERS_LABELS_GENERATE]],
  ];

  it.each(expectations)(
    '%p.%s is guarded by the expected permission(s)',
    (controller, method, expected) => {
      expect(permissionsOf(controller, method)).toEqual(expected);
    },
  );
});

describe('Authorization matrix — role capabilities', () => {
  const can = (role: StoreRole, permission: string) =>
    hasStorePermission(permissionsForRole(role), permission);

  it('Owner receives the wildcard', () => {
    expect(permissionsForRole(StoreRole.OWNER)).toEqual(['*']);
    expect(can(StoreRole.OWNER, 'literally.anything')).toBe(true);
  });

  it('Partner manages everything except store.create and Owner management', () => {
    expect(can(StoreRole.PARTNER, StorePermission.ORDERS_DELETE)).toBe(true);
    expect(can(StoreRole.PARTNER, StorePermission.TEAM_INVITE)).toBe(true);
    expect(can(StoreRole.PARTNER, StorePermission.STORE_CREATE)).toBe(false);
    expect(can(StoreRole.PARTNER, StorePermission.TEAM_MANAGE_OWNER)).toBe(false);
  });

  it('Order Confirmer confirms/dispatches but cannot delete, adjust stock or change settings', () => {
    expect(can(StoreRole.ORDER_CONFIRMER, StorePermission.ORDERS_CONFIRM)).toBe(true);
    expect(can(StoreRole.ORDER_CONFIRMER, StorePermission.ORDERS_DISPATCH)).toBe(true);
    // The role works from the Orders page only: catalogue data is readable for the order-line
    // picker, but the Products/Categories management pages (gated on `products.view`) are not.
    expect(can(StoreRole.ORDER_CONFIRMER, StorePermission.PRODUCTS_BROWSE)).toBe(true);
    expect(can(StoreRole.ORDER_CONFIRMER, StorePermission.PRODUCTS_VIEW)).toBe(false);
    // Read-only store/delivery data is required to create and dispatch an order.
    expect(can(StoreRole.ORDER_CONFIRMER, StorePermission.STORE_VIEW)).toBe(true);
    expect(can(StoreRole.ORDER_CONFIRMER, StorePermission.DELIVERY_VIEW)).toBe(true);
    expect(can(StoreRole.ORDER_CONFIRMER, StorePermission.DELIVERY_FEES_VIEW)).toBe(true);
    expect(can(StoreRole.ORDER_CONFIRMER, StorePermission.ORDERS_DELETE)).toBe(false);
    expect(can(StoreRole.ORDER_CONFIRMER, StorePermission.INVENTORY_ADJUST)).toBe(false);
    expect(can(StoreRole.ORDER_CONFIRMER, StorePermission.DELIVERY_CONFIGURE)).toBe(false);
    expect(can(StoreRole.ORDER_CONFIRMER, StorePermission.DELIVERY_ATTRIBUTIONS_UPDATE)).toBe(false);
    expect(can(StoreRole.ORDER_CONFIRMER, StorePermission.ORDERS_RETURNS_RECEIVE)).toBe(false);
  });

  it('Inventory Staff cannot confirm/dispatch/delete orders', () => {
    expect(can(StoreRole.INVENTORY_STAFF, StorePermission.INVENTORY_ADJUST)).toBe(true);
    expect(can(StoreRole.INVENTORY_STAFF, StorePermission.PRODUCTS_VARIANTS_MANAGE)).toBe(true);
    // Inventory staff still open the Products/Categories pages and read their data.
    expect(can(StoreRole.INVENTORY_STAFF, StorePermission.PRODUCTS_VIEW)).toBe(true);
    expect(can(StoreRole.INVENTORY_STAFF, StorePermission.PRODUCTS_BROWSE)).toBe(true);
    expect(can(StoreRole.INVENTORY_STAFF, StorePermission.ORDERS_VIEW)).toBe(true);
    // Read-only delivery data for the orders page / return dialog.
    expect(can(StoreRole.INVENTORY_STAFF, StorePermission.STORE_VIEW)).toBe(true);
    expect(can(StoreRole.INVENTORY_STAFF, StorePermission.DELIVERY_VIEW)).toBe(true);
    expect(can(StoreRole.INVENTORY_STAFF, StorePermission.DELIVERY_FEES_VIEW)).toBe(true);
    expect(can(StoreRole.INVENTORY_STAFF, StorePermission.ORDERS_CONFIRM)).toBe(false);
    expect(can(StoreRole.INVENTORY_STAFF, StorePermission.ORDERS_DISPATCH)).toBe(false);
    expect(can(StoreRole.INVENTORY_STAFF, StorePermission.ORDERS_DELETE)).toBe(false);
    expect(can(StoreRole.INVENTORY_STAFF, StorePermission.PRODUCTS_DELETE)).toBe(false);
    expect(can(StoreRole.INVENTORY_STAFF, StorePermission.DELIVERY_CONFIGURE)).toBe(false);
  });

  it('Cashier is POS-only', () => {
    expect(can(StoreRole.CASHIER, StorePermission.POS_ACCESS)).toBe(true);
    expect(can(StoreRole.CASHIER, StorePermission.POS_CREATE_SALE)).toBe(true);
    expect(can(StoreRole.CASHIER, StorePermission.ORDERS_VIEW)).toBe(false);
    expect(can(StoreRole.CASHIER, StorePermission.INVENTORY_VIEW)).toBe(false);
    expect(can(StoreRole.CASHIER, StorePermission.DELIVERY_VIEW)).toBe(false);
    expect(can(StoreRole.CASHIER, StorePermission.TEAM_VIEW)).toBe(false);
  });
});
