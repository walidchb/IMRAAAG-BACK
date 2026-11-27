import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { OrdersService } from './orders.service';
import { Order } from './schemas/order.schema';
import { Counter } from './schemas/counter.schema';
import { PosHold } from './schemas/pos-hold.schema';
import { Product } from '../products/schemas/product.schema';
import { DeliveryService } from '../delivery/delivery.service';
import { DeliveryFeesService } from '../delivery-fees/delivery-fees.service';
import { AuditService } from '../audit/audit.service';
import { OrderStatusesService } from './order-statuses.service';
import { StoresService } from '../stores/stores.service';
import { StoreAccessService } from '../team/store-access.service';
import { ReservationsService } from '../inventory/services/reservations.service';
import { VariantsService } from '../inventory/services/variants.service';
import { BoxesService } from '../boxes/boxes.service';
import { SubscriptionAccessService } from '../subscriptions/subscription-access.service';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { AppException } from '../../common/errors/app-exception';
import { StatusConfig } from '../../common/constants/order-statuses.const';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCartOrderDto } from './dto/create-cart-order.dto';

const STORE_ID = new Types.ObjectId();
const PRODUCT_ID = new Types.ObjectId();
const VARIANT_ID = new Types.ObjectId();
const OTHER_STORE_ID = new Types.ObjectId();

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

const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate', 'session', 'updateOne']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

/**
 * Cart checkout integrity: server pricing, the strict all-or-none stock gate, and idempotent
 * replay. These are the three failures that would duplicate a COD order or mis-charge a buyer.
 */
describe('OrdersService — cart checkout', () => {
  let service: OrdersService;
  let orderModel: any;
  let productModel: any;
  let variantsService: any;
  let reservations: any;
  let boxesService: any;
  let subscriptionAccess: any;

  const snapshot = (over: Record<string, any> = {}) => ({
    variantId: VARIANT_ID.toString(),
    productId: PRODUCT_ID.toString(),
    storeId: STORE_ID.toString(),
    sku: 'KAF-M-RED',
    priceOverride: null,
    compareAtPrice: null,
    image: null,
    isActive: true,
    isDeleted: false,
    optionValueIds: ['v-1'],
    snapshot: { options: [], label: 'M / Terracotta' },
    ...over,
  });

  const product = (over: Record<string, any> = {}) => ({
    _id: PRODUCT_ID,
    nameEn: 'Kaftan Nour',
    nameFr: 'Kaftan Nour',
    nameAr: 'قفطان نور',
    slug: 'kaftan-nour',
    image: 'product.jpg',
    images: ['product.jpg'],
    price: 100,
    originalPrice: 150,
    published: true,
    storeId: STORE_ID,
    ...over,
  });

  const customer = { name: 'Yasmine', phone: '0555123456', wilaya: '16', commune: '163', address: '12 Rue des Oliviers' };

  const buildDto = (over: Record<string, any> = {}) => ({
    storeId: STORE_ID.toString(),
    idempotencyKey: 'key_12345',
    locale: 'en',
    items: [{ variantId: VARIANT_ID.toString(), quantity: 2 }],
    customer,
    shippingMethod: 'home',
    ...over,
  }) as any;

  beforeEach(async () => {
    orderModel = jest.fn().mockImplementation((doc: any) => ({
      ...doc,
      save: jest.fn().mockResolvedValue({ ...doc, toObject: () => ({ ...doc, _id: new Types.ObjectId() }) }),
    }));
    orderModel.findOne = jest.fn().mockReturnValue(query(undefined));

    productModel = {
      find: jest.fn().mockReturnValue(query([product()])),
    };
    variantsService = {
      snapshotsForVariants: jest.fn().mockResolvedValue(new Map([[VARIANT_ID.toString(), snapshot()]])),
    };
    reservations = {
      getAvailabilityForVariants: jest.fn().mockResolvedValue(new Map([[VARIANT_ID.toString(), 5]])),
      assertCartAvailability: jest.fn().mockResolvedValue(undefined),
      checkAdvisoryAvailability: jest.fn().mockResolvedValue([]),
      assertLinesInStock: jest.fn().mockResolvedValue(undefined),
    };
    boxesService = {
      resolveForCart: jest.fn().mockResolvedValue({
        bundleLines: [],
        componentLines: [],
        bundleSnapshots: [],
        bundlesTotal: 0,
      }),
    };
    subscriptionAccess = {
      isEnabled: jest.fn().mockReturnValue(false),
      isEnforcementEnabled: jest.fn().mockReturnValue(false),
      isFeatureEnforcementEnabled: jest.fn().mockReturnValue(false),
      getPublicState: jest
        .fn()
        .mockResolvedValue({ acceptingOrders: true, subscriptionState: 'active' }),
      getEntitlement: jest.fn().mockResolvedValue({ entitled: true }),
      reserveOrderSlot: jest.fn().mockResolvedValue(false),
      releaseOrderSlot: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: getModelToken(Order.name), useValue: orderModel },
        { provide: getModelToken(Counter.name), useValue: { findOneAndUpdate: jest.fn().mockReturnValue(query({ seq: 42 })) } },
        { provide: getModelToken(PosHold.name), useValue: { findOne: jest.fn().mockReturnValue(query(undefined)) } },
        { provide: getModelToken(Product.name), useValue: productModel },
        {
          provide: DeliveryService,
          useValue: {
            resolveCompanyForWilaya: jest.fn().mockResolvedValue('company-1'),
            resolveDefaultStopDesk: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: DeliveryFeesService,
          useValue: { getFeeByStoreId: jest.fn().mockResolvedValue({ wilayaCode: '16', homeDeliveryFee: 600, stopDeskDeliveryFee: 400 }) },
        },
        { provide: OrderStatusesService, useValue: { getBySlug: jest.fn(async (slug: string) => statusConfig(slug)) } },
        {
          provide: StoresService,
          useValue: {
            findOne: jest.fn().mockResolvedValue({
              _id: STORE_ID,
              storeName: 'Atelier Nour',
              storeSlug: 'atelier-nour',
              vendorEmail: 'store@imraaah.com',
            }),
            incrementOrderCount: jest.fn().mockResolvedValue(undefined),
            findByMemberId: jest.fn().mockResolvedValue(null),
            resolveStoreIdByEmail: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: StoreAccessService,
          useValue: { assertPermission: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: ReservationsService, useValue: reservations },
        { provide: VariantsService, useValue: variantsService },
        { provide: BoxesService, useValue: boxesService },
        { provide: SubscriptionAccessService, useValue: subscriptionAccess },
        { provide: AuditService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  it('validateCart returns server-resolved prices/names and live availability', async () => {
    const quote = await service.validateCart({
      storeId: STORE_ID.toString(),
      locale: 'en',
      items: [{ variantId: VARIANT_ID.toString(), quantity: 2 }],
    });

    expect(quote.storeName).toBe('Atelier Nour');
    expect(quote.lines[0]).toMatchObject({
      productName: 'Kaftan Nour',
      productSlug: 'kaftan-nour',
      variantLabel: 'M / Terracotta',
      unitPrice: 100,
      compareAtPrice: 150,
      lineTotal: 200,
      available: 5,
      isAvailable: true,
      issues: [],
    });
    expect(quote.subtotal).toBe(200);
    expect(quote.hasBlockingIssues).toBe(false);
    // Read-only: nothing was written.
    expect(orderModel).not.toHaveBeenCalled();
  });

  it('validateCart flags a short line without throwing', async () => {
    reservations.getAvailabilityForVariants.mockResolvedValue(new Map([[VARIANT_ID.toString(), 1]]));

    const quote = await service.validateCart({
      storeId: STORE_ID.toString(),
      items: [{ variantId: VARIANT_ID.toString(), quantity: 2 }],
    });

    expect(quote.lines[0].isAvailable).toBe(false);
    expect(quote.lines[0].issues).toContain('INSUFFICIENT_STOCK');
    expect(quote.hasBlockingIssues).toBe(true);
  });

  it('advertises and enforces the same order acceptance under the feature gate', async () => {
    subscriptionAccess.isEnabled.mockReturnValue(true);
    subscriptionAccess.isFeatureEnforcementEnabled.mockReturnValue(true);

    // Active subscription: the quote says accepting, and an order is allowed.
    subscriptionAccess.getPublicState.mockResolvedValue({
      acceptingOrders: true,
      subscriptionState: 'active',
    });
    subscriptionAccess.getEntitlement.mockResolvedValue({ entitled: true });
    const accepted = await service.validateCart({
      storeId: STORE_ID.toString(),
      items: [{ variantId: VARIANT_ID.toString(), quantity: 1 }],
    });
    expect(accepted.acceptingOrders).toBe(true);

    // Expired subscription: the quote pauses and the writer refuses with the same rule.
    subscriptionAccess.getPublicState.mockResolvedValue({
      acceptingOrders: false,
      subscriptionState: 'expired',
    });
    subscriptionAccess.getEntitlement.mockResolvedValue({ entitled: false });
    const paused = await service.validateCart({
      storeId: STORE_ID.toString(),
      items: [{ variantId: VARIANT_ID.toString(), quantity: 1 }],
    });
    expect(paused.acceptingOrders).toBe(false);
    await expect(service.createCartOrder(buildDto())).rejects.toMatchObject({
      errorCode: AppErrorCode.SUBSCRIPTION_INACTIVE,
    });
  });

  it('createCartOrder computes price/shipping/total server-side and stores the idempotency key', async () => {
    const order: any = await service.createCartOrder(
      buildDto({
        items: [{ variantId: VARIANT_ID.toString(), quantity: 2 }],
      }),
    );

    expect(order.items[0]).toMatchObject({
      productName: 'Kaftan Nour',
      price: 100,
      originalPrice: 150,
      image: 'product.jpg',
      variantId: VARIANT_ID.toString(),
      sku: 'KAF-M-RED',
    });
    expect(order.shippingFee).toBe(600);
    expect(order.total).toBe(800);
    expect(order.source).toBe('ONLINE');
    expect(order.paymentMethod).toBe('COD');
    expect(order.status.slug).toBe('placed');
    expect(order.clientRequestId).toBe('key_12345');
    expect(order.vendorEmail).toBe('store@imraaah.com');
    // The strict gate ran, and the legacy advisory did not.
    expect(reservations.assertCartAvailability).toHaveBeenCalledWith([
      { variantId: VARIANT_ID.toString(), quantity: 2 },
    ]);
    expect(reservations.checkAdvisoryAvailability).not.toHaveBeenCalled();
  });

  it('a replay of the same key returns the original order instead of creating a second one', async () => {
    const existing = { _id: new Types.ObjectId(), orderNo: '000001', clientRequestId: 'key_12345' };
    orderModel.findOne.mockReturnValue(query(existing));

    const replay: any = await service.createCartOrder(buildDto());

    expect(replay).toBe(existing);
    expect(orderModel).not.toHaveBeenCalled();
    // A replay must not re-check stock, so a later sell-out cannot turn it into a 409.
    expect(reservations.assertCartAvailability).not.toHaveBeenCalled();
  });

  it('refuses an inactive variant with CART_ITEMS_INVALID and writes no order', async () => {
    variantsService.snapshotsForVariants.mockResolvedValue(
      new Map([[VARIANT_ID.toString(), snapshot({ isActive: false })]]),
    );

    await expect(service.createCartOrder(buildDto())).rejects.toMatchObject({
      errorCode: AppErrorCode.CART_ITEMS_INVALID,
    });
    expect(orderModel).not.toHaveBeenCalled();
  });

  it('refuses a foreign-store line with CART_ITEMS_INVALID', async () => {
    variantsService.snapshotsForVariants.mockResolvedValue(
      new Map([[VARIANT_ID.toString(), snapshot({ storeId: OTHER_STORE_ID.toString() })]]),
    );

    await expect(service.createCartOrder(buildDto())).rejects.toMatchObject({
      errorCode: AppErrorCode.CART_ITEMS_INVALID,
    });
    expect(orderModel).not.toHaveBeenCalled();
  });

  it('refuses a short cart with INSUFFICIENT_STOCK and writes no order', async () => {
    reservations.assertCartAvailability.mockRejectedValue(
      new AppException(AppErrorCode.INSUFFICIENT_STOCK, {
        variantId: VARIANT_ID.toString(),
        sku: 'KAF-M-RED',
        requested: 2,
        available: 1,
        items: [{ variantId: VARIANT_ID.toString(), sku: 'KAF-M-RED', requested: 2, available: 1 }],
      }),
    );

    await expect(service.createCartOrder(buildDto())).rejects.toMatchObject({
      errorCode: AppErrorCode.INSUFFICIENT_STOCK,
    });
    expect(orderModel).not.toHaveBeenCalled();
  });

  it('requires an address for home delivery', async () => {
    await expect(
      service.createCartOrder(buildDto({ customer: { ...customer, address: '' } })),
    ).rejects.toMatchObject({ errorCode: AppErrorCode.VALIDATION_REQUIRED });
    expect(orderModel).not.toHaveBeenCalled();
  });

  describe('Box lines', () => {
    const bundleLine = (over: Record<string, any> = {}) => ({
      lineKey: 'bundle:box-1:key',
      bundleId: 'box-1',
      bundleSlug: 'box-of-2',
      bundleName: 'Box of 2',
      image: 'box.jpg',
      price: 3500,
      requiredQuantity: 2,
      quantity: 1,
      lineTotal: 3500,
      availableBoxes: 2,
      isAvailable: true,
      issues: [],
      selections: [
        {
          productId: PRODUCT_ID.toString(),
          variantId: VARIANT_ID.toString(),
          productName: 'Kaftan Nour',
          variantLabel: 'M / Terracotta',
          image: 'product.jpg',
          quantity: 2,
          referenceUnitPrice: 900,
          available: 5,
        },
      ],
      referenceTotal: 1800,
      savings: 0,
      ...over,
    });

    const componentLine = () => ({
      lineId: 'line-abc',
      productId: PRODUCT_ID.toString(),
      productName: 'Kaftan Nour',
      price: 900,
      originalPrice: 150,
      quantity: 2,
      variantId: VARIANT_ID.toString(),
      variantDetails: 'M / Terracotta',
      image: 'product.jpg',
      bundleGroupId: 'group-1',
      bundleReferencePrice: 900,
    });

    const bundleSnapshot = () => ({
      bundleId: 'box-1',
      bundleGroupId: 'group-1',
      slug: 'box-of-2',
      nameEn: 'Box of 2',
      nameAr: 'صندوق',
      nameFr: 'Boîte de 2',
      image: 'box.jpg',
      price: 3500,
      requiredQuantity: 2,
      quantity: 1,
      lineTotal: 3500,
      referenceTotal: 1800,
      savings: 0,
      contents: [
        {
          lineId: 'line-abc',
          productId: PRODUCT_ID.toString(),
          variantId: VARIANT_ID.toString(),
          productName: 'Kaftan Nour',
          variantLabel: 'M / Terracotta',
          sku: 'KAF-M-RED',
          image: 'product.jpg',
          quantityPerBox: 2,
          referenceUnitPrice: 900,
        },
      ],
    });

    const bundleBody = {
      bundles: [
        {
          bundleId: 'box-1',
          quantity: 1,
          selections: [{ variantId: VARIANT_ID.toString(), quantity: 2 }],
        },
      ],
    };

    const primeBundleResolution = () => {
      boxesService.resolveForCart.mockResolvedValue({
        bundleLines: [bundleLine()],
        componentLines: [componentLine()],
        bundleSnapshots: [bundleSnapshot()],
        bundlesTotal: 3500,
      });
    };

    it('charges the fixed Box price, keeps reference prices on flat component lines', async () => {
      primeBundleResolution();

      await service.createCartOrder(
        buildDto({ items: [], ...bundleBody }),
      );

      const payload = orderModel.mock.calls[0][0];
      expect(payload.total).toBe(4100); // 3500 Box + 600 shipping, not 1800 of components
      expect(payload.bundles).toHaveLength(1);
      expect(payload.bundles[0].bundleId).toBe('box-1');
      expect(payload.items).toHaveLength(1);
      expect(payload.items[0]).toMatchObject({
        bundleGroupId: 'group-1',
        lineId: 'line-abc',
        price: 900,
        quantity: 2,
      });
      // The flattened stock demand includes the Box component quantity.
      expect(reservations.assertCartAvailability).toHaveBeenCalledWith([
        { variantId: VARIANT_ID.toString(), quantity: 2 },
      ]);
    });

    it('refuses an invalid Box selection with CART_ITEMS_INVALID and writes nothing', async () => {
      boxesService.resolveForCart.mockResolvedValue({
        bundleLines: [bundleLine({ isAvailable: false, issues: ['BOX_SELECTION_INVALID'] })],
        componentLines: [],
        bundleSnapshots: [],
        bundlesTotal: 0,
      });

      await expect(
        service.createCartOrder(buildDto({ items: [], ...bundleBody })),
      ).rejects.toMatchObject({
        errorCode: AppErrorCode.CART_ITEMS_INVALID,
      });
      expect(orderModel).not.toHaveBeenCalled();
      expect(reservations.assertCartAvailability).not.toHaveBeenCalled();
    });

    it('lets the flattened stock gate refuse a short Box with INSUFFICIENT_STOCK', async () => {
      boxesService.resolveForCart.mockResolvedValue({
        bundleLines: [bundleLine({ isAvailable: false, issues: ['BOX_SELECTION_UNAVAILABLE'] })],
        componentLines: [componentLine()],
        bundleSnapshots: [bundleSnapshot()],
        bundlesTotal: 3500,
      });
      reservations.assertCartAvailability.mockRejectedValue(
        new AppException(AppErrorCode.INSUFFICIENT_STOCK, {
          items: [{ variantId: VARIANT_ID.toString(), requested: 2, available: 1 }],
        }),
      );

      await expect(
        service.createCartOrder(buildDto({ items: [], ...bundleBody })),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.INSUFFICIENT_STOCK });
      expect(orderModel).not.toHaveBeenCalled();
    });

    it('adds bundle lines and their totals to the read-only quote', async () => {
      primeBundleResolution();

      const quote = await service.validateCart(
        buildDto({ items: [], ...bundleBody }),
      );

      expect(quote.bundleLines).toHaveLength(1);
      expect(quote.bundleLines![0].lineTotal).toBe(3500);
      expect(quote.subtotal).toBe(3500);
      expect(quote.hasBlockingIssues).toBe(false);
    });
  });

  describe('cart DTO contract', () => {
    const validateDto = async (body: Record<string, any>) => {
      const dto = plainToInstance(CreateCartOrderDto, body);
      return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    };
    const validCustomer = {
      name: 'Yasmine',
      phone: '0555123456',
      wilaya: '16',
      commune: '163',
      address: '12 Rue des Oliviers',
    };
    const base = {
      storeId: STORE_ID.toString(),
      idempotencyKey: 'key_12345',
      customer: validCustomer,
      shippingMethod: 'home',
    };

    it('accepts a bundle-only cart', async () => {
      const errors = await validateDto({
        ...base,
        items: [],
        bundles: [
          {
            bundleId: new Types.ObjectId().toString(),
            quantity: 1,
            selections: [{ variantId: VARIANT_ID.toString(), quantity: 2 }],
          },
        ],
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects a client-supplied price inside a bundle item', async () => {
      const errors = await validateDto({
        ...base,
        items: [],
        bundles: [
          {
            bundleId: new Types.ObjectId().toString(),
            quantity: 1,
            price: 10,
            selections: [{ variantId: VARIANT_ID.toString(), quantity: 2 }],
          },
        ],
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('still accepts an items-only cart', async () => {
      const errors = await validateDto({
        ...base,
        items: [{ variantId: VARIANT_ID.toString(), quantity: 2 }],
      });
      expect(errors).toHaveLength(0);
    });
  });
});
