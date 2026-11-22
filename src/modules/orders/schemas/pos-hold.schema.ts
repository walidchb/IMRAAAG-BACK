import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type PosHoldDocument = PosHold & Document;

/**
 * One line of a parked POS sale. The shape mirrors an order line (the same snapshot is
 * copied onto the committed `Order`), plus the two display-only fields the register keeps
 * so a resumed cart renders exactly as it was left: `barcode` and `available`.
 */
export interface PosHoldItem {
  variantId: string;
  productId: string;
  productName: string;
  quantity: number;
  price: number;
  originalPrice?: number | null;
  lineId?: string;
  sku?: string;
  barcode?: string | null;
  available?: number;
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
  /** Present on a component line of a Box; links it to `bundles[].contents[].lineId`. */
  bundleGroupId?: string;
  /** Reference unit price at hold time — history only; the charge is the Box price. */
  bundleReferencePrice?: number;
}

/**
 * Immutable commercial Box snapshot for a parked sale (same shape as `Order.bundles[]`), plus
 * a display-only `availableBoxes` the register uses when a held cart is resumed.
 */
export interface PosHoldBundle {
  bundleId: string;
  bundleGroupId: string;
  slug?: string;
  nameEn: string;
  nameAr: string;
  nameFr: string;
  image?: string;
  price: number;
  requiredQuantity: number;
  quantity: number;
  lineTotal: number;
  referenceTotal: number;
  savings: number;
  availableBoxes?: number;
  contents: Array<{
    lineId: string;
    productId?: string;
    variantId?: string;
    productName: string;
    variantLabel?: string;
    sku?: string;
    image?: string;
    quantityPerBox: number;
    referenceUnitPrice: number;
  }>;
}

export interface PosHoldCustomer {
  name?: string;
  phone?: string;
  email?: string;
  note?: string;
}

/**
 * Why the cart was parked. `payment` is the "versement" case (the customer left a deposit or
 * paid part of the amount); `general` is any other note. The register shows this beside the
 * note title so the next cashier knows what the money is for.
 */
export type PosHoldNoteType = 'general' | 'payment';

/**
 * A parked (held) POS sale that already holds its stock.
 *
 * The document's `_id` is deliberately reused as the `Order._id` when the sale is completed,
 * so the inventory reservations and ledger movements written at hold time keep pointing at
 * the final order. That is why `orderNo` is allocated when the hold is created rather than
 * when it is completed.
 *
 * `items`/`customer` are Mixed: they are produced and consumed by `OrdersService` only, and
 * the strict order-item sub-schema would reject the extra display-only fields a resumed cart
 * needs. Every value that matters for money or stock (`price`, `quantity`, `variantId`) is
 * still re-derived server-side from the catalog when the hold is created, updated and
 * completed.
 */
@Schema({ timestamps: true, collection: 'posholds' })
export class PosHold {
  @Prop({ type: 'ObjectId', ref: 'Store', required: true, index: true })
  storeId: Types.ObjectId;

  @Prop({ required: true })
  orderNo: string;

  @Prop({ type: Object, default: null })
  customer?: PosHoldCustomer | null;

  @Prop({ type: String, default: '' })
  note: string;

  /** Short heading the cashier typed, e.g. "Versement 5000" (shown as `title (type)`). */
  @Prop({ type: String, default: '' })
  noteTitle: string;

  /** `general` or `payment` (a deposit/"versement"); `general` is the default. */
  @Prop({ type: String, default: 'general' })
  noteType: PosHoldNoteType;

  @Prop({ type: [Object], default: [] })
  items: PosHoldItem[];

  /** Immutable commercial Box snapshots (same shape as `Order.bundles`). */
  @Prop({ type: [Object], default: [] })
  bundles: PosHoldBundle[];

  @Prop({ type: Number, default: 0 })
  total: number;

  @Prop({ type: String, default: null })
  createdBy?: string | null;
}

export const PosHoldSchema = SchemaFactory.createForClass(PosHold);

// A hold's order number is unique within its store, exactly like an order's is globally.
PosHoldSchema.index({ storeId: 1, orderNo: 1 }, { unique: true });
PosHoldSchema.index({ storeId: 1, createdAt: -1 });
