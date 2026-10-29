import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';
import { Product, ProductDocument } from '../../products/schemas/product.schema';
import {
  InventoryBalance,
  InventoryBalanceDocument,
} from '../schemas/inventory-balance.schema';
import { ProductVariant, ProductVariantDocument } from '../schemas/product-variant.schema';
import {
  ProductOption,
  ProductOptionDocument,
} from '../schemas/product-option.schema';
import {
  ProductOptionValue,
  ProductOptionValueDocument,
} from '../schemas/product-option-value.schema';
import {
  VariantOptionValue,
  VariantOptionValueDocument,
} from '../schemas/variant-option-value.schema';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { buildVariantLabel, LabelOption, LabelValue } from './variant-label';
import {
  DEFAULT_LOW_STOCK_THRESHOLD,
  isLowStock as computeLowStock,
  resolveLowStockThreshold,
} from './low-stock';

export interface BalanceView {
  variantId: string;
  onHand: number;
  reserved: number;
  available: number;
  lowStockThreshold: number | null;
  isLowStock: boolean;
}

export type StockSource = {
  kind: 'variant';
  productId: Types.ObjectId;
  balances: BalanceView[];
};

export interface InventoryListItem {
  variantId: string;
  productId: string;
  productName: { en: string; ar: string; fr: string };
  productSlug: string | null;
  productImage: string | null;
  /** Same "Small / Red" shape the matrix uses, resolved from the store's own labels. */
  label: string;
  sku: string | null;
  barcode: string | null;
  /** Variant override when set, else the product price; used by the Retail label template. */
  effectivePrice: number | null;
  /** The variant's own override (`null` = inherit the product price). Drives inline editing. */
  priceOverride: number | null;
  /** The product's base price — shown as the placeholder when the override is cleared. */
  productPrice: number | null;
  /** The variant's own compare-at / "initial price before discount" (null = none). */
  compareAtPrice: number | null;
  /** The product's base original price - placeholder for an empty compare-at field. */
  productOriginalPrice: number | null;
  isActive: boolean;
  onHand: number;
  reserved: number;
  available: number;
  lowStockThreshold: number | null;
  isLowStock: boolean;
  updatedAt: Date | null;
}

export interface InventoryListQuery {
  search?: string;
  productId?: string;
  status?: string;
  page?: number;
  limit?: number;
}

export interface InventoryListResult {
  data: InventoryListItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Store-level inventory statistics (spec §5).
 *
 * Deliberately a separate type from the list result: these numbers describe the whole store
 * and must not be derivable from - or mistaken for - a filtered page of rows. The list
 * endpoint therefore carries no summary at all; a summary computed over a search result is
 * exactly the drift this shape exists to prevent.
 */
export interface InventoryStats {
  variantCount: number;
  activeCount: number;
  lowStockCount: number;
  outOfStockCount: number;
  totalOnHand: number;
  totalReserved: number;
  totalAvailable: number;
}

export interface BarcodeLookupResult {
  productId: string;
  productName: { en: string; ar: string; fr: string };
}

/**
 * The one definition of where a product's stock lives.
 *
 * Section 4.3 of the roadmap: exactly one stock source of truth per product. Every product is
 * a variant product now, so that source is always `Product -> Variant -> InventoryBalance`.
 * Reading `Product.stock` directly anywhere else is precisely how two sources drift apart,
 * so every caller goes through `getStockSource`.
 */
@Injectable()
export class InventoryReadService {
  constructor(
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(InventoryBalance.name)
    private readonly balanceModel: Model<InventoryBalanceDocument>,
    @InjectModel(ProductVariant.name)
    private readonly variantModel: Model<ProductVariantDocument>,
    @InjectModel(ProductOption.name)
    private readonly optionModel: Model<ProductOptionDocument>,
    @InjectModel(ProductOptionValue.name)
    private readonly valueModel: Model<ProductOptionValueDocument>,
    @InjectModel(VariantOptionValue.name)
    private readonly joinModel: Model<VariantOptionValueDocument>,
  ) {}

  /**
   * Returns the authoritative stock for a product.
   *
   * `available` is always derived as `onHand - reserved` and never read from storage -
   * a third stored number would be a third thing that can disagree with the other two.
   * Every product is a variant product, so the variant-source branch below is the only
   * one that ever existed (the `Product.stock` fallback disappeared with `hasVariants`).
   */
  async getStockSource(productId: string): Promise<StockSource> {
    const product = await this.productModel.findById(productId).exec();
    if (!product) throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { id: productId });

    const variantIds = await this.variantIdsFor(product._id as Types.ObjectId);
    const balances = await this.balanceModel.find({ variantId: { $in: variantIds } }).exec();

    // Fetched once rather than per balance, so resolving the variant level of the threshold
    // chain does not turn this into one query per variant.
    const variants = await this.variantModel
      .find({ _id: { $in: variantIds } })
      .select('lowStockThreshold')
      .lean()
      .exec();
    const variantThresholdById = new Map(
      variants.map((v) => [String(v._id), v.lowStockThreshold ?? null]),
    );

    const productThreshold = product.lowStockThreshold ?? null;
    return {
      kind: 'variant',
      productId: product._id as Types.ObjectId,
      balances: balances.map((b) =>
        this.toView(b, this.resolveThreshold(null, variantThresholdById.get(String(b.variantId)), productThreshold)),
      ),
    };
  }

  /**
   * The one definition of threshold precedence, used by every reader in this service.
   *
   * Balance override beats variant override, which beats the product default, which beats the
   * platform default ({@link DEFAULT_LOW_STOCK_THRESHOLD}). Centralising it is what stops the
   * single-variant endpoint and the store-wide list from disagreeing about whether the same
   * variant is low, which they previously did: the list resolved the full chain while this
   * path skipped the variant level entirely. The result is always a number, so a variant the
   * seller never configured still flags as low once its available stock is small enough.
   */
  private resolveThreshold(
    balanceThreshold: number | null | undefined,
    variantThreshold: number | null | undefined,
    productThreshold: number | null | undefined,
  ): number {
    return resolveLowStockThreshold(balanceThreshold, variantThreshold, productThreshold);
  }

  /** Availability for one variant, or null when the variant has no balance row yet. */
  async getBalance(variantId: string): Promise<BalanceView | null> {
    const balance = await this.balanceModel
      .findOne({ variantId: new Types.ObjectId(variantId) })
      .exec();
    if (!balance) return null;
    // Resolves variant and product level too, so the threshold reported here matches the
    // one the store-wide list reports for the same variant.
    const chain = await this.resolveChain(variantId);
    return this.toView(balance, this.resolveThreshold(balance.lowStockThreshold, chain.variant, chain.product));
  }

  /**
   * Variant- and product-level thresholds for one variant, for readers that already hold a
   * balance and need the rest of the chain behind it.
   */
  private async resolveChain(variantId: string): Promise<{ variant: number | null; product: number | null }> {
    const variant = await this.variantModel
      .findById(variantId)
      .select('productId lowStockThreshold')
      .lean()
      .exec();
    if (!variant) return { variant: null, product: null };
    const product = await this.productModel
      .findById(variant.productId)
      .select('lowStockThreshold')
      .lean()
      .exec();
    return {
      variant: variant.lowStockThreshold ?? null,
      product: product?.lowStockThreshold ?? null,
    };
  }

  /**
   * Resolves the low-stock threshold with its full precedence: a balance override beats
   * a variant override, which beats the product-level default, which beats the platform
   * default. Always a number (see {@link resolveThreshold}).
   */
  async effectiveThreshold(variantId: string): Promise<number> {
    const balance = await this.balanceModel
      .findOne({ variantId: new Types.ObjectId(variantId) })
      .select('lowStockThreshold')
      .lean()
      .exec();
    const chain = await this.resolveChain(variantId);
    return this.resolveThreshold(balance?.lowStockThreshold, chain.variant, chain.product);
  }

  /**
   * Store-wide variant list for the seller's inventory screen (spec §10.2).
   *
   * One aggregation produces the rows and the total together: search, filters and
   * paging all happen in MongoDB, and the frontend only ever receives the requested page.
   * The store-level statistics live in {@link getStoreStats} instead - they must not move
   * when a search or filter does (spec §5), so they are a different query by construction.
   *
   * Labels are assembled afterwards in memory rather than inside the pipeline: the option
   * and value labels live in two other collections and are needed for every row, so they
   * are fetched once per request instead of being resolved per row.
   *
* Every product has variants now, so the list is simply the store's whole sellable matrix.
 * The old simple-product exclusion (a `Product.stock`-only document) had no rows here by
 * design - blending the two sources was the confusion §4.3 exists to prevent.
 */
  async listStoreInventory(
    storeId: Types.ObjectId,
    query: InventoryListQuery,
  ): Promise<InventoryListResult> {
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 200);

    const pipeline = this.variantPipeline(storeId, query);

    const [facets] = await this.variantModel
      .aggregate([
        ...pipeline,
        {
          $facet: {
            rows: [
              { $sort: { productName: 1, _id: 1 } },
              { $skip: (page - 1) * limit },
              { $limit: limit },
            ],
            count: [{ $count: 'n' }],
          },
        },
        // The stages above are assembled at runtime from validated query params, which is
        // why they are not statically `PipelineStage`s. The inputs are constrained by
        // `ListInventoryQueryDto`; the cast is confined to this one call.
      ] as PipelineStage[])
      .exec();

    const rows: any[] = facets?.rows ?? [];
    const total: number = facets?.count?.[0]?.n ?? 0;

    const dictionary = await this.labelDictionary(storeId);

    return {
      data: rows.map((r) => ({
        variantId: String(r._id),
        productId: r.productId ? String(r.productId) : '',
        productName: {
          en: r.prod?.nameEn ?? '',
          ar: r.prod?.nameAr ?? '',
          fr: r.prod?.nameFr ?? '',
        },
        productSlug: r.prod?.slug ?? null,
        productImage: r.prod?.image ?? null,
        label: buildVariantLabel(
          (r.joins ?? []).map((j: any) => String(j.optionValueId)),
          dictionary.options,
          dictionary.values,
        ),
        sku: r.sku ?? null,
        barcode: r.barcode ?? null,
        effectivePrice: r.priceOverride ?? r.prod?.price ?? null,
        priceOverride: r.priceOverride ?? null,
        productPrice: r.prod?.price ?? null,
        compareAtPrice: r.compareAtPrice ?? null,
        productOriginalPrice: r.prod?.originalPrice ?? null,
        isActive: !!r.isActive,
        onHand: r.onHand ?? 0,
        reserved: r.reserved ?? 0,
        available: r.available ?? 0,
        lowStockThreshold: r.threshold ?? DEFAULT_LOW_STOCK_THRESHOLD,
        isLowStock: computeLowStock(r.available, r.threshold ?? DEFAULT_LOW_STOCK_THRESHOLD),
        updatedAt: r.updatedAt ?? null,
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Store-level statistics for the inventory header (spec §5).
   *
   * The match is `storeId` and nothing else - no search, no status filter, no paging - so
   * these numbers cannot move when the seller types in the search box. Everything is
   * grouped inside MongoDB: one document comes back, never the inventory itself.
   *
   * Reuses the same derived fields and threshold precedence as the list (available =
   * onHand - reserved, balance override > variant > product), so "80 out of stock" here and
   * the rows behind `status=out` cannot disagree.
   */
  async getStoreStats(storeId: Types.ObjectId): Promise<InventoryStats> {
    const [stats] = await this.variantModel
      .aggregate([
        ...this.variantPipeline(storeId),
        {
          $group: {
            _id: null,
            variantCount: { $sum: 1 },
            activeCount: { $sum: { $cond: ['$isActive', 1, 0] } },
            lowStockCount: {
              $sum: {
                $cond: [
                  // Mirrors the `low` status filter above: low is 0 < available <= threshold,
                  // so it stays disjoint from out-of-stock.
                  { $and: [{ $gt: ['$available', 0] }, { $lte: ['$available', '$threshold'] }] },
                  1,
                  0,
                ],
              },
            },
            outOfStockCount: { $sum: { $cond: [{ $lte: ['$available', 0] }, 1, 0] } },
            totalOnHand: { $sum: '$onHand' },
            totalReserved: { $sum: '$reserved' },
            totalAvailable: { $sum: '$available' },
          },
        },
      ] as PipelineStage[])
      .exec();

    return {
      variantCount: stats?.variantCount ?? 0,
      activeCount: stats?.activeCount ?? 0,
      lowStockCount: stats?.lowStockCount ?? 0,
      outOfStockCount: stats?.outOfStockCount ?? 0,
      totalOnHand: stats?.totalOnHand ?? 0,
      totalReserved: stats?.totalReserved ?? 0,
      totalAvailable: stats?.totalAvailable ?? 0,
    };
  }

  /**
   * The shared variant pipeline: store match, lookups, and the derived stock fields.
   *
   * Both the list and the stats query build on this so the two can never drift apart - the
   * only difference between them is that the caller may layer search/filter/paging on
   * top, while `getStoreStats` deliberately passes no query at all.
   *
   * `search` spans two collections: the SKU is on the variant, the name on the product.
   * One search box therefore covers both "Red shirt" and "SKU-123". Base-field filters
   * (`isActive`) run before the lookups so they ride the store index; the computed
   * predicates (`low`, `out`, `in_stock`) have to wait for `$addFields`.
   *
   * @param query Omit entirely for the store-only statistics query.
   */
  private variantPipeline(
    storeId: Types.ObjectId,
    query: InventoryListQuery = {},
  ): Record<string, any>[] {
    const variantMatch: Record<string, any> = { storeId, isDeleted: { $ne: true } };
    if (query.productId) variantMatch.productId = new Types.ObjectId(query.productId);
    if (query.status === 'active') variantMatch.isActive = true;
    if (query.status === 'inactive') variantMatch.isActive = false;

    const pipeline: Record<string, any>[] = [
      { $match: variantMatch },
      {
        $lookup: {
          from: this.balanceModel.collection.name,
          localField: '_id',
          foreignField: 'variantId',
          as: 'bal',
        },
      },
      { $unwind: { path: '$bal', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: this.productModel.collection.name,
          localField: 'productId',
          foreignField: '_id',
          as: 'prod',
        },
      },
      { $unwind: { path: '$prod', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: this.joinModel.collection.name,
          localField: '_id',
          foreignField: 'variantId',
          as: 'joins',
        },
      },
      {
        $addFields: {
          onHand: { $ifNull: ['$bal.onHand', 0] },
          reserved: { $ifNull: ['$bal.reserved', 0] },
          // Always derived, never stored: a third number could drift from the other two.
          available: {
            $subtract: [{ $ifNull: ['$bal.onHand', 0] }, { $ifNull: ['$bal.reserved', 0] }],
          },
          // Full precedence, matching `getMatrix`: balance override > variant > product >
          // platform default. Never null, so an unconfigured variant still has a threshold
          // and can be flagged low (the old `null` tail meant "never low").
          threshold: {
            $ifNull: [
              '$bal.lowStockThreshold',
              {
                $ifNull: [
                  '$lowStockThreshold',
                  { $ifNull: ['$prod.lowStockThreshold', DEFAULT_LOW_STOCK_THRESHOLD] },
                ],
              },
            ],
          },
        },
      },
    ];

    const trimmed = query.search?.trim();
    if (trimmed) {
      // User text becomes a regex here, so the metacharacters are escaped first: an
      // unescaped `(` (or `[`, `*`, …) is a Mongo regex syntax error (code 51091) surfaced
      // as a 500, whereas the seller means a literal substring. No `$text` index can replace
      // this match: it spans two collections (variant `sku` + product names) after a
      // `$lookup`, and text search cannot run mid-pipeline (see roadmap Phase 8 note).
      const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = { $regex: escaped, $options: 'i' };
      pipeline.push({
        $match: {
          $or: [
            { sku: searchRegex },
            { 'prod.nameEn': searchRegex },
            { 'prod.nameAr': searchRegex },
            { 'prod.nameFr': searchRegex },
          ],
        },
      });
    }

    // Field-to-field comparisons need `$expr`; a plain `$match` predicate would treat
    // `'$threshold'` as a literal string and silently match nothing.
    switch (query.status) {
      case 'low':
        pipeline.push({
          $match: {
            // Low is strictly above zero: an empty row is "out", a separate bucket. Mirrors
            // `isLowStock()` in `low-stock.ts`.
            $expr: {
              $and: [{ $gt: ['$available', 0] }, { $lte: ['$available', '$threshold'] }],
            },
          },
        });
        break;
      case 'out':
        pipeline.push({ $match: { available: { $lte: 0 } } });
        break;
      case 'in_stock':
        pipeline.push({ $match: { available: { $gt: 0 } } });
        break;
      default:
        // 'all', plus 'active'/'inactive', which were already folded into the first $match.
        break;
    }

    return pipeline;
  }

  /**
   * Option and value metadata for the whole store, loaded once per list request.
   *
   * A store's option and value vocabulary is bounded by what a seller types in, so one query
   * each is both cheaper and simpler than resolving a label per row.
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
   * Live variant ids for a product within one store.
   *
   * Store-scoped on purpose. It is used to expand a `productId` filter into variant ids for
   * the ledger query, and an unscoped version would let a seller ask about another store's
   * product. The ledger's own `storeId` filter would still contain the result, so this is not
   * the only thing standing between the two stores — but it should not have to be.
   */
  async variantIdsForProduct(
    productId: string,
    storeId?: Types.ObjectId,
  ): Promise<Types.ObjectId[]> {
    if (!Types.ObjectId.isValid(productId)) return [];
    const query: Record<string, any> = {
      productId: new Types.ObjectId(productId),
      isDeleted: { $ne: true },
    };
    if (storeId) query.storeId = storeId;
    const variants = await this.variantModel.find(query).select('_id').lean().exec();
    return variants.map((v) => v._id as Types.ObjectId);
  }

  async findByBarcode(
    storeId: Types.ObjectId,
    rawBarcode: string,
  ): Promise<BarcodeLookupResult> {
    const barcode = rawBarcode.trim();
    if (!barcode) {
      throw new AppException(AppErrorCode.INVENTORY_BARCODE_NOT_FOUND, { barcode: '' });
    }
    const variant = await this.variantModel
      .findOne({ storeId, barcode, isDeleted: { $ne: true } })
      .select('productId')
      .lean()
      .exec();
    if (!variant) {
      throw new AppException(AppErrorCode.INVENTORY_BARCODE_NOT_FOUND, { barcode });
    }
    const product = await this.productModel
      .findOne({ _id: variant.productId, storeId })
      .select('nameEn nameAr nameFr')
      .lean()
      .exec();
    if (!product) {
      throw new AppException(AppErrorCode.INVENTORY_BARCODE_NOT_FOUND, { barcode });
    }
    return {
      productId: String(product._id),
      productName: {
        en: product.nameEn ?? '',
        ar: product.nameAr ?? '',
        fr: product.nameFr ?? '',
      },
    };
  }

  private async variantIdsFor(productId: Types.ObjectId): Promise<Types.ObjectId[]> {
    const variants = await this.variantModel
      .find({ productId, isDeleted: { $ne: true } })
      .select('_id')
      .lean()
      .exec();
    return variants.map((v) => v._id as Types.ObjectId);
  }

  /**
   * @param resolvedThreshold The variant-then-product tail of the chain. The balance's own
   *   override wins, and the resolved value is what gets *reported*, not only what decides
   *   the flag: a caller showing the seller's threshold would otherwise see null whenever
   *   the number came from an ancestor, while the list showed the real value.
   */
  private toView(
    balance: InventoryBalanceDocument,
    resolvedThreshold: number | null,
  ): BalanceView {
    const available = balance.onHand - balance.reserved;
    const threshold = this.resolveThreshold(balance.lowStockThreshold, resolvedThreshold, null);
    return {
      variantId: String(balance.variantId),
      onHand: balance.onHand,
      reserved: balance.reserved,
      available,
      lowStockThreshold: threshold,
      isLowStock: this.isLow(available, threshold),
    };
  }

  private isLow(available: number, threshold: number): boolean {
    return computeLowStock(available, threshold);
  }
}
