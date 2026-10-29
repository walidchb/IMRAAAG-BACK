import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import type { StatusConfig } from '../../../common/constants/order-statuses.const';
import { OrderSource, ORDER_SOURCE_VALUES } from '../../../common/constants/order-sources.const';

export type OrderDocument = Order & Document;

@Schema()
export class Order {
  @Prop({ required: true, unique: true })
  orderNo: string;

  /** @deprecated Migration shim — use `storeId`. Retained until store-id migration completes. */
  @Prop({ required: true })
  vendorEmail: string;

  /** Canonical owner reference. Populated by backfill + dual-write during migration. */
  @Prop({ type: Types.ObjectId, ref: 'Store' })
  storeId?: Types.ObjectId;

  @Prop({ type: Date })
  date: Date;

  @Prop({ type: Date })
  createdAt: Date;

  @Prop()
  createdBy: string;

  /**
   * Sales channel. Server-set from the request context, never from the client: storefront
   * orders are `ONLINE`, dashboard-entered orders are `MANUAL`, and in-store sales are `POS`.
   * Defaults to `ONLINE` so every pre-POS document keeps its original meaning.
   */
  @Prop({ type: String, enum: ORDER_SOURCE_VALUES, default: OrderSource.ONLINE })
  source: string;

  @Prop({ type: Date })
  confirmedAt: Date;

  @Prop()
  confirmedBy: string;

  @Prop({ type: Date })
  dispatchedAt: Date;

  @Prop()
  statusConfirmation: string;

  @Prop([
    {
      productId: { type: String },
      productName: { type: String, required: true },
      quantity: { type: Number, required: true },
      price: { type: Number, required: true },
      /**
       * Forward-only (D12, analytics Phase 2): the seller's pre-discount unit price at
       * order time — `variant.compareAtPrice` falling back to `product.originalPrice`.
       * Always written (even as `null` = no discount recorded) on new lines so its *presence*
       * marks coverage; never backfilled. The number the customer paid stays in `price`.
       * No `default` on purpose — a legacy line is identifiable by an absent field.
       */
      originalPrice: { type: Number },
      variantDetails: { type: String },
      weight: { type: Number },
      lineId: { type: String },
      variantId: { type: String },
      sku: { type: String },
      variantSnapshot: {
        type: {
          options: {
            type: [
              {
                _id: false,
                optionKey: { type: String },
                optionName: { type: String },
                value: { type: String },
                valueName: { type: String },
              },
            ],
          },
          label: { type: String },
        },
        default: undefined,
      },
      image: { type: String },
    },
  ])
  items: Array<{
    productId: string;
    productName: string;
    quantity: number;
    price: number;
    /** Forward-only discount snapshot (D12) — `null` = no discount, absent = pre-cutover legacy line. */
    originalPrice?: number | null;
    variantDetails?: string;
    weight?: number;
    lineId?: string;
    variantId?: string;
    sku?: string;
    /** Structured replacement for matching on the `variantDetails` label. */
    variantSnapshot?: {
      options: Array<{
        optionKey: string;
        optionName: string;
        value: string;
        valueName: string;
      }>;
      label: string;
    };
    image?: string;
  }>;

  /**
   * Customer details. `name`/`phone`/`wilaya`/`commune` are enforced by the `pre('validate')`
   * hook below rather than by leaf-level `required` flags: a nested `required` function cannot
   * read the sibling `shippingMethod`, so it could not exempt `pickup` (POS) sales. The hook
   * reproduces the old behaviour exactly for every other shipping method.
   */
  @Prop({
    type: {
      name: { type: String },
      phone: { type: String },
      email: { type: String },
      wilaya: { type: String },
      commune: { type: String },
      address: { type: String },
      note: { type: String },
    },
  })
  customer: {
    name: string;
    phone: string;
    email: string;
    wilaya: string;
    commune: string;
    address: string;
    note?: string;
  };

  @Prop({ required: true })
  total: number;

  @Prop({ type: Object, required: true })
  status: StatusConfig;

  @Prop({ default: 'COD' })
  paymentMethod: string;

  @Prop({ type: String, enum: ['stopdesk', 'home', 'pickup'], required: true })
  shippingMethod: string;

  @Prop()
  bureau: string;

  @Prop()
  shippingFee: number;

  @Prop()
  deliveryCompanyId: string;

  @Prop()
  deliveryParcelId: string;

  /**
   * The normalized carrier delivery status, denormalised from the parcel-status record so the
   * **orders list** can render a status chip without a join (roadmap §11.5).
   *
   * Optional and additive: it is absent on every order that has not been synced, and the UI
   * falls back to the `deliveryparcelstatuses` collection when it is missing or stale. It is
   * never required and never client-supplied.
   */
  @Prop()
  deliveryStatus?: string;

  @Prop()
  deliveryError: string;

  @Prop()
  stopDeskCode: string;

  @Prop({ type: Date })
  updatedAt: Date;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt: Date;

  @Prop({
    type: {
      reservedAt: { type: Date },
      releasedAt: { type: Date },
      fulfilledAt: { type: Date },
      receivedAt: { type: Date },
    },
    default: () => ({}),
  })
  inventoryState: {
    reservedAt?: Date | null;
    releasedAt?: Date | null;
    fulfilledAt?: Date | null;
    receivedAt?: Date | null;
  };

  @Prop([
    {
      status: { type: Object },
      date: { type: Date },
      user: { type: String },
    },
  ])
  history: Array<{ status: StatusConfig; date: Date; user: string }>;
}

export const OrderSchema = SchemaFactory.createForClass(Order);

/**
 * Enforces the customer contact fields for every shipped order while leaving a `pickup`
 * (in-store/POS) sale free to be anonymous.
 *
 * This replaces the leaf-level `required: true` flags that used to sit on the nested paths:
 * those could not see `shippingMethod` (a nested `required` function binds to the value's own
 * subdocument, not the root document), so they could not carve out an exception. The rule is
 * otherwise identical — a present `customer` on a non-pickup order still needs name, phone,
 * wilaya and commune — and it fires only when `customer` is present, so the historical
 * "no customer at all" documents that already validated keep doing so.
 */
OrderSchema.pre('validate', function () {
  const self = this as any;
  const customer = self.customer;
  if (customer && self.shippingMethod !== 'pickup') {
    if (!customer.name) self.invalidate('customer.name', 'Customer name is required');
    if (!customer.phone) self.invalidate('customer.phone', 'Customer phone is required');
    if (!customer.wilaya) self.invalidate('customer.wilaya', 'Customer wilaya is required');
    if (!customer.commune) self.invalidate('customer.commune', 'Customer commune is required');
  }
});

OrderSchema.index({ orderNo: 1 });
OrderSchema.index({ vendorEmail: 1 });
OrderSchema.index({ storeId: 1 });
OrderSchema.index({ source: 1 });
OrderSchema.index({ 'status.slug': 1 });
OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ isDeleted: 1 });
OrderSchema.index({ 'customer.phone': 1 });
// Vendor order-list hot read: session storeId + soft-delete flag, ordered newest first
// (the `find()` default sort, `orders.service.ts`). One compound instead of three separate
// single-field indexes means the scan never falls back to fetching the whole store's orders
// to sort/filter in memory (Phase 8, LO-5). `_id` ties `createdAt` for stable pagination.
OrderSchema.index({ storeId: 1, isDeleted: 1, createdAt: -1, _id: -1 });
