import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { Order, OrderDocument } from './schemas/order.schema';
import { Counter, CounterDocument } from './schemas/counter.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreatePosSaleDto } from './dto/create-pos-sale.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { BulkActionDto } from './dto/bulk-action.dto';
import { BulkShipDto } from './dto/bulk-ship.dto';
import { DeliveryService } from '../delivery/delivery.service';
import { DeliveryFeesService } from '../delivery-fees/delivery-fees.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/constants/audit-action.enum';
import { ResourceType } from '../../common/constants/resource-type.enum';
import { OrderStatusesService } from './order-statuses.service';
import { BulkOrderResult } from '../delivery/delivery-companies/interfaces/delivery-company-handler.interface';
import { normalizeDhdCommuneSelection } from '../delivery/delivery-companies/dhd-commune';
import { normalizeNoestCommuneSelection } from '../delivery/delivery-companies/noest-commune';
import { ORDER_STATUS_VALUES, ORDER_STATUS_TRANSITIONS, OrderStatus } from '../../common/constants/order-statuses.const';
import { DELIVERY_STATUS_CONFLICT_CODES } from '../../common/constants/delivery-status.const';
import { OrderSource } from '../../common/constants/order-sources.const';
import { Role } from '../../common/constants/roles.enum';
import { StoresService } from '../stores/stores.service';
import {
  AdvisoryLine,
  OrderInventoryContext,
  OrderInventoryDiagnostic,
  ReservationsService,
  ReturnResult,
} from '../inventory/services/reservations.service';
import { VariantsService } from '../inventory/services/variants.service';
import { openTransactionSession, withOptionalSession } from '../inventory/services/session.util';
import { ReceiveReturnDto } from '../inventory/dto/reservations.dto';

export interface RequestUser {
  id: string;
  email: string;
  role: string;
  fullName: string;
  phoneNumber?: string;
}

export interface PaginatedOrdersResult {
  data: Order[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  statusCounts: Record<string, number>;
}

/**
 * Who asked for a carrier-driven status advance (roadmap §10.3).
 *
 * `user` is the name written into the order history: the vendor UI shows it, so a change the
 * carrier caused is distinguishable from the vendor's own.
 */
export interface CarrierStatusAdvanceActor {
  /** The system that asked — e.g. `zr-express-sync`. */
  system: string;
  /** The name written into the order history — e.g. `ZR Express`. */
  user: string;
}

/** The order outcomes a carrier signal may request (behaviour refactor §3.2). */
export type CarrierOrderTarget = 'in-transit' | 'delivered' | 'cancelled' | 'returned';

/**
 * One carrier action to apply to an order.
 *
 * `steps` is the ordered transition path. When omitted, the service derives the platform's
 * canonical path for the target (`dispatched → in-transit → delivered`, etc.). Every step is
 * still re-validated, so a caller cannot invent a transition by supplying `steps`.
 */
export interface CarrierOrderAction {
  target: CarrierOrderTarget;
  steps?: string[];
}

/** The outcome of a carrier-driven status advance (roadmap §10.3). */
export interface CarrierStatusAdvanceResult {
  /** True when the order was moved. */
  applied: boolean;
  /** Why it was not applied: a conflict code when `conflict` is true. */
  reason?: string;
  /** True when the carrier and the platform disagreed about the order's state (§10.4). */
  conflict?: boolean;
  /** The status the order was in when the advance was attempted. */
  fromStatus?: string;
  /** The status the carrier asked for. */
  toStatus?: string;
  /** The order's number, for logs. */
  orderNo?: string;
}

/**
 * The conflict a carrier signal creates when it meets an order it cannot move (roadmap §10.4).
 *
 * `null` when the order is in a state the advance could still apply to. The terminal states
 * are never overwritten: a claim filtered on the status it moves from can never match them,
 * and this is the counterpart that tells the vendor *why* nothing happened.
 */
function carrierAdvanceConflict(slug: string): string | null {
  switch (slug) {
    case OrderStatus.CANCELLED:
      return DELIVERY_STATUS_CONFLICT_CODES.ORDER_CANCELLED_BEFORE_DELIVERY;
    case OrderStatus.RETURNED:
      return DELIVERY_STATUS_CONFLICT_CODES.ORDER_ALREADY_RETURNED;
    case OrderStatus.DELIVERED:
      return DELIVERY_STATUS_CONFLICT_CODES.ORDER_ALREADY_DELIVERED;
    case OrderStatus.PLACED:
    case OrderStatus.CONFIRMED:
      return DELIVERY_STATUS_CONFLICT_CODES.ORDER_NOT_DISPATCHED;
    default:
      return null;
  }
}

/**
 * The carrier-only edges that are deliberately **not** in the global `ORDER_STATUS_TRANSITIONS`:
 * the vendor UI must never offer a plain "Return" action from dispatch, but the carrier can
 * report that the parcel came back after it was dispatched.
 */
/**
 * The only columns a PATCH may write (H11). Everything else on an order is server-owned:
 * `status` (transition machine), `vendorEmail`/`storeId`/`vendorId` (ownership), `source`
 * (channel), the delivery parcel link and every audit timestamp.
 */
const ORDERS_UPDATEABLE_FIELDS = [
  'customer',
  'items',
  'shippingMethod',
  'shippingFee',
  'bureau',
  'stopDeskCode',
  'deliveryCompanyId',
  'paymentMethod',
  'total',
] as const;

const CARRIER_RETURN_EDGES: ReadonlySet<string> = new Set([
  `${OrderStatus.DISPATCHED}→${OrderStatus.RETURNED}`,
  `${OrderStatus.IN_TRANSIT}→${OrderStatus.RETURNED}`,
  `${OrderStatus.DELIVERED}→${OrderStatus.RETURNED}`,
]);

/**
 * The conflict a carrier action creates for a given **target**, not just the current status.
 *
 * The old `carrierAdvanceConflict` only knew "this status is terminal", which would have
 * wrongly refused `delivered → returned`. This version allows the action matrix's edges and
 * maps every other terminal state to the same explainable conflict codes.
 */
/** The canonical path the platform takes to reach a carrier target. */
function defaultCarrierSteps(current: string, target: CarrierOrderTarget): string[] {
  switch (target) {
    case 'in-transit':
      return current === OrderStatus.DISPATCHED ? [OrderStatus.IN_TRANSIT] : [];
    case 'delivered':
      if (current === OrderStatus.DISPATCHED) {
        return [OrderStatus.IN_TRANSIT, OrderStatus.DELIVERED];
      }
      return current === OrderStatus.IN_TRANSIT ? [OrderStatus.DELIVERED] : [];
    case 'cancelled':
      return [OrderStatus.CANCELLED];
    case 'returned':
      return [OrderStatus.RETURNED];
    default:
      return [];
  }
}

function carrierActionConflict(slug: string, target: CarrierOrderTarget): string | null {
  if (
    (target === 'returned' &&
      [OrderStatus.DISPATCHED, OrderStatus.IN_TRANSIT, OrderStatus.DELIVERED].includes(slug as OrderStatus)) ||
    (target === 'in-transit' && slug === OrderStatus.DISPATCHED) ||
    (target === 'delivered' &&
      [OrderStatus.DISPATCHED, OrderStatus.IN_TRANSIT].includes(slug as OrderStatus)) ||
    (target === 'cancelled' &&
      [OrderStatus.PLACED, OrderStatus.CONFIRMED, OrderStatus.DISPATCHED, OrderStatus.IN_TRANSIT].includes(
        slug as OrderStatus,
      ))
  ) {
    return null;
  }

  return carrierAdvanceConflict(slug) ?? DELIVERY_STATUS_CONFLICT_CODES.ORDER_STATUS_MOVED;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectModel(Order.name) private orderModel: Model<OrderDocument>,
    @InjectModel(Counter.name) private counterModel: Model<CounterDocument>,
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    private readonly deliveryService: DeliveryService,
    private readonly deliveryFeesService: DeliveryFeesService,
    private readonly statusesService: OrderStatusesService,
    private readonly storesService: StoresService,
    private readonly reservationsService: ReservationsService,
    private readonly variantsService: VariantsService,
    private readonly auditService: AuditService,
  ) {}

  private assertVendorOrAdmin(user: RequestUser): void {
    if (user.role !== Role.VENDOR && user.role !== Role.ADMIN) {
      throw new AppException(AppErrorCode.AUTH_VENDOR_ONLY);
    }
  }

  /**
   * Scopes a query to the authenticated vendor's own orders, preferring the stable
   * `storeId` and falling back to the legacy `vendorEmail` for pre-migration orders.
   * The store↔email mapping is 1:1, so the `$or` never widens the result set.
   */
  private async vendorOrderFilter(vendorEmail: string): Promise<Record<string, any>> {
    const storeId = await this.storesService
      .resolveStoreIdByEmail(vendorEmail)
      .catch(() => null);
    return storeId
      ? { $or: [{ storeId }, { vendorEmail }] }
      : { vendorEmail };
  }

  /**
   * D3 ownership check: compares the order's stable `storeId` against the caller's store
   * rather than the mutable `vendorEmail`. Falls back to the email comparison only for
   * orders written before the migration (no `storeId`) or callers with no store yet.
   */
  private async assertOrderOwnership(order: Order, user: RequestUser): Promise<void> {
    if (user.role === Role.ADMIN) return;

    const store = user.id
      ? await this.storesService.findByVendorId(user.id).catch(() => null)
      : null;

    if (store && order.storeId) {
      if (String(order.storeId) === String(store._id)) return;
      throw new AppException(AppErrorCode.AUTH_ORDER_OWNER_ONLY, { orderNo: order.orderNo });
    }

    if (order.vendorEmail?.toLowerCase() !== user.email?.toLowerCase()) {
      throw new AppException(AppErrorCode.AUTH_ORDER_OWNER_ONLY, { orderNo: order.orderNo });
    }
  }

  /**
   * Resolves the store a new order belongs to.
   *
   * - `storeId` (preferred) is authoritative: the store must exist, and its
   *   `vendorEmail` is taken from the store record rather than trusted from the client,
   *   so a mismatched pair can never be used to file an order against the wrong vendor.
   * - Legacy `vendorEmail` still works; the storeId is backfilled from it when possible.
   *
   * Throws when neither is supplied, or when a supplied `storeId` does not exist.
   */
  private async resolveOrderStore(
    dto: CreateOrderDto,
  ): Promise<{ storeId: Types.ObjectId | null; vendorEmail: string }> {
    if (dto.storeId) {
      const store = await this.storesService.findOne(dto.storeId, { skipStatusCheck: true });
      if (!store) {
        throw new AppException(AppErrorCode.STORE_NOT_FOUND, { id: dto.storeId });
      }
      return { storeId: new Types.ObjectId(dto.storeId), vendorEmail: store.vendorEmail };
    }

    if (dto.vendorEmail) {
      const storeId = await this.storesService
        .resolveStoreIdByEmail(dto.vendorEmail)
        .catch(() => null);
      return { storeId, vendorEmail: dto.vendorEmail };
    }

    throw new AppException(AppErrorCode.VALIDATION_REQUIRED, { field: 'storeId' });
  }

  private async generateOrderNo(): Promise<string> {
    while (true) {
      const result = await this.counterModel
        .findOneAndUpdate(
          { key: 'orderNo' },
          { $inc: { seq: 1 } },
          { new: true, upsert: true, setDefaultsOnInsert: true },
        )
        .exec();
      const seq = (result as any)?.seq ?? 1;
      const orderNo = String(seq).padStart(6, '0');
      const exists = await this.orderModel.findOne({ orderNo }).select('_id').lean().exec();
      if (!exists) return orderNo;
    }
  }

  /**
   * The shipping fee a storefront checkout must be charged, resolved from the store's own
   * delivery-fee table. The public `POST /orders` route is anonymous, so its `shippingFee`
   * cannot be trusted: a caller could send 0 or a negative amount. A missing fee entry keeps
   * the historical storefront behaviour of charging 0 (the client used to send 0 when the
   * fee lookup failed), but any other read failure is surfaced rather than silently shipping
   * for free.
   */
  private async resolveStoreShippingFee(
    storeId: Types.ObjectId | null,
    vendorEmail: string | undefined,
    wilayaCode: string | undefined,
    shippingMethod: string,
  ): Promise<number> {
    if ((!storeId && !vendorEmail) || !wilayaCode || shippingMethod === 'pickup') return 0;

    try {
      const fee = storeId
        ? await this.deliveryFeesService.getFeeByStoreId(String(storeId), wilayaCode)
        : await this.deliveryFeesService.getFee(vendorEmail!, wilayaCode);
      return shippingMethod === 'stopdesk' ? fee.stopDeskDeliveryFee : fee.homeDeliveryFee;
    } catch (err) {
      if (err instanceof AppException && err.errorCode === AppErrorCode.FEE_NOT_FOUND_FOR_WILAYA) {
        this.logger.warn(
          `No delivery fee configured for store ${storeId ? String(storeId) : vendorEmail}, wilaya ${wilayaCode}; charging 0.`,
        );
        return 0;
      }
      throw err;
    }
  }

  async create(createOrderDto: CreateOrderDto, user?: RequestUser): Promise<Order> {
    // Resolve the store up front. `storeId` is preferred; the legacy `vendorEmail` is
    // still accepted so the un-migrated storefront keeps working through Phase 3.
    // Both end up on the document, so downstream vendor scoping is identical either way.
    const storeRef = await this.resolveOrderStore(createOrderDto);
    createOrderDto.storeId = storeRef.storeId?.toString();
    createOrderDto.vendorEmail = storeRef.vendorEmail;

    if (user) {
      this.assertVendorOrAdmin(user);
      if (user.role === Role.VENDOR && storeRef.vendorEmail?.toLowerCase() !== user.email?.toLowerCase()) {
        throw new AppException(AppErrorCode.AUTH_ORDER_OWNER_ONLY);
      }
    }

    const now = new Date();

    if (!user) {
      // The storefront checkout is anonymous, so none of its audit metadata can be trusted: a
      // caller could backdate an order (skewing numbering, analytics and reporting) or claim it
      // was already confirmed/dispatched. Every timestamp is stamped here instead.
      delete createOrderDto.date;
      delete createOrderDto.createdAt;
      delete createOrderDto.confirmedAt;
      delete createOrderDto.confirmedBy;
      delete createOrderDto.dispatchedAt;
      delete createOrderDto.createdBy;
      delete createOrderDto.statusConfirmation;
    }

    if (createOrderDto.shippingMethod === 'home') {
      if (!createOrderDto.customer?.wilaya || !createOrderDto.customer?.commune) {
        throw new AppException(AppErrorCode.ORDER_WILAYA_COMMUNE_REQUIRED);
      }
    }

    const objectIds = (createOrderDto.items || [])
      .map(i => i.productId)
      .filter((id): id is string => !!id && /^[a-fA-F0-9]{24}$/.test(id));

    const productMap = new Map<string, { price: number; weight: number; originalPrice: number | null }>();

    if (objectIds.length > 0) {
      const products = await this.productModel
        .find({ _id: { $in: objectIds }, published: true })
        .select('price weight originalPrice')
        .lean()
        .exec();
      for (const p of products) {
        productMap.set(String(p._id), {
          price: (p as any).price,
          weight: (p as any).weight,
          originalPrice: (p as any).originalPrice ?? null,
        });
      }
    }

    // Phase 4 (roadmap 4.6): snapshot the variant each line actually bought, so the order
    // keeps describing it after the seller renames the option or deactivates the variant
    // (spec §7.4). Read once here and matched per line below.
    const snapshots = await this.variantsService.snapshotsForVariants(
      (createOrderDto.items || [])
        .map((i) => i.variantId)
        .filter((id): id is string => !!id),
    );

    // A storefront line names its variant, not necessarily its product. Price must still come
    // from that variant's product when the variant has no override of its own, so load the
    // products reached through the snapshots as well. Only published products are sellable to
    // the public; a vendor's manual order keeps its historical behaviour (client-editable
    // price, product required only when the caller named one).
    if (!user) {
      const unresolvedProductIds = [
        ...new Set(
          [...snapshots.values()]
            .map((snapshot) => snapshot.productId)
            .filter((id) => !!id && !productMap.has(id)),
        ),
      ];
      if (unresolvedProductIds.length > 0) {
        const products = await this.productModel
          .find({ _id: { $in: unresolvedProductIds }, published: true })
          .select('price weight originalPrice')
          .lean()
          .exec();
        for (const p of products) {
          productMap.set(String(p._id), {
            price: (p as any).price,
            weight: (p as any).weight,
            originalPrice: (p as any).originalPrice ?? null,
          });
        }
      }
    }

    // Every line must name a variant. Products own no stock, so a bare-product line could
    // never be reserved or fulfilled against anything - accepting one would create an order
    // the seller can never dispatch. This is the service-level backstop; the DTO also
    // requires `variantId` per line.
    for (const item of createOrderDto.items ?? []) {
      if (!item.variantId || item.variantId.trim?.() === '') {
        throw new AppException(AppErrorCode.VALIDATION_REQUIRED, {
          field: 'items[].variantId',
          productName: item.productName,
        });
      }
    }

    let itemsTotal = 0;
    // D12 (seller-dashboard Phase 2): the seller's pre-discount unit price at purchase
    // time, snapshotted on every line so analytics can later split gross from net without
    // touching currency conversions. Written even when there is none (`null` = no discount
    // recorded); never backfilled into legacy orders.
    const items = (createOrderDto.items || []).map(item => {
      let price = item.price;
      let weight = item.weight;
      let originalPrice: number | null = null;
      let product: { price: number; weight: number; originalPrice: number | null } | undefined;

      if (item.productId) {
        product = productMap.get(item.productId);
        if (!product) {
          throw new AppException(AppErrorCode.ORDER_PRODUCT_NOT_AVAILABLE, { name: item.productName });
        }
        price = product.price;
        if (!weight || weight <= 0) {
          weight = product.weight;
        }
      }

      let variantId: string | undefined;
      let sku: string | undefined;
      let variantSnapshot: any;
      let image: string | undefined;

      if (item.variantId) {
        const snapshot = snapshots.get(item.variantId);
        if (!snapshot) {
          // Refusing rather than silently dropping the variant is deliberate: accepting the
          // line would create an order that reserves nothing, so the seller would confirm it
          // and dispatch it with stock never checked.
          throw new AppException(AppErrorCode.VARIANT_NOT_FOUND, {
            variantId: item.variantId,
            productName: item.productName,
          });
        }
        if (item.productId && snapshot.productId !== item.productId) {
          // A line pairing a variant with a different product would reserve stock against one
          // catalogue entry while billing for another.
          throw new AppException(AppErrorCode.VARIANT_NOT_FOUND, {
            variantId: item.variantId,
            productId: item.productId,
            reason: 'variant_belongs_to_another_product',
          });
        }
        if (storeRef.storeId && snapshot.storeId && snapshot.storeId !== String(storeRef.storeId)) {
          throw new AppException(AppErrorCode.VARIANT_NOT_FOUND, {
            variantId: item.variantId,
            reason: 'variant_belongs_to_another_store',
          });
        }

        variantId = snapshot.variantId;
        sku = snapshot.sku ?? undefined;
        variantSnapshot = snapshot.snapshot;
        image = snapshot.image ?? undefined;
        // Spec §7.4 "unit price": the price actually charged is the variant's override when
        // it has one, falling back to the product price. A storefront line is priced only from
        // server-side data; the client-sent price must never win (spec §7.2 rule 7, "do not
        // trust stock/price values sent by the client"). A vendor's manual order keeps its
        // editable line price: the seller may be recording a negotiated/adjusted sale.
        if (user) {
          price = snapshot.priceOverride ?? price;
          originalPrice = snapshot.compareAtPrice ?? product?.originalPrice ?? null;
        } else {
          const variantProduct = productMap.get(snapshot.productId);
          if (snapshot.priceOverride === null || snapshot.priceOverride === undefined) {
            if (!variantProduct) {
              throw new AppException(AppErrorCode.ORDER_PRODUCT_NOT_AVAILABLE, {
                name: item.productName,
              });
            }
            price = variantProduct.price;
            if (!weight || weight <= 0) {
              weight = variantProduct.weight;
            }
          } else {
            price = snapshot.priceOverride;
          }
          originalPrice = snapshot.compareAtPrice ?? variantProduct?.originalPrice ?? null;
        }
      }

      itemsTotal += price * item.quantity;
      // Every line gets a stable identifier at creation time so inventory
      // reservations can address a single line. `(orderId, variantId)` alone is
      // ambiguous when the same variant is ordered twice on one order.
      return {
        ...item,
        price,
        originalPrice,
        weight: weight || item.weight,
        lineId: new Types.ObjectId().toHexString(),
        ...(variantId ? { variantId } : {}),
        ...(sku ? { sku } : {}),
        ...(variantSnapshot ? { variantSnapshot } : {}),
        ...(image ? { image } : {}),
      };
    });

    // A vendor entering an order by hand can see the stock count, so a line with nothing left
    // to ship is a mistake rather than a market reality - unlike a storefront checkout, which
    // the advisory check at the end of this method deliberately never blocks. `req.user` only
    // ever reaches here from the authenticated `POST /orders/vendor` route: `POST /orders` is
    // `@Public()`, and that guard returns before token validation, so `user` is undefined on
    // the storefront path and its contract is untouched.
    if (user) {
      await this.reservationsService.assertLinesInStock(items);
    }

    // Storefront shipping is resolved from the store's fee table; a vendor's manual order keeps
    // the fee the seller entered. Either way the stored total is derived here, never trusted
    // from the request.
    const shippingFee = user
      ? createOrderDto.shippingFee || 0
      : await this.resolveStoreShippingFee(
          storeRef.storeId,
          storeRef.vendorEmail,
          createOrderDto.customer?.wilaya,
          createOrderDto.shippingMethod,
        );
    const total = itemsTotal + shippingFee;

    // A public checkout may not pin the carrier: the store's wilaya attribution (or its enabled
    // default) decides. A vendor entering an order by hand may still choose.
    let deliveryCompanyId: string | undefined = user ? createOrderDto.deliveryCompanyId : undefined;
    if (!deliveryCompanyId && createOrderDto.vendorEmail && createOrderDto.customer?.wilaya) {
      deliveryCompanyId = (await this.deliveryService.resolveCompanyForWilaya(
        createOrderDto.vendorEmail,
        createOrderDto.customer.wilaya,
      )) ?? undefined;
    }

    if (createOrderDto.shippingMethod === 'stopdesk') {
      const suppliedStopDeskCode = createOrderDto.stopDeskCode?.trim();
      if (suppliedStopDeskCode) {
        createOrderDto.stopDeskCode = suppliedStopDeskCode;
      } else {
        const stopDeskCode = await this.defaultStopDeskCode(
          deliveryCompanyId,
          createOrderDto.customer?.wilaya,
        );
        if (stopDeskCode) createOrderDto.stopDeskCode = stopDeskCode;
      }
    }

    const placedStatus = (await this.statusesService.getBySlug('placed'))!;

    // `storeId` was already resolved (and validated) at the top of `create()`.
    const storeId = storeRef.storeId;

    let saved: OrderDocument;
    let retries = 0;

    while (true) {
      const nextNumber = await this.generateOrderNo();

      const created = new this.orderModel({
        ...createOrderDto,
        ...(storeId ? { storeId } : {}),
        // The channel is decided here, never accepted from the request: an authenticated
        // vendor entering an order is a manual sale, an unauthenticated storefront checkout
        // is an online one. POS sales are created by their own service.
        source: user ? OrderSource.MANUAL : OrderSource.ONLINE,
        items,
        total,
        shippingFee,
        orderNo: nextNumber,
        // Public checkouts have had their client-supplied dates stripped above, so these fall
        // back to `now`; a vendor's manual entry keeps the date the seller recorded.
        date: createOrderDto.date || now,
        createdAt: createOrderDto.createdAt || now,
        deliveryCompanyId: deliveryCompanyId || undefined,
        status: placedStatus,
        history: [{ status: placedStatus, date: now, user: createOrderDto.createdBy || (user ? 'Vendor' : 'Customer') }],
        updatedAt: now,
      });

      try {
        saved = await created.save();
        if (createOrderDto.vendorEmail) {
          await this.storesService.incrementOrderCount(createOrderDto.vendorEmail, 1);
        }
        break;
      } catch (err: any) {
        if (err.code === 11000 && retries < 3) {
          retries++;
          continue;
        }
        throw err;
      }
    }

    // Phase 4 (roadmap 4.7): advisory stock check at `placed`.
    //
    // Deliberately does NOT block the order. A storefront may legitimately sell a
    // combination that sold out moments ago, and this platform is cash-on-delivery in a
    // market where a seller's own count is often already stale - refusing the order here
    // would lose the sale and teach the customer nothing. The real enforcement point is
    // reservation, at confirmation; this only tells the vendor early.
    const availability = await this.reservationsService
      .checkAdvisoryAvailability(this.inventoryContext(saved))
      .catch((err: any) => {
        // Never let a diagnostic read turn a placed order into a failed request.
        this.logger.warn(`Advisory availability check failed for order ${saved.orderNo}: ${err?.message}`);
        return [] as AdvisoryLine[];
      });

    // HI-7 (b): the short lines ride back on the response as an additive `availability` array,
    // so the storefront can warn the shopper that stock is tight. Placement logic is unchanged -
    // this is the same advisory the logger reports, surfaced to the buyer's client. Anything
    // else returns the untouched document exactly as before.
    if (availability.some((line) => line.isShort)) {
      const view = saved.toObject() as Order & { availability?: AdvisoryLine[] };
      view.availability = availability.filter((line) => line.isShort);
      return view;
    }

    return saved;
  }

  /**
   * In-store (POS) sale: an order that is paid for, handed over and completed the moment it is
   * rung up.
   *
   * Unlike `create()` - which starts at `placed` and waits for a courier - a POS sale has no
   * delivery step, so it is written straight to its terminal `delivered` status with a full
   * `placed -> confirmed -> dispatched -> delivered` history, every entry stamped at the same
   * instant (AD-3.1). That history is not decoration: the reservation engine reserves at
   * `confirmed` and consumes at `dispatched` (spec §7.1 rules 2 and 4), so the two inventory
   * effects a normal order reaches through status changes are driven explicitly here, in the
   * same transaction as the order write. A sale that cannot reserve (sold out) therefore rolls
   * back whole and surfaces as a clean 409 `INSUFFICIENT_STOCK` with no order and no movement
   * left behind.
   *
   * The store is resolved from the session, never from the body (G14): a vendor can only ring
   * up their own catalogue. There is no courier booking - a POS sale is never shipped.
   */
  async createImmediateSale(dto: CreatePosSaleDto, user: RequestUser): Promise<Order> {
    this.assertVendorOrAdmin(user);

    if (!dto.items || dto.items.length === 0) {
      throw new AppException(AppErrorCode.POS_EMPTY_CART);
    }

    const store = await this.storesService.findByVendorIdOrThrow(user.id);
    const storeId = store._id as Types.ObjectId;

    const now = new Date();

    // Read every ordered variant once: the snapshot carries ownership, active state, the
    // price override and the display label the order line keeps forever (roadmap 4.6).
    const snapshots = await this.variantsService.snapshotsForVariants(
      dto.items.map((item) => item.variantId),
    );

    const productIds = [
      ...new Set(
        [...snapshots.values()]
          .map((s) => s.productId)
          .filter((id): id is string => !!id && /^[a-fA-F0-9]{24}$/.test(id)),
      ),
    ];
    const products = productIds.length
      ? await this.productModel
          .find({ _id: { $in: productIds } })
          .select('price nameEn nameFr nameAr originalPrice')
          .lean()
          .exec()
      : [];
    const productById = new Map(products.map((p: any) => [String(p._id), p]));

    let itemsTotal = 0;
    const items = dto.items.map((input) => {
      const snapshot = snapshots.get(input.variantId);
      if (!snapshot) {
        throw new AppException(AppErrorCode.VARIANT_NOT_FOUND, { variantId: input.variantId });
      }
      if (snapshot.storeId && snapshot.storeId !== String(storeId)) {
        throw new AppException(AppErrorCode.VARIANT_NOT_FOUND, {
          variantId: input.variantId,
          reason: 'variant_belongs_to_another_store',
        });
      }
      if (!snapshot.isActive) {
        throw new AppException(AppErrorCode.VARIANT_INACTIVE, { variantId: input.variantId });
      }

      const product = productById.get(snapshot.productId);
      // A variant always resolves to a product (integrity-checked); a missing one means
      // corrupt data. Refuse rather than ring a line up at 0, which would silently give the
      // goods away. A variant price override is enough on its own, so it is exempt.
      if (!product && snapshot.priceOverride == null) {
        throw new AppException(AppErrorCode.ORDER_PRODUCT_NOT_AVAILABLE, {
          variantId: input.variantId,
          productId: snapshot.productId,
        });
      }
      // Server-authoritative price (spec §7.2 rule 7): the variant override wins, then the
      // product price. A client-sent `price` is validated by the DTO and then discarded here.
      const price = snapshot.priceOverride ?? product?.price ?? 0;
      // D12: pre-discount unit price snapshotted at sale time — the variant's compare-at,
      // falling back to the product's `originalPrice`; `null` when none exists (always
      // written on new lines, never backfilled into legacy orders).
      const originalPrice = snapshot.compareAtPrice ?? (product as any)?.originalPrice ?? null;
      itemsTotal += price * input.quantity;

      return {
        productId: snapshot.productId,
        productName:
          product?.nameEn || product?.nameFr || product?.nameAr || snapshot.snapshot?.label || 'POS item',
        quantity: input.quantity,
        price,
        originalPrice,
        lineId: new Types.ObjectId().toHexString(),
        variantId: snapshot.variantId,
        ...(snapshot.sku ? { sku: snapshot.sku } : {}),
        ...(snapshot.snapshot ? { variantSnapshot: snapshot.snapshot } : {}),
        ...(snapshot.image ? { image: snapshot.image } : {}),
      };
    });

    const [placedStatus, confirmedStatus, dispatchedStatus, deliveredStatus] = await Promise.all([
      this.statusesService.getBySlug(OrderStatus.PLACED),
      this.statusesService.getBySlug(OrderStatus.CONFIRMED),
      this.statusesService.getBySlug(OrderStatus.DISPATCHED),
      this.statusesService.getBySlug(OrderStatus.DELIVERED),
    ]);
    if (!placedStatus || !confirmedStatus || !dispatchedStatus || !deliveredStatus) {
      throw new AppException(AppErrorCode.ORDER_INVALID_STATUS, { status: 'pos_lifecycle' });
    }

    const actor = user.fullName || user.email || 'Vendor';
    const orderNo = await this.generateOrderNo();
    const orderId = new Types.ObjectId();
    const note = dto.customer?.note || dto.note;

    // Anonymous walk-in placeholder: the vendor UI reads `order.customer.name` unguarded, so
    // the sub-document must always exist. `wilaya`/`commune` stay empty because a POS sale is
    // `pickup`; the schema hook allows that for pickup only.
    const customer = {
      name: dto.customer?.name?.trim() || 'Walk-in',
      phone: dto.customer?.phone?.trim() || '',
      ...(dto.customer?.email ? { email: dto.customer.email } : {}),
      wilaya: '',
      commune: '',
      ...(note ? { note } : {}),
    };

    const history = [
      { status: placedStatus, date: now, user: actor },
      { status: confirmedStatus, date: now, user: actor },
      { status: dispatchedStatus, date: now, user: actor },
      { status: deliveredStatus, date: now, user: actor },
    ];

    const session = await openTransactionSession(this.orderModel, this.logger);
    let saved: OrderDocument | null = null;
    try {
      await session.withTransaction(async () => {
        const created = new this.orderModel({
          _id: orderId,
          orderNo,
          vendorEmail: store.vendorEmail,
          storeId,
          source: OrderSource.POS,
          shippingMethod: 'pickup',
          paymentMethod: 'CASH',
          customer,
          items,
          total: itemsTotal,
          status: deliveredStatus,
          history,
          date: now,
          createdAt: now,
          updatedAt: now,
          confirmedAt: now,
          confirmedBy: actor,
          dispatchedAt: now,
          inventoryState: { reservedAt: now, fulfilledAt: now },
        });

        // Write the order first so the inventory effects can address it (they set
        // `inventoryState.*` on this document); everything still commits together.
        saved = await created.save({ session });

        const ctx = this.inventoryContext(saved);
        const actorUserId = this.actorUserId({}, user);
        // Reserve then consume - the same two effects a delivery order gathers from
        // `confirmed` then `dispatched`, applied here because a POS sale skips both.
        await this.reservationsService.reserve(ctx, actorUserId, session);
        await this.reservationsService.consume(ctx, actorUserId, session);
      });
    } finally {
      await session.endSession();
    }

    if (!saved) {
      throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { id: String(orderId) });
    }

    // Same courtesy counter as `create()`; a failure here must not fail a committed sale.
    await this.storesService.incrementOrderCount(store.vendorEmail, 1).catch((err: any) => {
      this.logger.warn(
        `POS sale ${orderNo} was saved but the store order count was not incremented: ${err?.message}`,
      );
    });

    return saved;
  }

  /**
   * Projects an order document into the shape the inventory module needs.
   *
   * Keeps the reservation engine free of any dependency on the orders *service*, while the
   * session variant lets a status change and its inventory work share one transaction.
   */
  private inventoryContext(order: OrderDocument): OrderInventoryContext {
    return {
      orderId: order._id as Types.ObjectId,
      orderNo: order.orderNo,
      storeId: (order.storeId as Types.ObjectId) ?? null,
      items: (order.items || []).map((item: any) => ({
        lineId: item.lineId ?? null,
        variantId: item.variantId ?? null,
        productId: item.productId ?? null,
        quantity: item.quantity,
      })),
    };
  }

  async findAll(query: Record<string, string>, user?: RequestUser): Promise<PaginatedOrdersResult> {
    const filter: Record<string, any> = {};
    const orConditions: Record<string, any>[] = [];

    if (query.showDeleted !== 'true') {
      filter.isDeleted = { $ne: true };
    }

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 10));
    const skip = (page - 1) * limit;

    if (user) {
      this.assertVendorOrAdmin(user);
      if (user.role === Role.VENDOR) {
        Object.assign(filter, await this.vendorOrderFilter(user.email));
      } else if (query.vendorEmail) {
        filter.vendorEmail = query.vendorEmail;
      }
    } else if (query.vendorEmail) {
      filter.vendorEmail = query.vendorEmail;
    }

    if (query.orderStatus) {
      filter['status.slug'] = query.orderStatus;
    }

    if (query.search) {
      const term = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      orConditions.push(
        { orderNo: { $regex: term, $options: 'i' } },
        { 'customer.name': { $regex: term, $options: 'i' } },
        { 'customer.phone': { $regex: term, $options: 'i' } },
      );
    }

    if (query.client) filter['customer.name'] = { $regex: query.client.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (query.orderNo) filter.orderNo = { $regex: query.orderNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (query.wilaya) filter['customer.wilaya'] = query.wilaya;
    if (query.commune) filter['customer.commune'] = query.commune;
    if (query.shippingMethod) filter.shippingMethod = query.shippingMethod;
    if (query.createdBy) filter.createdBy = { $regex: query.createdBy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (query.confirmedBy) filter.confirmedBy = { $regex: query.confirmedBy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (query.bureau) filter.bureau = { $regex: query.bureau.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (query.phone) filter['customer.phone'] = { $regex: query.phone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (query.note) filter['customer.note'] = { $regex: query.note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (query.deliveryCompanyId) filter.deliveryCompanyId = query.deliveryCompanyId;
    if (query.productId) filter['items.productId'] = query.productId;
    if (query.source) {
      filter.source = query.source;
    }
    if (query.createdAt) {
      const date = new Date(query.createdAt);
      const next = new Date(date);
      next.setDate(next.getDate() + 1);
      orConditions.push({ createdAt: { $gte: date, $lt: next } });
    } else if (query.createdAtFrom || query.createdAtTo) {
      const dateFilter: Record<string, any> = {};
      if (query.createdAtFrom) dateFilter.$gte = new Date(query.createdAtFrom);
      if (query.createdAtTo) dateFilter.$lte = new Date(query.createdAtTo);
      orConditions.push({ createdAt: dateFilter });
    }
    if (query.confirmedAt) {
      const date = new Date(query.confirmedAt);
      const next = new Date(date);
      next.setDate(next.getDate() + 1);
      filter.confirmedAt = { $gte: date, $lt: next };
    } else if (query.confirmedAtFrom || query.confirmedAtTo) {
      const dateFilter: Record<string, any> = {};
      if (query.confirmedAtFrom) dateFilter.$gte = new Date(query.confirmedAtFrom);
      if (query.confirmedAtTo) dateFilter.$lte = new Date(query.confirmedAtTo);
      filter.confirmedAt = dateFilter;
    }
    if (query.dispatchedAt) {
      const date = new Date(query.dispatchedAt);
      const next = new Date(date);
      next.setDate(next.getDate() + 1);
      filter.dispatchedAt = { $gte: date, $lt: next };
    } else if (query.dispatchedAtFrom || query.dispatchedAtTo) {
      const dateFilter: Record<string, any> = {};
      if (query.dispatchedAtFrom) dateFilter.$gte = new Date(query.dispatchedAtFrom);
      if (query.dispatchedAtTo) dateFilter.$lte = new Date(query.dispatchedAtTo);
      filter.dispatchedAt = dateFilter;
    }
    if (query.statusConfirmation) {
      const term = query.statusConfirmation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      orConditions.push(
        { statusConfirmation: { $regex: term, $options: 'i' } },
      );
    }
    if (query.total) {
      filter.total = Number(query.total);
    } else if (query.minTotal || query.maxTotal) {
      filter.total = {};
      if (query.minTotal) filter.total.$gte = Number(query.minTotal);
      if (query.maxTotal) filter.total.$lte = Number(query.maxTotal);
    }

    if (orConditions.length > 0) {
      filter.$or = orConditions;
    }

    const statusCountsFilter = { ...filter };
    delete statusCountsFilter['status.slug'];

    const allowedSortFields = ['createdAt', 'updatedAt', 'orderNo', 'total', 'date', 'customer.name', 'customer.phone', 'customer.wilaya', 'shippingMethod', 'source'];
    const sortField = allowedSortFields.includes(query.sortBy) ? query.sortBy : 'createdAt';
    const sortOrder = query.order === 'asc' ? 1 : -1;
    const [data, total, statusCountsRaw] = await Promise.all([
      this.orderModel.find(filter).sort({ [sortField]: sortOrder }).skip(skip).limit(limit).exec(),
      this.orderModel.countDocuments(filter).exec(),
      this.orderModel.aggregate([
        { $match: statusCountsFilter },
        { $group: { _id: { $ifNull: ['$status.slug', '$status'] }, count: { $sum: 1 } } },
      ]).exec(),
    ]);

    const statusCounts: Record<string, number> = { All: 0 };
    let allTotal = 0;
    for (const entry of statusCountsRaw) {
      const slug = entry._id ? String(entry._id) : undefined;
      const knownSlug = slug && ORDER_STATUS_VALUES.includes(slug) ? slug : undefined;
      if (knownSlug) {
        statusCounts[knownSlug] = entry.count;
        allTotal += entry.count;
      } else if (slug && slug !== 'null') {
        statusCounts[slug] = entry.count;
        allTotal += entry.count;
      }
    }
    for (const slug of Object.keys(ORDER_STATUS_TRANSITIONS)) {
      if (!(slug in statusCounts)) statusCounts[slug] = 0;
    }
    statusCounts.All = allTotal;

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      statusCounts,
    };
  }

  async findOne(id: string, user?: RequestUser, allowDeleted?: boolean): Promise<Order> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { id });
    if (!allowDeleted && order.isDeleted) {
      throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { id });
    }
    if (user) {
      this.assertVendorOrAdmin(user);
      await this.assertOrderOwnership(order, user);
    }
    return order;
  }

  async findByCustomerPhone(phone: string, query: { page: number; limit: number; status?: string }) {
    const filter: any = { 'customer.phone': phone };
    if (query.status) {
      filter['status.slug'] = query.status;
    }
    const total = await this.orderModel.countDocuments(filter);
    const items = await this.orderModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .exec();
    return { items, total, page: query.page, pages: Math.ceil(total / query.limit) };
  }

  async findByOrderNo(orderNo: string, phone: string): Promise<Order> {
    const order = await this.orderModel.findOne({ orderNo }).exec();
    if (!order) throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { orderNo });
    if (order.customer.phone !== phone) {
      throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { orderNo });
    }
    return order;
  }

  async findOneByCustomer(id: string, phone: string): Promise<Order> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { id });
    if (order.customer.phone !== phone) {
      throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { id });
    }
    return order;
  }

  private getStatusSlug(status: any): string {
    if (!status) return 'placed';
    if (typeof status === 'string') return status;
    return (status as any).slug || 'placed';
  }

  /**
   * Reservation state for one order (roadmap §4.5 `GET /orders/:orderId/inventory`).
   *
   * Diagnostic: the balances remain the truth, this explains them per line.
   */
  async getOrderInventory(id: string, user?: RequestUser) {
    const order = await this.findOne(id, user);
    return this.reservationsService.describeOrder(this.inventoryContext(order as OrderDocument));
  }

  /**
   * Records physical receipt of returned goods (roadmap §4.5, §4.5 `receive-return`).
   *
   * Refuses anything that was never dispatched: a receipt against an order that has not
   * shipped would restock units that are still sitting on the seller's shelf, turning one
   * phantom return into a real stock inflation.
   */
  async receiveReturn(
    id: string,
    dto: ReceiveReturnDto,
    user?: RequestUser,
  ): Promise<{ results: ReturnResult[]; inventory: OrderInventoryDiagnostic }> {
    const order = await this.findOne(id, user) as OrderDocument;
    const slug = this.getStatusSlug(order.status);

    const RECEIVABLE: ReadonlySet<string> = new Set([OrderStatus.DISPATCHED, OrderStatus.IN_TRANSIT, OrderStatus.DELIVERED, OrderStatus.RETURNED]);
    if (!RECEIVABLE.has(slug)) {
      throw new AppException(AppErrorCode.INVALID_ORDER_TRANSITION, {
        orderNo: order.orderNo,
        from: slug,
        reason: 'order_must_be_dispatched_before_a_return_can_be_received',
      });
    }

    // Caller-supplied text is a seller note and must never be able to carry customer PII into
    // the permanent ledger (spec §12), so it is stored on the order rather than the movement.
    const results = await this.reservationsService.receiveReturn(
      this.inventoryContext(order),
      dto.items.map((item) => ({
        orderItemIndex: item.orderItemIndex,
        quantity: item.quantity,
        disposition: item.disposition,
        note: dto.note,
      })),
      this.actorUserId({}, user),
    );

    if (dto.markOrderReturned && slug !== OrderStatus.RETURNED) {
      const returnedStatus = await this.statusesService.getBySlug(OrderStatus.RETURNED);
      if (returnedStatus) {
        await this.claimStatus(id, slug, {
          $set: { status: returnedStatus, updatedAt: new Date() },
          $push: {
            history: {
              status: returnedStatus,
              date: new Date(),
              user: user?.email || 'Vendor',
            },
          },
        });
      }
    }

    return {
      results,
      inventory: await this.reservationsService.describeOrder(this.inventoryContext(order)),
    };
  }

  /**
   * D-1 - atomic status claim.
   *
   * Every status transition must be a single conditional write whose filter asserts the
   * status the caller believes it is moving *from*. A read-then-write (even immediately
   * before the write) lets two concurrent callers both pass the "is this allowed?" check
   * and both apply their side effects - which double-deducts stock, double-books a
   * delivery parcel, and pushes a duplicate history entry. A conditional write cannot
   * interleave: MongoDB matches the document and applies the update atomically, so
   * exactly one caller matches and the loser gets `null`.
   *
   * `null` therefore means "someone else already moved this order", which is a
   * conflict, not a missing document.
   *
   * The filter matches both on-disk shapes: `status` is an embedded `StatusConfig`
   * (`{ slug }`) on current documents, but a bare slug string on the oldest ones. The
   * `$or` keeps pre-migration orders claimable instead of silently failing to match.
   */
  private async claimStatus(
    id: string,
    expectedSlug: string,
    updateData: Record<string, any>,
    session?: ClientSession,
    extraFilter?: Record<string, any>,
  ): Promise<OrderDocument | null> {
    const filter: Record<string, any> = {
      _id: id,
      $or: [{ 'status.slug': expectedSlug }, { status: expectedSlug }],
      // An extra predicate narrows the claim further — the carrier advance adds the owning
      // store, so a claim can never match an order that belongs to somebody else.
      ...(extraFilter ?? {}),
    };
    const result = (await this.orderModel
      .findOneAndUpdate(filter, updateData, { new: true, session })
      .exec()) as unknown as OrderDocument | null;
    return result ?? null;
  }

  /**
   * Moves an order forward because the carrier says so (roadmap §10.3).
   *
   * This is the **only** new public method the status sync needs, and it is deliberately
   * narrow: the sync may ask for an order to move from one status to the next, and nothing
   * else. It cannot confirm an order, dispatch it, cancel it or return it — those stay
   * vendor decisions (§10.1), and the carrier never cancels (§10.2).
   *
   * The write reuses the platform's conditional-claim discipline rather than touching
   * `Order.status` directly:
   *
   * - the claim is conditional on the status the caller believes it moves **from**, so a
   *   vendor who cancelled the order a millisecond earlier wins and the sync writes nothing;
   * - the transition map is consulted, so an advance can never invent a step;
   * - the history entry is attributed to the carrier, so the vendor UI can tell whose change
   *   it was;
   * - the claim is narrowed by the owning store, so a misrouted advance cannot reach another
   *   store's order.
   *
   * Neither `in-transit` nor `delivered` is in `INVENTORY_AFFECTING`, so no reservation work
   * is needed and none is done here — the stock was already consumed at `dispatched`.
   */
  async applyCarrierStatusAdvance(
    orderId: string,
    targetSlug: string,
    expectedSlug: string,
    actor: CarrierStatusAdvanceActor,
    options: { storeId?: string; session?: ClientSession } = {},
  ): Promise<CarrierStatusAdvanceResult> {
    const { storeId, session } = options;

    const existing = await this.findOrderForAdvance(orderId, session);
    if (!existing) {
      throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { id: orderId });
    }

    const orderNo = existing.orderNo;
    const currentSlug = this.getStatusSlug(existing.status);

    // Tenancy: the advance may only ever touch an order the caller's store owns. A store
    // mismatch — or an order that carries no store at all, whose owner cannot be proven — is
    // refused rather than attempted: the order is not ours to move.
    if (storeId && String(existing.storeId ?? '') !== String(storeId)) {
      return {
        applied: false,
        reason: 'order_not_in_store',
        fromStatus: currentSlug,
        toStatus: targetSlug,
        orderNo,
      };
    }

    if (existing.isDeleted) {
      return {
        applied: false,
        conflict: true,
        reason: DELIVERY_STATUS_CONFLICT_CODES.ORDER_DELETED,
        fromStatus: currentSlug,
        toStatus: targetSlug,
        orderNo,
      };
    }

    // A terminal state is never overwritten, and a state the carrier assumed but the order
    // never reached is a conflict the vendor is told about (§10.4).
    const conflict = carrierAdvanceConflict(currentSlug);
    if (conflict) {
      return {
        applied: false,
        conflict: true,
        reason: conflict,
        fromStatus: currentSlug,
        toStatus: targetSlug,
        orderNo,
      };
    }

    if (currentSlug !== expectedSlug) {
      // The order is not where the carrier's signal said it would be. Nothing is written; the
      // next poll re-reads the order and asks again with the right expectation.
      return {
        applied: false,
        conflict: true,
        reason: DELIVERY_STATUS_CONFLICT_CODES.ORDER_STATUS_MOVED,
        fromStatus: currentSlug,
        toStatus: targetSlug,
        orderNo,
      };
    }

    // The transition map is never bypassed: an advance that asks for a step the platform does
    // not know is a bug in the caller, not something to write around.
    this.statusesService.validateTransition(expectedSlug, targetSlug);

    const statusConfig = await this.statusesService.getBySlug(targetSlug);
    if (!statusConfig) {
      throw new AppException(AppErrorCode.ORDER_INVALID_STATUS, { status: targetSlug });
    }

    const now = new Date();
    const updateData: Record<string, any> = {
      $set: { status: statusConfig, updatedAt: now },
      $push: {
        history: {
          status: statusConfig,
          date: now,
          user: actor.user,
        },
      },
    };

    const extraFilter: Record<string, any> = {};
    if (storeId && Types.ObjectId.isValid(storeId)) {
      extraFilter.storeId = new Types.ObjectId(storeId);
    }

    const claimed = await this.claimStatus(
      orderId,
      expectedSlug,
      updateData,
      session,
      Object.keys(extraFilter).length > 0 ? extraFilter : undefined,
    );

    if (!claimed) {
      // The claim lost the race: the order moved between the read and the write. The winner
      // has already applied its own effect, so nothing is written here.
      const current = await this.findOrderForAdvance(orderId, session);
      const actualSlug = current ? this.getStatusSlug(current.status) : 'unknown';
      return {
        applied: false,
        conflict: true,
        reason:
          carrierAdvanceConflict(actualSlug) ??
          DELIVERY_STATUS_CONFLICT_CODES.ORDER_STATUS_MOVED,
        fromStatus: actualSlug,
        toStatus: targetSlug,
        orderNo,
      };
    }

    return {
      applied: true,
      fromStatus: expectedSlug,
      toStatus: targetSlug,
      orderNo: claimed.orderNo ?? orderNo,
    };
  }

  /**
   * Applies the full carrier action matrix (behaviour refactor §3.2, §7.1).
   *
   * This is the new public entry point the poller uses. It differs from
   * `applyCarrierStatusAdvance` in three deliberate ways:
   *
   * - it can apply a **path** in one cycle (`dispatched → in-transit → delivered`);
   * - it can **cancel** through `claimStatusWithInventory`, so reservations are released with
   *   the same semantics as a vendor cancel (and never restored after dispatch);
   * - it can **return** through the carrier-only edges, which are not added to the global
   *   transition map the vendor UI reads.
   *
   * Every step remains a conditional claim on the status it moves from and is narrowed by the
   * owning store. When the caller supplies a session (the poller's per-parcel transaction), the
   * whole action joins it; otherwise a self-contained transaction is opened.
   */
  async applyCarrierOrderAction(
    orderId: string,
    action: CarrierOrderAction,
    expectedSlug: string,
    actor: CarrierStatusAdvanceActor,
    options: { storeId?: string; session?: ClientSession } = {},
  ): Promise<CarrierStatusAdvanceResult> {
    const { storeId, session } = options;
    const target = action.target;

    const existing = await this.findOrderForAdvance(orderId, session);
    if (!existing) {
      throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { id: orderId });
    }

    const orderNo = existing.orderNo;
    const currentSlug = this.getStatusSlug(existing.status);

    if (storeId && String(existing.storeId ?? '') !== String(storeId)) {
      return {
        applied: false,
        reason: 'order_not_in_store',
        fromStatus: currentSlug,
        toStatus: target,
        orderNo,
      };
    }

    if (existing.isDeleted) {
      return {
        applied: false,
        conflict: true,
        reason: DELIVERY_STATUS_CONFLICT_CODES.ORDER_DELETED,
        fromStatus: currentSlug,
        toStatus: target,
        orderNo,
      };
    }

    if (currentSlug !== expectedSlug) {
      return {
        applied: false,
        conflict: true,
        reason: DELIVERY_STATUS_CONFLICT_CODES.ORDER_STATUS_MOVED,
        fromStatus: currentSlug,
        toStatus: target,
        orderNo,
      };
    }

    if (currentSlug === target) {
      return {
        applied: false,
        reason: 'already_in_target_status',
        fromStatus: currentSlug,
        toStatus: target,
        orderNo,
      };
    }

    // Q5: a cancel from `placed`/`confirmed` is only legitimate when a parcel exists.
    if (
      target === OrderStatus.CANCELLED &&
      [OrderStatus.PLACED, OrderStatus.CONFIRMED].includes(currentSlug as OrderStatus) &&
      !existing.deliveryParcelId
    ) {
      return {
        applied: false,
        conflict: true,
        reason: DELIVERY_STATUS_CONFLICT_CODES.ORDER_NOT_DISPATCHED,
        fromStatus: currentSlug,
        toStatus: target,
        orderNo,
      };
    }

    const conflict = carrierActionConflict(currentSlug, target);
    if (conflict) {
      return {
        applied: false,
        conflict: true,
        reason: conflict,
        fromStatus: currentSlug,
        toStatus: target,
        orderNo,
      };
    }

    const steps =
      action.steps && action.steps.length > 0
        ? action.steps.map((step) => String(step).trim().toLowerCase())
        : defaultCarrierSteps(currentSlug, target);

    if (steps.length === 0 || steps[steps.length - 1] !== target) {
      throw new AppException(AppErrorCode.INVALID_ORDER_TRANSITION, {
        orderNo,
        from: currentSlug,
        reason: 'invalid_carrier_action_path',
        target,
      });
    }

    // Validate the whole path before writing anything, so a bad caller cannot leave the order
    // halfway through an invented route.
    let previous = currentSlug;
    for (const step of steps) {
      if (target === OrderStatus.RETURNED) {
        if (!CARRIER_RETURN_EDGES.has(`${previous}→${step}`)) {
          throw new AppException(AppErrorCode.INVALID_ORDER_TRANSITION, {
            orderNo,
            from: previous,
            to: step,
            reason: 'carrier_return_edge_not_allowed',
          });
        }
      } else {
        this.statusesService.validateTransition(previous, step);
      }
      previous = step;
    }

    const extraFilter: Record<string, any> = {};
    if (storeId && Types.ObjectId.isValid(storeId)) {
      extraFilter.storeId = new Types.ObjectId(storeId);
    }
    const narrowedFilter = Object.keys(extraFilter).length > 0 ? extraFilter : undefined;

    return withOptionalSession(this.orderModel, this.logger, session, async (activeSession) => {
      let from = currentSlug;

      for (const step of steps) {
        const statusConfig = await this.statusesService.getBySlug(step);
        if (!statusConfig) {
          throw new AppException(AppErrorCode.ORDER_INVALID_STATUS, { status: step });
        }

        const now = new Date();
        const updateData: Record<string, any> = {
          $set: { status: statusConfig, updatedAt: now },
          $push: {
            history: {
              status: statusConfig,
              date: now,
              user: actor.user,
            },
          },
        };

        const claimed =
          step === OrderStatus.CANCELLED
            ? await this.claimStatusWithInventory(
                orderId,
                from,
                step,
                updateData,
                null,
                activeSession,
                narrowedFilter,
              )
            : await this.claimStatus(orderId, from, updateData, activeSession, narrowedFilter);

        if (!claimed) {
          // The order moved underneath us. Steps already claimed stay committed (the caller's
          // transaction owns them); the next poll re-reads the order and asks again.
          const current = await this.findOrderForAdvance(orderId, activeSession);
          const actualSlug = current ? this.getStatusSlug(current.status) : 'unknown';
          return {
            applied: false,
            conflict: true,
            reason:
              carrierActionConflict(actualSlug, target) ??
              DELIVERY_STATUS_CONFLICT_CODES.ORDER_STATUS_MOVED,
            fromStatus: actualSlug,
            toStatus: target,
            orderNo,
          };
        }

        from = step;
      }

      return {
        applied: true,
        fromStatus: currentSlug,
        toStatus: target,
        orderNo,
      };
    });
  }

  /** Reads one order for a carrier advance, inside the caller's transaction when there is one. */
  private async findOrderForAdvance(
    id: string,
    session?: ClientSession,
  ): Promise<OrderDocument | null> {
    const query = this.orderModel.findById(id);
    if (session) query.session(session);
    return (await query.exec()) as unknown as OrderDocument | null;
  }

  /**
   * Statuses whose transition has to commit together with its inventory effect (spec §7.2
   * rule 4: "reservation and order status transition must be atomic").
   *
   * Written out rather than inferred so the set is reviewable at a glance - a new status added
   * to `ORDER_STATUS_TRANSITIONS` must be considered here, and this list is what makes that
   * visible.
   */
  private static readonly INVENTORY_AFFECTING: ReadonlySet<string> = new Set([
    OrderStatus.CONFIRMED,
    OrderStatus.DISPATCHED,
    OrderStatus.CANCELLED,
  ]);

  /**
   * Claims a status transition and applies its inventory effect in one transaction.
   *
   * This is the fix for the failure mode the phase-4 wiring introduces. Claiming first and
   * reserving afterwards would leave an order marked `confirmed` with nothing reserved if the
   * reservation failed for want of stock - and because `confirmed -> confirmed` is not a legal
   * transition, the vendor's natural retry is rejected, leaving them with an order they can
   * only cancel. Aborting the whole transaction instead means the order stays `placed`, the
   * error surfaces as a clean 409, and confirming again is a working next step.
   */
  private async claimStatusWithInventory(
    id: string,
    expectedSlug: string,
    targetSlug: string,
    updateData: Record<string, any>,
    actorUserId: Types.ObjectId | null,
    session?: ClientSession,
    extraFilter?: Record<string, any>,
  ): Promise<OrderDocument | null> {
    return withOptionalSession(this.orderModel, this.logger, session, async (activeSession) => {
      const claimed = await this.claimStatus(
        id,
        expectedSlug,
        updateData,
        activeSession,
        extraFilter,
      );

      // The claim lost. Returning without touching inventory is not just an optimisation:
      // the caller that won already applied its own inventory effect for this transition.
      if (!claimed) return null;

      await this.reservationsService.onStatusChange(
        this.inventoryContext(claimed),
        expectedSlug,
        targetSlug,
        actorUserId,
        activeSession,
      );

      return claimed;
    });
  }

  /**
   * Writes an edited line set on a `confirmed` order together with its inventory effect.
   *
   * Same shape as `claimStatusWithInventory`, but the inventory step is a reconciliation rather
   * than a transition: the lines that changed release their reservation and the lines that
   * replaced them take one, in the same transaction as the order write. The claim is conditional
   * on the order still sitting in `expectedSlug`, so a cancel or dispatch racing this save either
   * wins outright (and this edit reports a conflict) or never happened.
   */
  private async claimItemEditWithInventory(
    id: string,
    expectedSlug: string,
    updateData: Record<string, any>,
    actorUserId: Types.ObjectId | null,
  ): Promise<OrderDocument | null> {
    const session = await openTransactionSession(this.orderModel, this.logger);
    try {
      let claimed: OrderDocument | null = null;

      await session.withTransaction(async () => {
        claimed = await this.claimStatus(id, expectedSlug, updateData, session);

        // The claim lost: the order moved underneath us, and the caller that won has already
        // applied its own inventory effect for whatever it did.
        if (!claimed) return;

        await this.reservationsService.reconcileEditedLines(
          this.inventoryContext(claimed),
          actorUserId,
          session,
        );
      });

      return claimed;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Soft-deletes an order together with the inventory it was still holding.
   *
   * Deleting an order is the end of that order's life, so it has to settle its stock the same
   * way a cancellation does: a `confirmed` order still has active reservations, and leaving
   * them active would keep units promised to an order nobody can see any more - the seller
   * would see `reserved` never drop and could no longer sell that stock.
   *
   * `release()` only touches `active` reservations, so this is deliberately a no-op for a
   * `placed` order (nothing reserved) and for a dispatched-and-beyond order (already consumed).
   * Deleting must never put back stock that has really left the store.
   *
   * The claim is conditional on the order not already being deleted and runs in the same
   * transaction as the release, so two concurrent deletes cannot both settle the stock.
   */
  private async claimDeleteWithInventory(
    id: string,
    actorUserId: Types.ObjectId | null,
  ): Promise<OrderDocument | null> {
    const session = await openTransactionSession(this.orderModel, this.logger);
    try {
      let claimed: OrderDocument | null = null;

      await session.withTransaction(async () => {
        claimed = (await this.orderModel
          .findOneAndUpdate(
            { _id: id, isDeleted: { $ne: true } },
            { $set: { isDeleted: true, deletedAt: new Date() } },
            { new: true, session },
          )
          .exec()) as unknown as OrderDocument | null;

        // Lost the race to a concurrent delete: the caller that won already released (or never
        // held) this order's stock, so this must not release a second time.
        if (!claimed) return;

        await this.reservationsService.release(this.inventoryContext(claimed), actorUserId, session);
      });

      return claimed;
    } finally {
      await session.endSession();
    }
  }

  async update(id: string, updateOrderDto: UpdateOrderDto, user?: RequestUser): Promise<Order> {
    if (user) {
      this.assertVendorOrAdmin(user);
    }

    const existing = await this.orderModel.findById(id).exec();
    if (!existing) throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { id });
    if (user) {
      await this.assertOrderOwnership(existing, user);
    }

    const existingSlug = this.getStatusSlug(existing.status);

    const {
      status: _,
      expectedUpdatedAt: __,
      history: _history,
      dhdCommune: incomingDhdCommune,
      noestCommune: incomingNoestCommune,
    } = updateOrderDto;

    // H11: update is an explicit whitelist, never a spread of the DTO. Spreading let a caller
    // rewrite audit/ownership columns (`vendorEmail`, `createdAt`, `confirmedAt`, `createdBy`,
    // `statusConfirmation`, `vendorId`) that only the server may set - a vendor could reassign
    // an order to another store's email while `storeId` stayed behind, or backdate/forward-date
    // it. Status, timestamps, history and the store keys below are all server-derived.
    const updateData: Record<string, any> = { updatedAt: new Date() };
    for (const field of ORDERS_UPDATEABLE_FIELDS) {
      const value = (updateOrderDto as Record<string, unknown>)[field];
      if (value !== undefined) updateData[field] = value;
    }

    // DHD commune mapping (DHD-COMMUNE-MAPPING-IMPLEMENTATION-PLAN.md §2.4): the selection is an
    // additive dispatch property, never a replacement for the canonical customer wilaya/commune.
    // The audit fields are server-stamped; the client may only send the identification fields.
    const effectiveWilaya = updateOrderDto.customer?.wilaya ?? existing.customer?.wilaya;
    if (incomingDhdCommune === null) {
      updateData.dhdCommune = null;
    } else if (incomingDhdCommune !== undefined) {
      const normalized = normalizeDhdCommuneSelection(incomingDhdCommune, user?.id ?? null);
      if (!normalized) {
        throw new AppException(AppErrorCode.DELIVERY_COMMUNE_INVALID, {
          orderNo: existing.orderNo,
          wilaya: effectiveWilaya,
        });
      }
      if (Number(normalized.wilayaId) !== Number(effectiveWilaya)) {
        throw new AppException(AppErrorCode.DELIVERY_COMMUNE_INVALID, {
          orderNo: existing.orderNo,
          wilaya: effectiveWilaya,
          selectedWilaya: normalized.wilayaId,
        });
      }
      updateData.dhdCommune = normalized;
    } else if (
      updateOrderDto.customer?.wilaya !== undefined &&
      existing.dhdCommune &&
      Number(existing.dhdCommune.wilayaId) !== Number(effectiveWilaya)
    ) {
      // The order moved to another wilaya: a commune from the old wilaya must never be sent to
      // DHD, so the stale mapping is cleared rather than silently carried over.
      updateData.dhdCommune = null;
    }

    // Noest commune mapping (NOEST-COMMUNE-MAPPING-IMPLEMENTATION-PLAN.md §3.3): identical
    // additive rules to DHD, but independent — a DHD save never clears a Noest selection and vice
    // versa. The selection is dispatch data only; `customer.wilaya`/`customer.commune` stay
    // canonical.
    if (incomingNoestCommune === null) {
      updateData.noestCommune = null;
    } else if (incomingNoestCommune !== undefined) {
      const normalized = normalizeNoestCommuneSelection(incomingNoestCommune, user?.id ?? null);
      if (!normalized) {
        throw new AppException(AppErrorCode.DELIVERY_COMMUNE_INVALID, {
          orderNo: existing.orderNo,
          wilaya: effectiveWilaya,
        });
      }
      if (Number(normalized.wilayaId) !== Number(effectiveWilaya)) {
        throw new AppException(AppErrorCode.DELIVERY_COMMUNE_INVALID, {
          orderNo: existing.orderNo,
          wilaya: effectiveWilaya,
          selectedWilaya: normalized.wilayaId,
        });
      }
      updateData.noestCommune = normalized;
    } else if (
      updateOrderDto.customer?.wilaya !== undefined &&
      existing.noestCommune &&
      Number(existing.noestCommune.wilayaId) !== Number(effectiveWilaya)
    ) {
      updateData.noestCommune = null;
    }

    if (updateOrderDto.expectedUpdatedAt && existing.updatedAt) {
      const expected = new Date(updateOrderDto.expectedUpdatedAt).getTime();
      const actual = new Date(existing.updatedAt).getTime();
      if (Math.abs(expected - actual) > 1000) {
        // D-4: the DTO advertises optimistic concurrency, so a mismatch must reject the
        // write. Logging and continuing meant a vendor could silently overwrite a change
        // made in another tab (or by a colleague) between their read and their save.
        throw new AppException(AppErrorCode.ORDER_CONFLICT, {
          orderNo: existing.orderNo,
          expectedUpdatedAt: updateOrderDto.expectedUpdatedAt,
          actualUpdatedAt: existing.updatedAt,
        });
      }
    }

    // D-5 (revised): the editable window is `placed` (nothing reserved yet) and `confirmed`
    // (reservation held, reconciled with the write below). From `dispatched` on, the units have
    // left the warehouse: rewriting lines would change what was actually shipped, and the stock
    // behind them is already consumed rather than promised, so no reservation could follow it.
    const itemsEditable = existingSlug === 'placed' || existingSlug === 'confirmed';
    if (updateOrderDto.items && !itemsEditable) {
      throw new AppException(AppErrorCode.INVALID_ORDER_TRANSITION, {
        orderNo: existing.orderNo,
        from: existingSlug,
        reason: 'items_locked_after_placed',
      });
    }

    // Editing the lines and moving the status in one save would have to reconcile the
    // reservation and then apply the next transition's inventory effect against the new lines,
    // all in one transaction. Refusing keeps a save to a single operation, which is what both
    // the dialog and the row menu already send (a status change omits `items`, an edit keeps
    // the stored status).
    if (
      existingSlug === 'confirmed' &&
      updateOrderDto.items &&
      updateOrderDto.status &&
      updateOrderDto.status !== existingSlug
    ) {
      throw new AppException(AppErrorCode.INVALID_ORDER_TRANSITION, {
        orderNo: existing.orderNo,
        from: existingSlug,
        to: updateOrderDto.status,
        reason: 'items_and_status_in_one_save',
      });
    }

    if (updateOrderDto.items && existingSlug === 'placed') {
      // Reachable only while the order is still `placed` (the lock above), so these lines hold
      // no reservation yet and the gate can never collide with the order's own stock. Editing a
      // line that has gone empty since the order was filed is refused here for the same reason
      // creation is: the save would otherwise book units that are not there.
      //
      // A `confirmed` order skips this and goes through `reconcileEditedLines` instead: its own
      // reservation is part of what `available` already nets out, so the same gate would refuse
      // a line the order is simply keeping.
      await this.reservationsService.assertLinesInStock(updateOrderDto.items);
    }

    if (updateOrderDto.status && updateOrderDto.status !== existingSlug) {
      if (existingSlug === 'cancelled') {
        throw new AppException(AppErrorCode.ORDER_ALREADY_CANCELLED, { id });
      }
      if (existingSlug === 'delivered') {
        throw new AppException(AppErrorCode.ORDER_ALREADY_DELIVERED, { id });
      }
      this.statusesService.validateTransition(existingSlug, updateOrderDto.status);

      const statusConfig = await this.statusesService.getBySlug(updateOrderDto.status);
      if (!statusConfig) throw new AppException(AppErrorCode.ORDER_INVALID_STATUS, { status: updateOrderDto.status });
      updateData.status = statusConfig;

      if (updateOrderDto.status === 'confirmed') {
        updateData.confirmedAt = new Date();
        updateData.confirmedBy = updateOrderDto.createdBy || 'Vendor';
      }

      if (updateOrderDto.status === 'dispatched') {
        updateData.dispatchedAt = new Date();
      }

      const newHistoryEntry = {
        status: updateData.status,
        date: new Date(),
        user: updateOrderDto.createdBy || user?.email || 'Vendor',
      };
      updateData.$push = { history: newHistoryEntry };
    }

    const effectiveShippingMethod = updateOrderDto.shippingMethod || existing.shippingMethod;
    if (effectiveShippingMethod === 'home') {
      const wilaya = updateOrderDto.customer?.wilaya || existing.customer?.wilaya;
      const commune = updateOrderDto.customer?.commune || existing.customer?.commune;
      if (!wilaya || !commune) throw new AppException(AppErrorCode.ORDER_WILAYA_COMMUNE_REQUIRED);
    }

    if (updateOrderDto.total !== undefined || updateOrderDto.items) {
      const items = updateOrderDto.items || (existing.items as any[]);
      const shippingFee = updateOrderDto.shippingFee ?? existing.shippingFee ?? 0;
      const itemsTotal = items.reduce((sum: number, item: any) => sum + (item.price || 0) * (item.quantity || 0), 0);
      const total = updateOrderDto.total ?? existing.total;
      const expectedMinTotal = itemsTotal + shippingFee;
      if (total < expectedMinTotal - 0.01) {
        throw new AppException(AppErrorCode.ORDER_TOTAL_MISMATCH, { total, subtotal: itemsTotal });
      }
    }

    let effectiveDeliveryCompanyId: string | undefined = (existing as any).deliveryCompanyId;
    if (updateOrderDto.deliveryCompanyId === '') {
      const resolved = await this.deliveryService.resolveCompanyForWilaya(
        existing.vendorEmail,
        updateOrderDto.customer?.wilaya || existing.customer.wilaya,
      );
      updateData.deliveryCompanyId = resolved || undefined;
      effectiveDeliveryCompanyId = resolved ?? undefined;
    } else if (updateOrderDto.deliveryCompanyId !== undefined) {
      effectiveDeliveryCompanyId = updateOrderDto.deliveryCompanyId;
    }

    if (effectiveShippingMethod === 'stopdesk') {
      const submittedStopDeskCode = updateOrderDto.stopDeskCode?.trim();
      if (submittedStopDeskCode) {
        updateData.stopDeskCode = submittedStopDeskCode;
      } else if (updateOrderDto.stopDeskCode !== undefined) {
        // Blank means "pick one for me", not "erase the saved desk"; resolve below instead of
        // writing an empty string over a code the order may already carry.
        delete updateData.stopDeskCode;
      }
      const effectiveStopDeskCode = submittedStopDeskCode || (existing as any).stopDeskCode?.trim();
      if (!effectiveStopDeskCode) {
        const wilaya = updateOrderDto.customer?.wilaya || existing.customer?.wilaya;
        const stopDeskCode = await this.defaultStopDeskCode(effectiveDeliveryCompanyId, wilaya);
        if (stopDeskCode) updateData.stopDeskCode = stopDeskCode;
      }
    }

    const isBecomingDispatched = updateOrderDto.status === 'dispatched' && existingSlug !== 'dispatched';

    // Phase 4 (revised): the parcel is booked *before* the dispatch is claimed. The courier
    // booking is a precondition for dispatching, not a retryable side effect: if the delivery
    // company cannot create the order, the dispatch must fail and the order stay `confirmed`
    // with its stock untouched. An external HTTP call cannot join the claim's transaction, so
    // it runs here, ahead of the claim. The previous order (claim first, book second, record
    // `deliveryError`) could leave an order marked `dispatched` whose parcel had never been
    // created, which is exactly the state this now prevents.
    let bookedParcelId: string | null = null;
    if (isBecomingDispatched && !existing.deliveryParcelId) {
      // Book against the order as it *will* be after this save (the incoming changes merged
      // over the stored document), so a delivery company resolved or reassigned in the same
      // request is the one the parcel is booked against. Only *defined* overrides win: the
      // DTO carries `undefined` for every field the request did not send, and a naive spread
      // would blank the stored `deliveryCompanyId` (and every other stored column) with it.
      const stored = typeof (existing as any).toObject === 'function' ? (existing as any).toObject() : existing;
      const bookingOverrides: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(updateData)) {
        if (value !== undefined) bookingOverrides[key] = value;
      }
      const bookingOrder = { ...(stored as Record<string, unknown>), ...bookingOverrides } as unknown as Order;
      await this.deliveryService.assertCanCreateDelivery(bookingOrder);
      try {
        const { parcelId } = await this.deliveryService.createDeliveryForOrder(bookingOrder);
        bookedParcelId = parcelId;
      } catch (err: any) {
        // Record why for the order card (best effort), then surface the failure so the vendor
        // can retry. The order has not moved: nothing below this line has run.
        await this.orderModel
          .updateOne({ _id: id }, { $set: { deliveryError: err?.message ?? 'Delivery booking failed' } })
          .exec();
        throw err;
      }
    }

    // The parcel id rides on the same conditional write that moves the status, so a dispatched
    // order can never exist without the parcel that shipped it.
    if (bookedParcelId) {
      updateData.deliveryParcelId = bookedParcelId;
      updateData.deliveryError = null;
    }

    // D-1: when a transition was requested the write must be conditional on the status we
    // validated against. Without the predicate the whole status block above is advisory -
    // two concurrent callers both pass every check and both write. The claim is what makes
    // "exactly once" achievable; the side-effect guards below (delivery parcel, inventory)
    // are only safe because of it.
    let updated: OrderDocument | null;
    if (updateOrderDto.status && updateOrderDto.status !== existingSlug) {
      if (OrdersService.INVENTORY_AFFECTING.has(updateOrderDto.status)) {
        updated = await this.claimStatusWithInventory(
          id,
          existingSlug,
          updateOrderDto.status,
          updateData,
          this.actorUserId(updateOrderDto, user),
        );
      } else {
        updated = await this.claimStatus(id, existingSlug, updateData);
      }

      if (!updated) {
        // The claim lost. Either the document is gone, or it moved on underneath us.
        if (bookedParcelId) {
          // Rare: a concurrent writer moved the order between the read and the claim, so the
          // parcel just booked has nothing to attach to. Surface it for manual cleanup.
          this.logger.warn(
            `Order ${existing.orderNo}: parcel ${bookedParcelId} was booked but the dispatch claim lost; order not moved, parcel not attached`,
          );
        }
        const current = await this.orderModel.findById(id).exec();
        if (!current) throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { id });
        throw new AppException(AppErrorCode.ORDER_CONFLICT, {
          orderNo: current.orderNo,
          expectedStatus: existingSlug,
          actualStatus: this.getStatusSlug(current.status),
        });
      }
    } else if (updateOrderDto.items && existingSlug === 'confirmed') {
      // A `confirmed` order still holds the reservation its lines were confirmed with. Writing
      // the new items without touching it would leave the old lines promised forever — the
      // exact leak this path exists to close — so the write, the release of the lines that
      // changed and the reservation of the lines that replace them commit together. The claim
      // stays conditional on the order still being `confirmed`: a concurrent cancel or dispatch
      // must never interleave its own inventory effect with ours.
      updated = await this.claimItemEditWithInventory(
        id,
        existingSlug,
        updateData,
        this.actorUserId(updateOrderDto, user),
      );
    } else {
      updated = await this.orderModel.findByIdAndUpdate(id, updateData, { new: true }).exec();
    }

    if (!updated) throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { id });

    // H12: the trail records who moved an order and what changed, never the payload itself.
    if (updateOrderDto.status && updateOrderDto.status !== existingSlug) {
      await this.auditService.record({
        action: AuditAction.ORDER_STATUS_CHANGE,
        actorId: user?.id ?? null,
        actorEmail: user?.email ?? null,
        storeId: (existing as any).storeId ? String((existing as any).storeId) : null,
        resourceType: ResourceType.ORDER,
        resourceId: String(updated._id),
        details: {
          orderNo: updated.orderNo,
          from: existingSlug,
          to: updateOrderDto.status,
        },
      });
    } else if (updateOrderDto.items) {
      await this.auditService.record({
        action: AuditAction.ORDER_UPDATE,
        actorId: user?.id ?? null,
        actorEmail: user?.email ?? null,
        storeId: (existing as any).storeId ? String((existing as any).storeId) : null,
        resourceType: ResourceType.ORDER,
        resourceId: String(updated._id),
        details: { orderNo: updated.orderNo, operation: 'items_edit', lineCount: updateOrderDto.items.length },
      });
    }

    return updated;
  }

  /**
   * Best-effort default stop desk for an order that has none. A discovery failure must not stop
   * the order itself from being placed: the carrier booking will still surface its own error if
   * the desk is genuinely required, and the seller can retry after the sync finishes.
   */
  private async defaultStopDeskCode(
    companyId: string | undefined,
    wilayaCode: string | undefined,
  ): Promise<string | undefined> {
    if (!companyId || !wilayaCode) return undefined;
    try {
      return (await this.deliveryService.resolveDefaultStopDesk(companyId, wilayaCode)) ?? undefined;
    } catch (err: any) {
      this.logger.warn(
        `Could not resolve a default stop desk for ${companyId}/${wilayaCode}: ${err?.message ?? err}`,
      );
      return undefined;
    }
  }

  /** The acting user id for movement attribution; null when the caller is anonymous. */
  private actorUserId(dto: { createdBy?: string }, user?: RequestUser): Types.ObjectId | null {
    const raw = user?.id ?? dto.createdBy;
    return raw && Types.ObjectId.isValid(raw) ? new Types.ObjectId(raw) : null;
  }

  async remove(id: string, user?: RequestUser): Promise<{ id: string; deleted: true }> {
    if (user) {
      this.assertVendorOrAdmin(user);
    }

    const existing = await this.orderModel.findById(id).exec();
    if (!existing) throw new AppException(AppErrorCode.ORDER_NOT_FOUND, { id });
    if (user) {
      await this.assertOrderOwnership(existing, user);
    }

    if (existing.isDeleted) {
      throw new AppException(AppErrorCode.ORDER_ALREADY_DELETED, { id });
    }

    // The soft-delete and the release of the units the order was still holding commit together,
    // so deleting a `confirmed` order gives its stock back exactly like a cancellation does.
    const claimed = await this.claimDeleteWithInventory(id, this.actorUserId({}, user));
    if (!claimed) {
      throw new AppException(AppErrorCode.ORDER_ALREADY_DELETED, { id });
    }

    await this.auditService.record({
      action: AuditAction.ORDER_UPDATE,
      actorId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      storeId: (existing as any).storeId ? String((existing as any).storeId) : null,
      resourceType: ResourceType.ORDER,
      resourceId: id,
      details: { orderNo: existing.orderNo, operation: 'delete' },
    });

    return { id, deleted: true };
  }

  async bulkAction(bulkActionDto: BulkActionDto, user?: RequestUser): Promise<{ modifiedCount: number; errors?: string[] }> {
    const { ids, action } = bulkActionDto;

    const baseFilter: Record<string, any> = { _id: { $in: ids } };
    if (user) {
      this.assertVendorOrAdmin(user);
      if (user.role === Role.VENDOR) {
        Object.assign(baseFilter, await this.vendorOrderFilter(user.email));
      }
    }

    if (action === 'delete') {
      // Delete goes through the same per-order claim as a status change: removing a `confirmed`
      // order has to release the reservations it was holding, which a single bulk write cannot
      // do, and a per-order loop lets the batch report which orders failed instead of silently
      // skipping them.
      const actorUserId = this.actorUserId({}, user);
      const orders = await this.orderModel.find({ ...baseFilter, isDeleted: { $ne: true } }).exec();
      const deleteErrors: string[] = [];
      let deleteCount = 0;

      for (const order of orders) {
        try {
          const claimed = await this.claimDeleteWithInventory(String(order._id), actorUserId);
          if (claimed) {
            deleteCount += 1;
          } else {
            deleteErrors.push(`Order ${order.orderNo}: already deleted, skipped`);
          }
        } catch (err: any) {
          deleteErrors.push(`Order ${order.orderNo}: ${err?.message ?? 'Inventory update failed'}`);
        }
      }

      const deleteResponse: { modifiedCount: number; errors?: string[] } = { modifiedCount: deleteCount };
      if (deleteErrors.length > 0) deleteResponse.errors = deleteErrors;
      return deleteResponse;
    }

    const targetSlug: OrderStatus = action === 'confirm' ? OrderStatus.CONFIRMED : OrderStatus.CANCELLED;
    const now = new Date();

    const orders = await this.orderModel.find(baseFilter).exec();
    const errors: string[] = [];

    const targetStatusConfig = (await this.statusesService.getBySlug(targetSlug))!;

    // D-2: `bulkWrite` sent an unconditional `{ _id }` filter, so the transition legality
    // checked above was advisory only. Any order that moved between the `find()` and the
    // bulk write was overwritten regardless, and the write could not be re-run safely -
    // a retry after a partial failure would push a second history entry. Per-order
    // conditional claims make this path exactly-once and safe to retry.
    let modifiedCount = 0;
    for (const order of orders) {
      const slug = this.getStatusSlug(order.status);

      if (slug === 'cancelled') {
        errors.push(`Order ${order.orderNo}: This order has already been cancelled`);
        continue;
      }
      if (slug === 'delivered') {
        errors.push(`Order ${order.orderNo}: This order has already been delivered`);
        continue;
      }

      try {
        this.statusesService.validateTransition(slug, targetSlug);
      } catch {
        errors.push(`Order ${order.orderNo}: Cannot transition from '${slug}' to '${targetSlug}'`);
        continue;
      }

      const actorUserId = this.actorUserId({}, user);

      // Phase 4: confirm reserves and cancel releases, so both run inside the transaction
      // that moves the status. One bad order must not roll back its neighbours - hence the
      // per-order transaction rather than one transaction around the whole batch.
      let claimed: OrderDocument | null = null;
      try {
        claimed = await this.claimStatusWithInventory(
          String(order._id),
          slug,
          targetSlug,
          {
            $set: {
              status: targetStatusConfig,
              updatedAt: now,
              ...(targetSlug === OrderStatus.CONFIRMED
                ? { confirmedAt: now, confirmedBy: user?.email || 'Vendor' }
                : {}),
            },
            $push: {
              history: {
                status: targetStatusConfig,
                date: now,
                user: user?.email || 'Vendor',
              },
            },
          },
          actorUserId,
        );
      } catch (err: any) {
        // The status write was rolled back with the inventory work, so the order is
        // untouched and the seller is told which line failed rather than being told the
        // batch simply "did not apply".
        errors.push(`Order ${order.orderNo}: ${err?.message ?? 'Inventory update failed'}`);
        continue;
      }

      if (claimed) {
        modifiedCount += 1;
      } else {
        // Lost the race - another actor already moved this order. Report it rather than
        // counting it, so `modifiedCount` never claims a transition that did not happen.
        errors.push(`Order ${order.orderNo}: Status changed while processing, skipped`);
      }
    }

    const response: { modifiedCount: number; errors?: string[] } = { modifiedCount };
    if (errors.length > 0) response.errors = errors;
    return response;
  }

  async bulkShip(bulkShipDto: BulkShipDto, user?: RequestUser): Promise<BulkOrderResult[]> {
    const { ids } = bulkShipDto;

    const baseFilter: Record<string, any> = { _id: { $in: ids } };
    if (user) {
      this.assertVendorOrAdmin(user);
      if (user.role === Role.VENDOR) {
        Object.assign(baseFilter, await this.vendorOrderFilter(user.email));
      }
    }

    const orders = await this.orderModel.find(baseFilter).exec();

    if (orders.length === 0) {
      return [];
    }

    const dispatchedStatus = (await this.statusesService.getBySlug(OrderStatus.DISPATCHED))!;
    const now = new Date();
    const actorUserId = this.actorUserId({}, user);

    // Book the parcels *before* any status is claimed. As in `update()`, the courier booking is
    // a precondition for dispatching rather than a retryable side effect: an order whose parcel
    // cannot be created stays `confirmed` with its stock untouched, instead of being marked
    // `dispatched` with a recorded error. The bulk call is per order, so a failure only skips
    // its own order and the confirmed neighbours still ship.
    const results: BulkOrderResult[] = [];
    const shippable: OrderDocument[] = [];

    for (const order of orders) {
      // ME-13: a non-confirmed order is skipped per order, not a batch-wide refusal. The
      // confirmed neighbours still ship.
      if (this.getStatusSlug(order.status) !== OrderStatus.CONFIRMED) {
        results.push({
          orderNo: order.orderNo,
          success: false,
          error: 'Only confirmed orders can be shipped',
        });
        continue;
      }
      shippable.push(order);
    }

    if (shippable.length === 0) {
      return results;
    }

    // The bulk path never opens the order dialog, so a stopdesk order created before the
    // default was available can still lack a carrier desk code. Resolve it against the same
    // first pickup point the dialog would show, and persist it with the dispatch claim.
    const resolvedStopDeskCodes = new Map<string, string>();
    for (const order of shippable) {
      if (order.shippingMethod === 'stopdesk' && !order.stopDeskCode?.trim()) {
        const stopDeskCode = await this.defaultStopDeskCode(
          order.deliveryCompanyId,
          order.customer?.wilaya,
        );
        if (stopDeskCode) {
          order.stopDeskCode = stopDeskCode;
          resolvedStopDeskCodes.set(String(order._id), stopDeskCode);
        }
      }
    }

    const bookingResults = await this.deliveryService.createBulkDeliveriesForOrders(shippable);
    const bookingByOrderNo = new Map(bookingResults.map((r) => [r.orderNo, r]));

    for (const order of shippable) {
      const booking = bookingByOrderNo.get(order.orderNo);

      if (!booking || !booking.success || !booking.parcelId) {
        // The courier refused the parcel, so the order is not dispatched. Record why and move on.
        const error = booking?.error ?? 'Delivery booking failed';
        await this.orderModel.updateOne({ _id: order._id }, { $set: { deliveryError: error } }).exec();
        results.push({ orderNo: order.orderNo, success: false, error, code: booking?.code });
        continue;
      }

      // Phase 4 (roadmap 4.3): the stock deduction joins the claim's transaction, and the
      // parcel id rides on the same conditional write, so a dispatched order always has the
      // parcel that shipped it. An order whose deduction cannot be made - a line whose variant
      // was deactivated since it was confirmed, say - stays `confirmed`.
      let claimed: OrderDocument | null = null;
      try {
        claimed = await this.claimStatusWithInventory(
          String(order._id),
          OrderStatus.CONFIRMED,
          OrderStatus.DISPATCHED,
          {
            $set: {
              status: dispatchedStatus,
              dispatchedAt: now,
              updatedAt: now,
              deliveryParcelId: booking.parcelId,
              deliveryError: null,
              ...(resolvedStopDeskCodes.has(String(order._id))
                ? { stopDeskCode: resolvedStopDeskCodes.get(String(order._id)) }
                : {}),
            },
            $push: {
              history: {
                status: dispatchedStatus,
                date: now,
                user: user?.email || 'Vendor',
              },
            },
          },
          actorUserId,
        );
      } catch (err: any) {
        // The stock deduction rolled the claim back, so the order is untouched. The parcel was
        // already booked, so surface it for manual cleanup.
        this.logger.warn(
          `Order ${order.orderNo}: parcel ${booking.parcelId} was booked but the dispatch claim failed; ${err?.message}`,
        );
        results.push({
          orderNo: order.orderNo,
          success: false,
          error: err?.message ?? 'Stock deduction failed; order not dispatched',
        });
        continue;
      }

      if (claimed) {
        results.push({ orderNo: order.orderNo, success: true, parcelId: booking.parcelId });
      } else {
        this.logger.warn(
          `Order ${order.orderNo}: parcel ${booking.parcelId} was booked but the dispatch claim lost; order not moved`,
        );
        results.push({
          orderNo: order.orderNo,
          success: false,
          error: 'Status changed while processing, skipped',
        });
      }
    }

    return results;
  }
}
