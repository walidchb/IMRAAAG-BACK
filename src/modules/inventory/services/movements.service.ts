import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, PipelineStage, Types } from 'mongoose';
import {
  InventoryMovement,
  InventoryMovementDocument,
  InventoryMovementType,
} from '../schemas/inventory-movement.schema';
import { ProductVariant, ProductVariantDocument } from '../schemas/product-variant.schema';
import { ProductOption, ProductOptionDocument } from '../schemas/product-option.schema';
import {
  VariantOptionValue,
  VariantOptionValueDocument,
} from '../schemas/variant-option-value.schema';
import {
  ProductOptionValue,
  ProductOptionValueDocument,
} from '../schemas/product-option-value.schema';
import { Product, ProductDocument } from '../../products/schemas/product.schema';
import { User, UserDocument } from '../../users/schemas/user.schema';
import { buildVariantLabel, LabelOption, LabelValue } from './variant-label';
export interface AppendMovementInput {
  storeId: Types.ObjectId;
  variantId: Types.ObjectId;
  type: InventoryMovementType;
  quantityDelta: number;
  onHandBefore: number;
  onHandAfter: number;
  reservedBefore: number;
  reservedAfter: number;
  reason?: string | null;
  orderId?: Types.ObjectId | null;
  orderItemIndex?: number | null;
  reservationId?: Types.ObjectId | null;
  actorUserId?: Types.ObjectId | null;
  note?: string | null;
  idempotencyKey?: string | null;
  /**
   * Phase 4: the caller may already hold a transaction. The ledger row and the balance it
   * describes must commit together (spec §11), so the write joins the caller's session
   * rather than opening its own.
   */
  session?: ClientSession | null;
}

export interface MovementView {
  id: string;
  variantId: string;
  type: InventoryMovementType;
  quantityDelta: number;
  onHandBefore: number;
  onHandAfter: number;
  reservedBefore: number;
  reservedAfter: number;
  reason: string | null;
  note: string | null;
  orderId: string | null;
  orderItemIndex: number | null;
  actorUserId: string | null;
  createdAt: Date;
}

/**
 * A ledger row plus the names a seller needs to read it.
 *
 * The enrichment is what separates this from `MovementView`: a history table showing
 * variant ids and actor ids is technically complete and practically useless.
 */
export interface StoreMovementView extends MovementView {
  productId: string | null;
  productName: { en: string; ar: string; fr: string } | null;
  variantLabel: string;
  sku: string | null;
  actorName: string | null;
}

/**
 * Append-only writer for `inventory_movements`.
 *
 * This is the audit trail the balances are derived from. Nothing in the system updates
 * or deletes a movement; a mistake is corrected by appending a `correction` row.
 */
@Injectable()
export class MovementsService {
  constructor(
    @InjectModel(InventoryMovement.name)
    private readonly movementModel: Model<InventoryMovementDocument>,
    @InjectModel(ProductVariant.name)
    private readonly variantModel: Model<ProductVariantDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(VariantOptionValue.name)
    private readonly joinModel: Model<VariantOptionValueDocument>,
    @InjectModel(ProductOption.name)
    private readonly optionModel: Model<ProductOptionDocument>,
    @InjectModel(ProductOptionValue.name)
    private readonly valueModel: Model<ProductOptionValueDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
  ) {}

  /**
   * Writes one movement. Returns the existing row instead of inserting a second one when
   * `idempotencyKey` has been seen before, so a retried request cannot double-count.
   *
   * The dedupe lookup is a plain read *before* the insert rather than only an `E11000`
   * recovery, because a duplicate-key error inside a transaction poisons it: the whole
   * transaction has to abort and the stock change already made in it is lost. Skipping the
   * insert when the key is already present turns a retry into a no-op instead.
   */
  async append(input: AppendMovementInput): Promise<InventoryMovementDocument> {
    if (input.idempotencyKey) {
      const existingQuery = this.movementModel
        .findOne({ idempotencyKey: input.idempotencyKey })
        .session(input.session ?? null);
      const existing = await existingQuery.exec();
      if (existing) return existing;
    }

    try {
      const created = new this.movementModel({
        ...input,
        reason: input.reason ?? null,
        orderId: input.orderId ?? null,
        orderItemIndex: input.orderItemIndex ?? null,
        reservationId: input.reservationId ?? null,
        actorUserId: input.actorUserId ?? null,
        note: input.note ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      });
      return await created.save({ session: input.session ?? undefined });
    } catch (err: any) {
      // E11000 on `idempotencyKey`: a concurrent request won the race with the same key.
      // That request already recorded the movement, so treat this as success.
      if (err?.code === 11000 && input.idempotencyKey) {
        const existing = await this.movementModel
          .findOne({ idempotencyKey: input.idempotencyKey })
          .session(input.session ?? null)
          .exec();
        if (existing) return existing;
      }
      throw err;
    }
  }

  /**
   * Existence check for an idempotency key, session-aware.
   *
   * `append` already skips a duplicate, but the caller needs to know *before* doing its
   * balance work whether this attempt is a retry - otherwise the work is applied and then
   * the movement insert silently returns the earlier row, leaving the two out of step.
   */
  async hasMovement(idempotencyKey: string, session?: ClientSession | null): Promise<boolean> {
    const found = await this.movementModel
      .findOne({ idempotencyKey })
      .select('_id')
      .session(session ?? null)
      .exec();
    return !!found;
  }

  /**
   * Per-variant history, newest first. Deliberately cursor-paginated — this collection
   * grows faster than any other, so an unbounded read is not an option.
   */
  async listForVariant(
    storeId: string,
    variantId: string,
    limit = 50,
    cursor?: string,
  ): Promise<{ data: MovementView[]; nextCursor: string | null }> {
    const filter: Record<string, any> = {
      storeId: new Types.ObjectId(storeId),
      variantId: new Types.ObjectId(variantId),
    };

    if (cursor) {
      filter._id = { $lt: new Types.ObjectId(cursor) };
    }

    const docs = await this.movementModel
      .find(filter)
      .sort({ _id: -1 })
      .limit(Math.min(Math.max(limit, 1), 200))
      .exec();

    const data = docs.map((d) => this.toView(d));
    const last = docs[docs.length - 1];

    return {
      data,
      nextCursor: docs.length === 0 ? null : String(last._id),
    };
  }

  /**
   * Every movement attributed to one order, newest first.
   *
   * Bounded by construction rather than by a `limit`: it only ever returns rows whose
   * `orderId` is this order, and an order has a bounded number of lines times a small,
   * fixed set of lifecycle events. Unlike the per-variant ledger, an order's history cannot
   * grow without bound over time. The hard cap below is purely defensive (LO-3): a runaway
   * caller or loop cannot force an unbounded read.
   */
  async listForOrder(orderId: Types.ObjectId): Promise<MovementView[]> {
    const docs = await this.movementModel
      .find({ orderId })
      .sort({ _id: -1 })
      .limit(500)
      .exec();
    return docs.map((d) => this.toView(d));
  }

  /**
   * Store-wide ledger with filters (spec §10.4).
   *
   * Enriched with the product name, the variant label and the actor's name because the
   * whole point of a history view is that a seller can read it: a column of ObjectIds is not
   * a history. Three `$lookup`s happen *after* the filter, so they only cost anything on the
   * rows actually returned.
   *
   * Cursor-paginated, not offset: this is the fastest-growing collection in the system and
   * an offset would both skip and repeat rows as new movements arrive at the head.
   */
  async listForStore(
    storeId: Types.ObjectId,
    filter: {
      variantIds?: Types.ObjectId[];
      /** Narrows to one variant. Combined with `variantIds` by intersection, not by override. */
      singleVariantId?: Types.ObjectId;
      type?: InventoryMovementType;
      from?: Date;
      to?: Date;
      search?: string;
      limit?: number;
      cursor?: string;
    },
  ): Promise<{ data: StoreMovementView[]; nextCursor: string | null }> {
    const query: Record<string, any> = { storeId };

    if (filter.variantIds) {
      // An empty list means "this product has no variants", which is a real answer of zero
      // rows. `$in: []` would otherwise be skipped and return the entire store's ledger.
      if (filter.variantIds.length === 0) return { data: [], nextCursor: null };
      query.variantId = { $in: filter.variantIds };
    }
    if (filter.singleVariantId) query.variantId = filter.singleVariantId;
    if (filter.type) query.type = filter.type;

    if (filter.from || filter.to) {
      query.createdAt = {};
      if (filter.from) query.createdAt.$gte = filter.from;
      if (filter.to) query.createdAt.$lt = filter.to;
    }

    if (filter.cursor) query._id = { $lt: new Types.ObjectId(filter.cursor) };

    if (filter.search?.trim()) {
      // The ledger search term becomes a regex; escape metacharacters so a query containing
      // `(`, `[`, `*`, … is a literal substring match, not a Mongo 51091 regex error → 500.
      const escaped = filter.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = { $regex: escaped, $options: 'i' };
      query.$or = [{ reason: rx }, { note: rx }];
    }

    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);

    // Collection names are read off the injected models rather than written out. A `$lookup`
    // against a name that does not exist does not throw - it quietly matches nothing - so a
    // hardcoded typo here would blank out a column with no error anywhere.
    const rows = await this.movementModel
      .aggregate([
        { $match: query },
        { $sort: { _id: -1 } },
        { $limit: limit + 1 },
        {
          $lookup: {
            from: this.variantModel.collection.name,
            localField: 'variantId',
            foreignField: '_id',
            as: 'variant',
          },
        },
        { $unwind: { path: '$variant', preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: this.productModel.collection.name,
            localField: 'variant.productId',
            foreignField: '_id',
            as: 'product',
          },
        },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: this.joinModel.collection.name,
            localField: 'variantId',
            foreignField: 'variantId',
            as: 'joins',
          },
        },
        {
          $lookup: {
            from: this.userModel.collection.name,
            localField: 'actorUserId',
            foreignField: '_id',
            as: 'actor',
          },
        },
        { $unwind: { path: '$actor', preserveNullAndEmptyArrays: true } },
        {
          $addFields: {
            sku: { $ifNull: ['$variant.sku', null] },
            productId: { $ifNull: ['$variant.productId', null] },
            productName: {
              en: { $ifNull: ['$product.nameEn', ''] },
              ar: { $ifNull: ['$product.nameAr', ''] },
              fr: { $ifNull: ['$product.nameFr', ''] },
            },
            // A customer-triggered movement has no actor; the UI shows "System" for it.
            actorName: { $ifNull: ['$actor.fullName', { $ifNull: ['$actor.email', null] }] },
          },
        },
        // No second `$limit` here. The `limit + 1` above deliberately fetches one row past the
        // page so `hasMore` can be decided; truncating back to `limit` would discard that row
        // and make the cursor permanently null, silently capping the ledger at one page.
        // Assembled at runtime from a validated query DTO, so it is not statically a
        // `PipelineStage[]`. The cast is confined to this one call.
      ] as PipelineStage[])
      .exec();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    // The label is built in JS, not in the pipeline. It needs option names, and a join row
    // carries only an optionValueId - reaching the option would need a second nested
    // `$lookup` with a `let`/`pipeline` pair, for one string. `buildVariantLabel` is also the
    // same function the matrix uses, so the ledger cannot name a variant differently.
    const dictionary = await this.labelDictionary(storeId);

    return {
      data: page.map((r: any) => ({
        ...this.toView(r as InventoryMovementDocument),
        productId: r.productId ? String(r.productId) : null,
        productName: r.productName ?? null,
        variantLabel: buildVariantLabel(
          (r.joins ?? []).map((j: any) => String(j.optionValueId)),
          dictionary.options,
          dictionary.values,
        ),
        sku: r.sku ?? null,
        actorName: r.actorName ?? null,
      })),
      nextCursor: hasMore && last ? String(last._id) : null,
    };
  }

  /** Option and value metadata for the store, loaded once per ledger request. */
  private async labelDictionary(
    storeId: Types.ObjectId,
  ): Promise<{ options: Map<string, LabelOption>; values: Map<string, LabelValue> }> {
    const [options, values] = await Promise.all([
      this.optionModel.find({ storeId }).lean().exec(),
      this.valueModel.find({ storeId }).lean().exec(),
    ]);
    return {
      options: new Map(options.map((o) => [String(o._id), o])),
      values: new Map(values.map((v) => [String(v._id), v])),
    };
  }

  private toView(doc: InventoryMovementDocument): MovementView {
    return {
      id: String(doc._id),
      variantId: String(doc.variantId),
      type: doc.type,
      quantityDelta: doc.quantityDelta,
      onHandBefore: doc.onHandBefore,
      onHandAfter: doc.onHandAfter,
      reservedBefore: doc.reservedBefore,
      reservedAfter: doc.reservedAfter,
      reason: doc.reason ?? null,
      note: doc.note ?? null,
      orderId: doc.orderId ? String(doc.orderId) : null,
      orderItemIndex: doc.orderItemIndex ?? null,
      actorUserId: doc.actorUserId ? String(doc.actorUserId) : null,
      createdAt: doc.createdAt,
    };
  }
}