import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';
import { StoresService } from '../stores/stores.service';
import { OrdersService, RequestUser } from '../orders/orders.service';
import { Order } from '../orders/schemas/order.schema';
import { Counter } from '../orders/schemas/counter.schema';
import { Product } from '../products/schemas/product.schema';
import { ProductVariant } from '../inventory/schemas/product-variant.schema';
import { InventoryBalance } from '../inventory/schemas/inventory-balance.schema';
import { ProductOption } from '../inventory/schemas/product-option.schema';
import { ProductOptionValue } from '../inventory/schemas/product-option-value.schema';
import { VariantOptionValue } from '../inventory/schemas/variant-option-value.schema';
import { DeliveryService } from '../delivery/delivery.service';
import { OrderStatusesService } from '../orders/order-statuses.service';
import { ReservationsService } from '../inventory/services/reservations.service';
import { VariantsService } from '../inventory/services/variants.service';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { StatusConfig } from '../../common/constants/order-statuses.const';

/**
 * POS tenancy isolation (roadmap Phase 6).
 *
 * One vendor's register must never touch another vendor's catalogue, barcodes, customers or
 * stock. The POS module enforces this the same way tracking and inventory do: the store is
 * resolved from the session (`req.user.id`) and passed into every query, and the sale path
 * re-checks each variant's `storeId` before a transaction opens (defence in depth). This file
 * pins the whole matrix in one place:
 *
 *   surface            | guard                                      | pinned here | also pinned in
 *   -------------------|--------------------------------------------|-------------|----------------------------
 *   catalogue search   | controller store-from-session + $match     | this file   | pos.service.spec.ts
 *   barcode scan       | controller store-from-session + findOne    | this file   | pos.service.spec.ts
 *   customer autofill  | controller store-from-session + $match     | this file   | pos.service.spec.ts
 *   immediate sale     | session store; foreign variant re-checked  | this file   | orders.service.spec.ts
 *
 * A controller that trusted a client-supplied `storeId` would turn every read below into a
 * cross-tenant leak, so the controller is exercised directly (guards are an HTTP concern and
 * are not run when a handler is invoked as a plain method).
 */

const STORE_A = new Types.ObjectId();
const STORE_B = new Types.ObjectId();
const PRODUCT_B = new Types.ObjectId();
const VARIANT_B = new Types.ObjectId();

const VENDOR_A: RequestUser = {
  id: new Types.ObjectId().toString(),
  email: 'vendor-a@store.test',
  role: 'VENDOR',
  fullName: 'Vendor A',
};

/** Query-chain stub: every mongoose builder returns itself, `.exec()` resolves the value. */
const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate', 'session', 'updateOne']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

/** A fake driver session: `withTransaction` commits on success, aborts and rethrows on failure. */
const makeSession = () => {
  const s: any = {};
  s.startTransaction = jest.fn().mockResolvedValue(undefined);
  s.abortTransaction = jest.fn().mockResolvedValue(undefined);
  s.endSession = jest.fn().mockResolvedValue(undefined);
  s.withTransaction = jest.fn(async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      await s.abortTransaction();
      throw err;
    }
  });
  return s;
};

const statusConfig = (slug: string): StatusConfig => ({
  _id: new Types.ObjectId().toString(),
  slug,
  displayName: slug,
  nameEn: slug,
  nameFr: slug,
  nameAr: slug,
  color: '#000000',
  sortOrder: 1,
});

describe('POS tenancy isolation', () => {
  describe('controller — the store comes from the session, never the request', () => {
    let controller: PosController;
    let posService: any;
    let storesService: any;
    let ordersService: any;

    const req = { user: VENDOR_A };

    beforeEach(async () => {
      posService = {
        searchProducts: jest.fn().mockResolvedValue({ data: [], nextCursor: null, hasMore: false }),
        findByBarcode: jest.fn(),
        searchCustomers: jest.fn().mockResolvedValue({ data: [] }),
      };
      storesService = { findByVendorIdOrThrow: jest.fn().mockResolvedValue({ _id: STORE_A }) };
      ordersService = { createImmediateSale: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        controllers: [PosController],
        providers: [
          { provide: PosService, useValue: posService },
          { provide: StoresService, useValue: storesService },
          { provide: OrdersService, useValue: ordersService },
        ],
      }).compile();

      controller = module.get(PosController);
    });

    it('scopes catalogue search to the session store and ignores a smuggled storeId', async () => {
      await controller.search({ q: 'shirt', storeId: STORE_B.toString() } as any, req);

      expect(storesService.findByVendorIdOrThrow).toHaveBeenCalledWith(VENDOR_A.id);
      expect(posService.searchProducts).toHaveBeenCalledWith(STORE_A, expect.any(Object));
      // The session store — not the storeId the caller put in the query — is what scoped the read.
      expect(posService.searchProducts.mock.calls[0][0]).not.toBe(STORE_B);
    });

    it('scopes the barcode scan to the session store', async () => {
      await controller.byBarcode('B-ONLY-CODE', req);

      expect(storesService.findByVendorIdOrThrow).toHaveBeenCalledWith(VENDOR_A.id);
      expect(posService.findByBarcode).toHaveBeenCalledWith(STORE_A, 'B-ONLY-CODE');
    });

    it('scopes the customer autofill to the session store', async () => {
      await controller.customers('ali', req);

      expect(storesService.findByVendorIdOrThrow).toHaveBeenCalledWith(VENDOR_A.id);
      expect(posService.searchCustomers).toHaveBeenCalledWith(STORE_A, 'ali');
    });

    it('forwards the session user to the sale, ignoring a body-supplied store', async () => {
      const body = {
        items: [{ variantId: VARIANT_B.toString(), quantity: 1 }],
        storeId: STORE_B.toString(),
        vendorEmail: 'attacker@store-b.test',
      } as any;

      await controller.createSale(body, req);

      // createImmediateSale resolves the store from `user.id`; the body is passed through
      // untouched (its storeId/vendorEmail are inert — see the sale test below).
      expect(ordersService.createImmediateSale).toHaveBeenCalledWith(body, VENDOR_A);
    });

    it('surfaces a store-resolution failure without touching the catalogue', async () => {
      storesService.findByVendorIdOrThrow.mockRejectedValue(
        new AppException(AppErrorCode.STORE_NOT_FOUND),
      );

      await expect(controller.search({} as any, { user: {} })).rejects.toMatchObject({
        errorCode: AppErrorCode.STORE_NOT_FOUND,
      });
      expect(posService.searchProducts).not.toHaveBeenCalled();
    });
  });

  describe('catalogue reads — the store filter is applied twice', () => {
    let service: PosService;
    let variantModel: any;
    let balanceModel: any;
    let optionModel: any;
    let valueModel: any;
    let joinModel: any;
    let productModel: any;
    let orderModel: any;

    beforeEach(async () => {
      variantModel = { find: jest.fn(), findOne: jest.fn(), aggregate: jest.fn() };
      balanceModel = { find: jest.fn().mockReturnValue(query([])) };
      optionModel = { find: jest.fn().mockReturnValue(query([])) };
      valueModel = { find: jest.fn().mockReturnValue(query([])) };
      joinModel = { find: jest.fn().mockReturnValue(query([])) };
      productModel = { find: jest.fn(), collection: { name: 'products' } };
      orderModel = { aggregate: jest.fn().mockReturnValue(query([])) };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PosService,
          { provide: getModelToken(ProductVariant.name), useValue: variantModel },
          { provide: getModelToken(InventoryBalance.name), useValue: balanceModel },
          { provide: getModelToken(ProductOption.name), useValue: optionModel },
          { provide: getModelToken(ProductOptionValue.name), useValue: valueModel },
          { provide: getModelToken(VariantOptionValue.name), useValue: joinModel },
          { provide: getModelToken(Product.name), useValue: productModel },
          { provide: getModelToken(Order.name), useValue: orderModel },
        ],
      }).compile();

      service = module.get<PosService>(PosService);
    });

    it('drops a foreign product even if the id-list pass were to leak it', async () => {
      // The aggregation carries the first store filter; `assemble` carries the second. Poison
      // the first by handing back store B's product id, then prove the products read still
      // scopes by store — a leak upstream cannot surface B's product at A's till.
      variantModel.aggregate.mockReturnValue(query([{ _id: PRODUCT_B }]));
      productModel.find.mockReturnValue(query([])); // store A owns no such product

      const page = await service.searchProducts(STORE_A, {});

      expect(page.data).toEqual([]);
      expect(productModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ storeId: STORE_A }),
      );
    });

    it('reports a barcode that exists only in another store as not found', async () => {
      // findOne is store-scoped, so store B's barcode never resolves for store A.
      variantModel.findOne.mockReturnValue(query(null));

      await expect(service.findByBarcode(STORE_A, 'B-ONLY-CODE')).rejects.toMatchObject({
        errorCode: AppErrorCode.POS_BARCODE_NOT_FOUND,
      });
      expect(variantModel.findOne.mock.calls[0][0]).toMatchObject({ storeId: STORE_A });
    });

    it('scopes the customer autofill aggregation to the session store', async () => {
      orderModel.aggregate.mockReturnValue(query([]));

      await service.searchCustomers(STORE_A, 'ali');

      expect(orderModel.aggregate.mock.calls[0][0][0].$match.storeId).toBe(STORE_A);
      expect(orderModel.aggregate.mock.calls[0][0][0].$match.storeId).not.toBe(STORE_B);
    });
  });

  describe('immediate sale — another store’s variant is refused', () => {
    let service: OrdersService;
    let orderModel: any;
    let sessions: any[];

    const foreignSnapshot = () => ({
      variantId: VARIANT_B.toString(),
      productId: PRODUCT_B.toString(),
      storeId: STORE_B.toString(),
      sku: 'B-SKU',
      priceOverride: 100,
      image: null,
      isActive: true,
      snapshot: { options: [], label: 'B / M' },
    });

    beforeEach(async () => {
      sessions = [];

      orderModel = jest.fn().mockImplementation((doc: any) => ({
        ...doc,
        save: jest.fn().mockResolvedValue({ ...doc, toObject: () => ({ ...doc }) }),
      }));
      orderModel.findOne = jest.fn().mockReturnValue(query(undefined));
      orderModel.startSession = jest.fn(() => {
        const s = makeSession();
        sessions.push(s);
        return s;
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          OrdersService,
          { provide: getModelToken(Order.name), useValue: orderModel },
          {
            provide: getModelToken(Counter.name),
            useValue: { findOneAndUpdate: jest.fn().mockReturnValue(query({ seq: 1 })) },
          },
          {
            provide: getModelToken(Product.name),
            useValue: { find: jest.fn().mockReturnValue(query([{ _id: PRODUCT_B, price: 100, nameEn: 'B' }])) },
          },
          { provide: DeliveryService, useValue: { createDeliveryForOrder: jest.fn() } },
          {
            provide: OrderStatusesService,
            useValue: { getBySlug: jest.fn(async (slug: string) => statusConfig(slug)) },
          },
          {
            provide: StoresService,
            useValue: {
              findByVendorIdOrThrow: jest.fn().mockResolvedValue({ _id: STORE_A, vendorEmail: 'a@store.test' }),
              incrementOrderCount: jest.fn().mockResolvedValue(undefined),
            },
          },
          {
            provide: ReservationsService,
            useValue: {
              reserve: jest.fn(),
              consume: jest.fn(),
              assertLinesInStock: jest.fn().mockResolvedValue(undefined),
            },
          },
          {
            provide: VariantsService,
            useValue: {
              snapshotsForVariants: jest
                .fn()
                .mockResolvedValue(new Map([[VARIANT_B.toString(), foreignSnapshot()]])),
            },
          },
        ],
      }).compile();

      service = module.get<OrdersService>(OrdersService);
    });

    it('refuses a variant owned by another store before a transaction opens', async () => {
      await expect(
        service.createImmediateSale(
          { items: [{ variantId: VARIANT_B.toString(), quantity: 1 }] } as any,
          VENDOR_A,
        ),
      ).rejects.toMatchObject({
        errorCode: AppErrorCode.VARIANT_NOT_FOUND,
        errorParams: expect.objectContaining({ reason: 'variant_belongs_to_another_store' }),
      });

      // No order is written and no session is even opened.
      expect(orderModel).not.toHaveBeenCalled();
      expect(orderModel.startSession).not.toHaveBeenCalled();
      expect(sessions).toHaveLength(0);
    });
  });
});
