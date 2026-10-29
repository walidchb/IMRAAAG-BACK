import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { ProductVariant } from '../inventory/schemas/product-variant.schema';
import { InventoryBalance } from '../inventory/schemas/inventory-balance.schema';
import { ProductOption } from '../inventory/schemas/product-option.schema';
import { ProductOptionValue } from '../inventory/schemas/product-option-value.schema';
import { VariantOptionValue } from '../inventory/schemas/variant-option-value.schema';
import { Product } from '../products/schemas/product.schema';
import {
  buildVariantLabel,
  LabelOption,
  LabelValue,
} from '../inventory/services/variant-label';
import { PosProductQueryDto } from './dto/pos.dto';
import { Order, OrderDocument } from '../orders/schemas/order.schema';

export interface PosOptionValue {
  valueId: string;
  value: string;
  name: { en: string; ar: string; fr: string };
  color: string | null;
}

/** An independent option group (Size, Color, ...); a variant is one value from each group. */
export interface PosOption {
  optionId: string;
  key: string;
  name: { en: string; ar: string; fr: string };
  type: 'text' | 'color';
  values: PosOptionValue[];
}

export interface PosVariant {
  variantId: string;
  label: string;
  sku: string | null;
  barcode: string | null;
  price: number;
  available: number;
  /**
   * The option values this variant joins to. The register composes one value per option group
   * and derives the exact variant from it, so the flat `label` alone is not enough to sell.
   */
  optionValueIds: string[];
}

export interface PosProduct {
  productId: string;
  name: { en: string; ar: string; fr: string };
  slug: string | null;
  image: string | null;
  /** Independent option groups for the register to render (index 0 first). */
  options: PosOption[];
  variants: PosVariant[];
}

export interface PosBarcodeHit extends PosProduct {
  matchedVariantId: string;
}

export interface PosProductPage {
  data: PosProduct[];
  nextCursor: string | null;
  hasMore: boolean;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Read-only catalog for the in-store point of sale (roadmap Phase 1).
 *
 * Two properties this service exists to guarantee:
 *  - **Store isolation.** Every query is filtered on the `storeId` the caller resolved from
 *    their session; no client-supplied identifier is ever accepted. A vendor can only see
 *    and sell their own store's products.
 *  - **One stock truth.** `available` is `max(0, onHand - reserved)`, the exact expression the
 *    storefront's `VariantsService.getAvailability` uses, so the register and the web shop can
 *    never disagree about what is sellable.
 *
 * Variant labels come from the shared `buildVariantLabel`, the same function the matrix,
 * inventory list and movement ledger use — a variant must read identically everywhere.
 */
@Injectable()
export class PosService {
  constructor(
    @InjectModel(ProductVariant.name)
    private readonly variantModel: Model<ProductVariant>,
    @InjectModel(InventoryBalance.name)
    private readonly balanceModel: Model<InventoryBalance>,
    @InjectModel(ProductOption.name)
    private readonly optionModel: Model<ProductOption>,
    @InjectModel(ProductOptionValue.name)
    private readonly valueModel: Model<ProductOptionValue>,
    @InjectModel(VariantOptionValue.name)
    private readonly joinModel: Model<VariantOptionValue>,
    @InjectModel(Product.name)
    private readonly productModel: Model<Product>,
    @InjectModel(Order.name)
    private readonly orderModel: Model<Order>,
  ) {}

  /**
   * Product-grouped catalog search, paged by `productId` ascending.
   *
   * A product is returned with **all** its active variants even when only one of them matched
   * the search term: a cashier who types one size should still be able to pick another. The
   * match therefore only decides *which products* are on the page; the variants are loaded in
   * full afterwards.
   */
  async searchProducts(
    storeId: Types.ObjectId,
    query: PosProductQueryDto,
  ): Promise<PosProductPage> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const cursor =
      query.cursor && Types.ObjectId.isValid(query.cursor)
        ? new Types.ObjectId(query.cursor)
        : null;

    const productIds = await this.resolveProductIds(storeId, query.q, cursor, limit + 1);
    const hasMore = productIds.length > limit;
    const pageIds = hasMore ? productIds.slice(0, limit) : productIds;
    const nextCursor = hasMore ? String(pageIds[pageIds.length - 1]) : null;

    return {
      data: await this.assemble(storeId, pageIds),
      nextCursor,
      hasMore,
    };
  }

  async searchCustomers(
    storeId: Types.ObjectId,
    q?: string,
  ): Promise<{ data: Array<{ name: string; phone: string }> }> {
    const term = q?.trim();
    const filter: Record<string, unknown> = { storeId };
    if (term) {
      const rx = new RegExp(this.escapeRegex(term), 'i');
      filter.$or = [{ 'customer.name': rx }, { 'customer.phone': rx }];
    }
    const rows = await this.orderModel
      .aggregate([
        { $match: filter },
        {
          $group: {
            _id: { name: '$customer.name', phone: '$customer.phone' },
          },
        },
        { $sort: { '_id.name': 1 } },
        { $limit: 20 },
      ])
      .exec();
    return {
      data: rows
        .map((r: any) => ({
          name: r._id?.name || '',
          phone: r._id?.phone || '',
        }))
        .filter((d: { name: string; phone: string }) => d.name || d.phone),
    };
  }

  /**
   * Barcode â†’ the variant's whole product, so the register shows sibling variants too.
   *
   * A barcode that exists but whose product is a draft (or belongs to another store, which
   * the store filter already excludes) is reported as `POS_BARCODE_NOT_FOUND`, not as a
   * partial product: an unscannable code and an unsellable one must look the same at the till.
   */
  async findByBarcode(
    storeId: Types.ObjectId,
    barcode: string,
  ): Promise<PosBarcodeHit> {
    const variant = await this.variantModel
      .findOne({ storeId, barcode, isDeleted: { $ne: true }, isActive: true })
      .lean()
      .exec();
    if (!variant) {
      throw new AppException(AppErrorCode.POS_BARCODE_NOT_FOUND, { barcode });
    }

    const [product] = await this.assemble(storeId, [variant.productId]);
    if (!product) {
      throw new AppException(AppErrorCode.POS_BARCODE_NOT_FOUND, { barcode });
    }
    return { ...product, matchedVariantId: String(variant._id) };
  }

  /**
   * Resolves the page's product ids: one variant-level aggregation that filters by store,
   * liveness, product status, the search term and the cursor, then groups to distinct
   * products (so a term matching several variants of one product yields one row) and pages.
   */
  private async resolveProductIds(
    storeId: Types.ObjectId,
    q: string | undefined,
    cursor: Types.ObjectId | null,
    take: number,
  ): Promise<Types.ObjectId[]> {
    const pipeline: any[] = [
      {
        $match: {
          storeId,
          isDeleted: { $ne: true },
          isActive: true,
          ...(cursor ? { productId: { $gt: cursor } } : {}),
        },
      },
      {
        $lookup: {
          from: this.productModel.collection.name,
          localField: 'productId',
          foreignField: '_id',
          as: 'prod',
        },
      },
      { $unwind: '$prod' },
    ];

    const term = q?.trim();
    if (term) {
      const rx = new RegExp(this.escapeRegex(term), 'i');
      pipeline.push({
        $match: {
          $or: [
            { sku: rx },
            { barcode: rx },
            { 'prod.nameEn': rx },
            { 'prod.nameAr': rx },
            { 'prod.nameFr': rx },
          ],
        },
      });
    }

    pipeline.push({ $group: { _id: '$productId' } }, { $sort: { _id: 1 } }, { $limit: take });

    const rows = (await this.variantModel.aggregate(pipeline).exec()) as { _id: Types.ObjectId }[];
    return rows.map((r) => r._id);
  }

  /**
   * Loads products with all their active variants (labels, price, availability) in a fixed
   * number of queries, preserving the order of `productIds`.
   */
  private async assemble(
    storeId: Types.ObjectId,
    productIds: Types.ObjectId[],
  ): Promise<PosProduct[]> {
    if (productIds.length === 0) return [];

    const products = (await this.productModel
      .find({ _id: { $in: productIds }, storeId })
      .lean()
      .exec()) as any[];
    if (products.length === 0) return [];
    const productById = new Map(products.map((p) => [String(p._id), p]));

    const variants = (await this.variantModel
      .find({
        storeId,
        productId: { $in: productIds },
        isDeleted: { $ne: true },
        isActive: true,
      })
      .sort({ position: 1 })
      .lean()
      .exec()) as any[];

    const variantIds = variants.map((v) => v._id as Types.ObjectId);
    const [balances, joins, dict] = await Promise.all([
      this.balanceModel.find({ variantId: { $in: variantIds } }).lean().exec(),
      this.joinModel.find({ variantId: { $in: variantIds } }).lean().exec(),
      this.labelDictionary(storeId),
    ]);

    const balanceByVariant = new Map(balances.map((b) => [String(b.variantId), b]));
    const valuesByVariant = new Map<string, string[]>();
    for (const join of joins) {
      const key = String(join.variantId);
      const list = valuesByVariant.get(key) ?? [];
      list.push(String(join.optionValueId));
      valuesByVariant.set(key, list);
    }

    const variantsByProduct = new Map<string, PosVariant[]>();
    for (const v of variants) {
      if (!productById.has(String(v.productId))) continue;
      const balance = balanceByVariant.get(String(v._id));
      const onHand = balance?.onHand ?? 0;
      const reserved = balance?.reserved ?? 0;
      const product = productById.get(String(v.productId));
      const item: PosVariant = {
        variantId: String(v._id),
        label: buildVariantLabel(
          valuesByVariant.get(String(v._id)) ?? [],
          dict.options,
          dict.values,
        ),
        sku: v.sku ?? null,
        barcode: v.barcode ?? null,
        price: v.priceOverride ?? product.price ?? 0,
        available: Math.max(0, onHand - reserved),
        optionValueIds: valuesByVariant.get(String(v._id)) ?? [],
      };
      const list = variantsByProduct.get(String(v.productId)) ?? [];
      list.push(item);
      variantsByProduct.set(String(v.productId), list);
    }

    const valuesByProduct = new Map<string, PosOption[]>();
    const valuesByOption = new Map<string, any[]>();
    for (const value of dict.values.values()) {
      const v = value as any;
      const key = String(v.optionId);
      const list = valuesByOption.get(key) ?? [];
      list.push(v);
      valuesByOption.set(key, list);
    }

    // Option groups come from the same store-wide dictionary the labels are built from, grouped
    // per product and ordered by position so the register always shows Size before Color.
    const orderedOptions = [...dict.options.values()].sort(
      (a, b) => ((a as any).position ?? 0) - ((b as any).position ?? 0),
    );
    for (const option of orderedOptions) {
      const o = option as any;
      const values: PosOptionValue[] = (valuesByOption.get(String(o._id)) ?? [])
        .filter((v) => v.isActive !== false)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((v) => ({
          valueId: String(v._id),
          value: v.value ?? '',
          name: {
            en: v.valueEn ?? v.value ?? '',
            ar: v.valueAr ?? v.valueEn ?? v.value ?? '',
            fr: v.valueFr ?? v.valueEn ?? v.value ?? '',
          },
          color: v.color ?? null,
        }));
      const pid = String(o.productId);
      const list = valuesByProduct.get(pid) ?? [];
      list.push({
        optionId: String(o._id),
        key: o.key ?? '',
        name: {
          en: o.nameEn ?? o.key ?? '',
          ar: o.nameAr ?? o.nameEn ?? o.key ?? '',
          fr: o.nameFr ?? o.nameEn ?? o.key ?? '',
        },
        type: o.type === 'color' ? 'color' : 'text',
        values,
      });
      valuesByProduct.set(pid, list);
    }

    return productIds
      .map((id) => productById.get(String(id)))
      .filter((p): p is any => !!p)
      .map((p) => ({
        productId: String(p._id),
        name: { en: p.nameEn, ar: p.nameAr, fr: p.nameFr },
        slug: p.slug ?? null,
        image: p.image ?? null,
        options: valuesByProduct.get(String(p._id)) ?? [],
        variants: variantsByProduct.get(String(p._id)) ?? [],
      }));
  }

  /**
   * Option and value metadata for the whole store, loaded once per request. Mirrors
   * `InventoryReadService.labelDictionary` — a store's option vocabulary is bounded by what
   * the seller typed, so one query each beats resolving a label per variant.
   */
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

  /**
   * Escapes a user search term before it enters a `$regex`. An unescaped `C++ (test)[1]`
   * is an invalid pattern and throws Mongo 51091 â†’ a 500 on what should be a no-results
   * search (inventory audit LO-4). The character class is the full regex metacharacter set.
   */
  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}


