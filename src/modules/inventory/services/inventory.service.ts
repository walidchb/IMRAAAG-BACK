import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import {
  InventoryBalance,
  InventoryBalanceDocument,
} from '../schemas/inventory-balance.schema';
import { ProductVariant, ProductVariantDocument } from '../schemas/product-variant.schema';
import { Product, ProductDocument } from '../../products/schemas/product.schema';
import { MovementsService } from './movements.service';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { BalanceView } from './inventory-read.service';
import { withOptionalSession } from './session.util';
import {
  DEFAULT_LOW_STOCK_THRESHOLD,
  isLowStock as computeLowStock,
} from './low-stock';

export interface SetOnHandInput {
  storeId: Types.ObjectId;
  variantId: Types.ObjectId;
  quantity: number;
  reason: string;
  note?: string | null;
  actorUserId?: Types.ObjectId | null;
  idempotencyKey?: string | null;
  /** HI-8: when a caller already holds a transaction, the balance + ledger pair joins it. */
  session?: ClientSession | null;
}

export interface AdjustDeltaInput {
  storeId: Types.ObjectId;
  variantId: Types.ObjectId;
  delta: number;
  reason: string;
  note?: string | null;
  actorUserId?: Types.ObjectId | null;
  idempotencyKey?: string | null;
  /** HI-8: when a caller already holds a transaction, the balance + ledger pair joins it. */
  session?: ClientSession | null;
}

export interface BulkAdjustItem {
  variantId: string;
  quantity?: number;
  delta?: number;
}

export interface BulkAdjustResult {
  updated: BalanceView[];
  errors: Array<{ variantId: string; code: string; message: string }>;
}

/**
 * Authoritative stock for variant products.
 *
 * Every mutation here is a single conditional `findOneAndUpdate` carrying its own
 * precondition. MongoDB has no row locks, so the read and the write have to be the same
 * atomic operation — a read-then-write would let two concurrent callers both pass a
 * "is this allowed?" check and both apply.
 *
 * HI-8: the balance write and the ledger row that justifies it run in **one** transaction
 * (`withOptionalSession`, same helper `ReservationsService` uses). Previously the append ran
 * stand-alone after the balance commit, so a failed insert left stock changed with no
 * record — the one thing an append-only ledger must never show.
 */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    @InjectModel(InventoryBalance.name)
    private readonly balanceModel: Model<InventoryBalanceDocument>,
    @InjectModel(ProductVariant.name)
    private readonly variantModel: Model<ProductVariantDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    private readonly movementsService: MovementsService,
  ) {}

  /**
   * Absolute set-on-hand. The resulting `onHand` must stay at or above `reserved`, or the
   * balance would claim more stock is promised than physically exists — so the predicate
   * carries that as well.
   */
  async setOnHand(input: SetOnHandInput): Promise<BalanceView> {
    if (!Number.isInteger(input.quantity) || input.quantity < 0) {
      throw new AppException(AppErrorCode.INVALID_QUANTITY, { quantity: input.quantity });
    }
    if (!input.reason || !input.reason.trim()) {
      throw new AppException(AppErrorCode.ADJUSTMENT_REASON_REQUIRED);
    }

    await this.assertVariantOwnedByStore(input.variantId, input.storeId);

    // HI-8: one transaction for the pre-read, the balance write and the ledger append.
    // The pre-read joins the transaction so `onHandBefore` in the ledger row cannot be a
    // value that was already stale when the write landed.
    return withOptionalSession(
      this.balanceModel,
      this.logger,
      input.session ?? null,
      async (tx) => {
        const before = await this.balanceModel
          .findOne({ variantId: input.variantId })
          .session(tx)
          .exec();
        const onHandBefore = before?.onHand ?? 0;
        const reservedBefore = before?.reserved ?? 0;

        const balance = await this.balanceModel
          .findOneAndUpdate(
            {
              variantId: input.variantId,
              storeId: input.storeId,
              reserved: { $lte: input.quantity },
            },
            {
              $set: {
                onHand: input.quantity,
                // Keeps a plain findOneAndUpdate usable on the first write, when no balance
                // row exists yet and there is nothing to preserve.
                ...(before ? {} : { reserved: 0 }),
              },
            },
            // `upsert` only when there is genuinely no row. With a row present and the
            // `reserved ≤ quantity` predicate failing, an upsert would try to INSERT a
            // second balance for the same variant and die on the unique `variantId` index
            // (a 500) instead of returning null for the typed conflict below — which is
            // exactly the "set onHand below what is reserved" case.
            { new: true, upsert: !before, session: tx },
          )
          .exec();

        if (!balance) {
          throw new AppException(AppErrorCode.RESERVED_STOCK_CONFLICT, {
            variantId: String(input.variantId),
            reserved: reservedBefore,
            requested: input.quantity,
          });
        }

        await this.movementsService.append({
          storeId: input.storeId,
          variantId: input.variantId,
          type: 'initial_stock',
          quantityDelta: input.quantity - onHandBefore,
          onHandBefore,
          onHandAfter: balance.onHand,
          reservedBefore,
          reservedAfter: balance.reserved,
          reason: input.reason,
          note: input.note ?? null,
          actorUserId: input.actorUserId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          session: tx,
        });

        return this.toView(balance, null);
      },
    );
  }

  /**
   * Signed adjustment. `onHand` may never go below zero, and may never drop below the
   * units already reserved — both are enforced by the predicate, not by a prior read.
   */
  async adjustByDelta(input: AdjustDeltaInput): Promise<BalanceView> {
    if (!Number.isInteger(input.delta) || input.delta === 0) {
      throw new AppException(AppErrorCode.INVALID_QUANTITY, { delta: input.delta });
    }
    if (!input.reason || !input.reason.trim()) {
      throw new AppException(AppErrorCode.ADJUSTMENT_REASON_REQUIRED);
    }

    await this.assertVariantOwnedByStore(input.variantId, input.storeId);

    // HI-8: same transaction as setOnHand - pre-read, balance write and ledger append.
    return withOptionalSession(
      this.balanceModel,
      this.logger,
      input.session ?? null,
      async (tx) => {
        const before = await this.balanceModel
          .findOne({ variantId: input.variantId })
          .session(tx)
          .exec();
        const onHandBefore = before?.onHand ?? 0;
        const reservedBefore = before?.reserved ?? 0;

        const target = onHandBefore + input.delta;

        // A negative adjustment has two possible causes; the caller distinguishes them by
        // error code rather than by a follow-up read.
        if (target < 0) {
          throw new AppException(AppErrorCode.INVALID_QUANTITY, {
            delta: input.delta,
            onHand: onHandBefore,
          });
        }
        if (target < reservedBefore) {
          throw new AppException(AppErrorCode.RESERVED_STOCK_CONFLICT, {
            variantId: String(input.variantId),
            reserved: reservedBefore,
            requested: target,
          });
        }

        const filter: Record<string, any> = {
          variantId: input.variantId,
          storeId: input.storeId,
        };

        if (before) {
          filter.onHand = onHandBefore; // optimistic guard against a concurrent adjustment
        } else {
          // First write for this variant: only valid for a positive delta.
          if (input.delta < 0) {
            throw new AppException(AppErrorCode.INVALID_QUANTITY, { delta: input.delta });
          }
          filter.onHand = 0;
        }

        const balance = await this.balanceModel
          .findOneAndUpdate(
            filter,
            { $inc: { onHand: input.delta }, ...(before ? {} : { $setOnInsert: { reserved: 0 } }) },
            { new: true, upsert: !before, session: tx },
          )
          .exec();

        if (!balance) {
          throw new AppException(AppErrorCode.RESERVED_STOCK_CONFLICT, {
            variantId: String(input.variantId),
            message: 'balance changed concurrently',
          });
        }

        await this.movementsService.append({
          storeId: input.storeId,
          variantId: input.variantId,
          type: input.delta > 0 ? 'manual_increase' : 'manual_decrease',
          quantityDelta: input.delta,
          onHandBefore,
          onHandAfter: balance.onHand,
          reservedBefore,
          reservedAfter: balance.reserved,
          reason: input.reason,
          note: input.note ?? null,
          actorUserId: input.actorUserId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          session: tx,
        });

        return this.toView(balance, null);
      },
    );
  }

  /**
   * Applies an absolute set or a signed delta across many variants.
   *
   * Only *existing* variants are touched. A missing id is reported per-item rather than
   * creating a balance, because inventing a variant the seller never created would put a
   * sellable SKU in the catalogue with stock nobody counted.
   */
  async bulkAdjust(
    storeId: Types.ObjectId,
    items: BulkAdjustItem[],
    reason: string,
    actorUserId?: Types.ObjectId | null,
  ): Promise<BulkAdjustResult> {
    if (!reason || !reason.trim()) {
      throw new AppException(AppErrorCode.ADJUSTMENT_REASON_REQUIRED);
    }

    const updated: BalanceView[] = [];
    const errors: BulkAdjustResult['errors'] = [];

    const variantIds = items.map((i) => {
      try {
        return new Types.ObjectId(i.variantId);
      } catch {
        return null;
      }
    });

    const found = await this.variantModel
      .find({
        _id: { $in: variantIds.filter((v): v is Types.ObjectId => v !== null) },
        storeId,
        isDeleted: { $ne: true },
      })
      .select('_id')
      .lean()
      .exec();

    const owned = new Set(found.map((v) => String(v._id)));

    for (const item of items) {
      if (!owned.has(item.variantId)) {
        errors.push({
          variantId: item.variantId,
          code: AppErrorCode.VARIANT_NOT_FOUND,
          message: 'Variant does not exist in this store',
        });
        continue;
      }

      const bothModes = item.quantity !== undefined && item.delta !== undefined;
      if (bothModes || (item.quantity === undefined && item.delta === undefined)) {
        errors.push({
          variantId: item.variantId,
          code: AppErrorCode.INVALID_ADJUSTMENT_MODE,
          message: 'Provide exactly one of quantity or delta',
        });
        continue;
      }

      try {
        const view =
          item.quantity !== undefined
            ? await this.setOnHand({
                storeId,
                variantId: new Types.ObjectId(item.variantId),
                quantity: item.quantity,
                reason,
                actorUserId,
              })
            : await this.adjustByDelta({
                storeId,
                variantId: new Types.ObjectId(item.variantId),
                delta: item.delta as number,
                reason,
                actorUserId,
              });
        updated.push(view);
      } catch (err: any) {
        errors.push({
          variantId: item.variantId,
          code: err?.errorCode ?? AppErrorCode.INVALID_QUANTITY,
          message: err?.message ?? 'Adjustment failed',
        });
      }
    }

    return { updated, errors };
  }

  /**
   * D3 ownership check. A variant in another store is reported as not-found rather than
   * forbidden, so this endpoint cannot be used to discover which variant ids exist.
   */
  async assertVariantAccess(
    variantId: Types.ObjectId,
    storeId: Types.ObjectId,
  ): Promise<void> {
    const variant = await this.variantModel
      .findById(variantId)
      .select('storeId isDeleted')
      .exec();
    if (!variant || String(variant.storeId) !== String(storeId) || variant.isDeleted) {
      throw new AppException(AppErrorCode.TENANT_ACCESS_DENIED, { variantId: String(variantId) });
    }
  }

  /**
   * Sets or clears the low-stock threshold for one variant override, or a product default
   * (spec §6.3).
   *
   * The three levels are kept distinct rather than collapsed: a product default is what a
   * new variant inherits, while an override is that one variant's exception. Clearing is a
   * first-class operation, because the only other way to remove an override would be to
   * guess the value it used to hold.
   *
   * Deliberately *not* a movement. Nothing about physical stock changed, and the ledger is
   * an append-only record of quantities - a settings edit has no place in it.
   */
  async setThreshold(input: {
    storeId: Types.ObjectId;
    variantId?: string;
    productId?: string;
    threshold: number | null;
  }): Promise<{ scope: 'variant' | 'product'; id: string; threshold: number | null }> {
    // Narrowed into locals because the two targets are mutually exclusive at the controller
    // but not in the type system; `input.productId` stays `string | undefined` here.
    const targetVariantId = input.variantId;
    const targetProductId = input.productId;

    if (targetVariantId) {
      const variantId = new Types.ObjectId(targetVariantId);
      await this.assertVariantOwnedByStore(variantId, input.storeId);

      const balance = await this.balanceModel.findOne({ variantId }).exec();
      if (!balance) {
        throw new AppException(AppErrorCode.VARIANT_NOT_FOUND, {
          variantId: targetVariantId,
          reason: 'no_stock_record',
        });
      }

      balance.lowStockThreshold = input.threshold;
      await balance.save();
      return { scope: 'variant', id: targetVariantId, threshold: input.threshold };
    }

    if (!targetProductId) {
      throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, {
        field: 'variantId/productId',
        rule: 'exactly_one_of_variantId_or_productId',
      });
    }

    const productId = new Types.ObjectId(targetProductId);
    const product = await this.productModel
      .findById(productId)
      .select('storeId')
      .lean()
      .exec();
    if (!product || String(product.storeId ?? '') !== String(input.storeId)) {
      throw new AppException(AppErrorCode.PRODUCT_NOT_IN_STORE, { productId: targetProductId });
    }

    await this.productModel
      .updateOne({ _id: productId }, { $set: { lowStockThreshold: input.threshold } })
      .exec();
    return { scope: 'product', id: targetProductId, threshold: input.threshold };
  }

  private async assertVariantOwnedByStore(
    variantId: Types.ObjectId,
    storeId: Types.ObjectId,
  ): Promise<void> {
    await this.assertVariantAccess(variantId, storeId);
  }

  private toView(
    balance: InventoryBalanceDocument,
    threshold: number | null,
  ): BalanceView {
    const available = balance.onHand - balance.reserved;
    // Write responses carry no resolved chain (callers pass `null`), so fall back to the
    // platform default rather than reporting "never low". The read paths resolve the full
    // balance > variant > product chain.
    const effective = threshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
    return {
      variantId: String(balance.variantId),
      onHand: balance.onHand,
      reserved: balance.reserved,
      available,
      lowStockThreshold: effective,
      isLowStock: computeLowStock(available, effective),
    };
  }
}