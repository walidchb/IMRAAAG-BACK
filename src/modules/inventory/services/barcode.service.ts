import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import {
  BARCODE_BODY_LENGTH,
  BARCODE_PREFIX,
  SKU_MAX_LENGTH,
  SKU_PREFIX,
  SKU_SEPARATOR,
} from '../../../common/barcode/constants';
import { buildEan13 } from '../../../common/barcode/ean13';
import { Product, ProductDocument } from '../../products/schemas/product.schema';
import { Store, StoreDocument } from '../../stores/schemas/store.schema';
import { ProductOption, ProductOptionDocument } from '../schemas/product-option.schema';
import {
  ProductOptionValue,
  ProductOptionValueDocument,
} from '../schemas/product-option-value.schema';
import { ProductVariant, ProductVariantDocument } from '../schemas/product-variant.schema';
import { VariantOptionValue, VariantOptionValueDocument } from '../schemas/variant-option-value.schema';
import { GenerateCodesDto } from '../dto/variants.dto';

/** A single variant's freshly-generated codes. */
export interface GeneratedCodes {
  variantId: string;
  sku: string | null;
  barcode: string | null;
}

export interface GenerateCodesResult {
  productId: string;
  updated: number;
  skipped: number;
  variants: GeneratedCodes[];
}

/** Carries everything the SKU derivation needs to read a variant's value names in option order. */
interface SkuContext {
  idsByVariant: Map<string, string[]>;
  valueById: Map<string, ProductOptionValueDocument>;
  optionById: Map<string, ProductOptionDocument>;
}

const MAX_BARCODE_ALLOC_TRIES = 12;
const MAX_WRITE_TRIES = 40;
const PRODUCT_CODE_LENGTH = 6;
const VALUE_CODE_LENGTH = 3;

/**
 * Allocates per-store EAN-13 barcodes and human-readable SKUs for a product's variants.
 *
 * Two invariants shape this service:
 *
 *  - **Non-destructive by default.** Generation only fills a field that is empty; replacing an
 *    existing code requires `overwrite: true`. A seller who has already printed and applied
 *    labels would otherwise silently invalidate every one of them on a re-run.
 *  - **The store is the barcode namespace.** EAN-13 uses the GS1 internal prefix `20`, so an
 *    Imraaah code can never be a real retail GTIN, and the 10-digit body is drawn from a
 *    per-store monotonic counter (`Store.barcodeSeq`), making collisions within a store a
 *    counter-overflow problem rather than a random one. The partial `{storeId, barcode}` unique
 *    index remains the final authority — this service pre-checks, but a write that still clashes
 *    is retried rather than surfaced as a 500.
 *
 * SKUs are derived from the product name and the variant's option-value names, but they are
 * *stored*, not recomputed on read: renaming an option value later must not silently rewrite a
 * SKU that is already on a shelf label. The derivation is only a starting point, and a clash is
 * resolved with a numeric suffix (`...-2`, `...-3`).
 */
@Injectable()
export class BarcodeService {
  private readonly logger = new Logger(BarcodeService.name);

  constructor(
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Store.name)
    private readonly storeModel: Model<StoreDocument>,
    @InjectModel(ProductOption.name)
    private readonly optionModel: Model<ProductOptionDocument>,
    @InjectModel(ProductOptionValue.name)
    private readonly valueModel: Model<ProductOptionValueDocument>,
    @InjectModel(ProductVariant.name)
    private readonly variantModel: Model<ProductVariantDocument>,
    @InjectModel(VariantOptionValue.name)
    private readonly joinModel: Model<VariantOptionValueDocument>,
  ) {}

  /**
   * Generates a barcode and/or SKU for each targeted variant that lacks one.
   *
   * Variants are written one at a time (not in a transaction) on purpose: the operation is
   * idempotent and additive, so a partial run leaves every already-written code valid and the
   * next run simply continues. A transaction would hold a write lock across a potentially
   * thousand-row batch for no correctness gain.
   */
  async generateCodes(
    productId: string,
    storeId: Types.ObjectId,
    dto: GenerateCodesDto,
  ): Promise<GenerateCodesResult> {
    const product = await this.productModel
      .findById(productId)
      .select('_id storeId nameEn nameFr nameAr slug')
      .lean()
      .exec();
    if (!product || String((product as any).storeId ?? '') !== String(storeId)) {
      throw new AppException(AppErrorCode.PRODUCT_NOT_IN_STORE, { productId });
    }

    const allVariants = await this.variantModel
      .find({ productId: new Types.ObjectId(productId), storeId, isDeleted: { $ne: true } })
      .sort({ position: 1 })
      .exec();

    const wanted = dto.variantIds ? new Set(dto.variantIds.map(String)) : null;
    const variants = wanted ? allVariants.filter((v) => wanted.has(String(v._id))) : allVariants;

    const includeSku = dto.includeSku !== false;
    const includeBarcode = dto.includeBarcode !== false;
    const overwrite = dto.overwrite === true;

    const context = await this.buildSkuContext(productId, storeId, variants);
    const productCode = this.productCode(product as any);

    const updated: GeneratedCodes[] = [];
    let skipped = 0;

    for (const variant of variants) {
      const needBarcode = includeBarcode && (overwrite || !variant.barcode);
      const needSku = includeSku && (overwrite || !variant.sku);
      if (!needBarcode && !needSku) {
        skipped += 1;
        continue;
      }

      const skuBase = needSku ? this.deriveSku(productCode, variant, context) : null;
      const row = await this.persistCodes(variant, storeId, { needBarcode, needSku, skuBase });
      updated.push({
        variantId: String(variant._id),
        sku: row.sku ?? null,
        barcode: row.barcode ?? null,
      });
    }

    this.logger.log(
      `generate-codes product=${productId} store=${String(storeId)} updated=${updated.length} skipped=${skipped}`,
    );

    return { productId, updated: updated.length, skipped, variants: updated };
  }

  // ------------------------------------------------------------------ barcode

  /**
   * Reserves the next EAN-13 for a store.
   *
   * The body comes from an atomic `$inc` so two concurrent generations never receive the same
   * sequence; a random body is used if the counter is unavailable or has overflowed. Either way
   * the candidate is checked against the unique index before it is handed out.
   */
  private async nextEan13(storeId: Types.ObjectId): Promise<string> {
    for (let attempt = 0; attempt < MAX_BARCODE_ALLOC_TRIES; attempt += 1) {
      const body = await this.nextBody(storeId, attempt);
      const code = buildEan13(BARCODE_PREFIX, body, BARCODE_BODY_LENGTH);
      const taken = await this.variantModel.exists({ storeId, barcode: code });
      if (!taken) return code;
    }
    throw new AppException(AppErrorCode.INTERNAL_SERVER_ERROR, {
      reason: 'barcode_generation_exhausted',
    });
  }

  private async nextBody(storeId: Types.ObjectId, attempt: number): Promise<string> {
    if (attempt === 0) {
      const store = await this.storeModel
        .findByIdAndUpdate(
          storeId,
          { $inc: { barcodeSeq: 1 } },
          { new: true, projection: { barcodeSeq: 1 } },
        )
        .lean()
        .exec();
      const seq = (store as any)?.barcodeSeq ?? 0;
      if (seq > 0) {
        return String(seq).padStart(BARCODE_BODY_LENGTH, '0').slice(-BARCODE_BODY_LENGTH);
      }
    }
    // Fallback: a store row that is missing (should not happen) or a counter past the 10-digit
    // body. Random, still checked against the index by the caller.
    const max = 10 ** BARCODE_BODY_LENGTH;
    return String(Math.floor(Math.random() * max)).padStart(BARCODE_BODY_LENGTH, '0');
  }

  // ------------------------------------------------------------------ sku

  private async buildSkuContext(
    productId: string,
    storeId: Types.ObjectId,
    variants: ProductVariantDocument[],
  ): Promise<SkuContext> {
    const options = await this.optionModel
      .find({ productId: new Types.ObjectId(productId), storeId })
      .sort({ position: 1 })
      .exec();

    const values = options.length
      ? await this.valueModel.find({ productId: new Types.ObjectId(productId), storeId }).exec()
      : [];

    const joins = variants.length
      ? await this.joinModel.find({ variantId: { $in: variants.map((v) => v._id) } }).lean().exec()
      : [];

    const idsByVariant = new Map<string, string[]>();
    for (const join of joins) {
      const list = idsByVariant.get(String(join.variantId)) ?? [];
      list.push(String(join.optionValueId));
      idsByVariant.set(String(join.variantId), list);
    }

    return {
      idsByVariant,
      valueById: new Map(values.map((v) => [String(v._id), v])),
      optionById: new Map(options.map((o) => [String(o._id), o])),
    };
  }

  /** `IMR-<PRODUCT>-<VALUE>-<VALUE>` — stored, not recomputed on read (see the class doc). */
  private deriveSku(productCode: string, variant: ProductVariantDocument, ctx: SkuContext): string {
    const ids = (ctx.idsByVariant.get(String(variant._id)) ?? [])
      .slice()
      .sort((a, b) => this.compareValueIds(a, b, ctx));

    const valueCodes = ids.map((id, index) => {
      const value = ctx.valueById.get(id);
      const name = value?.valueEn || value?.value || '';
      return codeFragment(name, VALUE_CODE_LENGTH) || `V${index + 1}`;
    });

    const parts = [SKU_PREFIX, productCode, ...valueCodes].filter((p) => !!p);
    return trimSku(parts.join(SKU_SEPARATOR));
  }

  /** Orders a variant's values by their option position, then by value id, so SKUs are stable. */
  private compareValueIds(a: string, b: string, ctx: SkuContext): number {
    const optionOrder = (id: string): number => {
      const value = ctx.valueById.get(id);
      const option = value ? ctx.optionById.get(String(value.optionId)) : undefined;
      return option?.position ?? 0;
    };
    return optionOrder(a) - optionOrder(b) || a.localeCompare(b);
  }

  private productCode(product: {
    nameEn?: string | null;
    nameFr?: string | null;
    nameAr?: string | null;
    slug?: string | null;
  }): string {
    const raw = product.nameEn || product.nameFr || product.nameAr || product.slug || '';
    return codeFragment(raw, PRODUCT_CODE_LENGTH) || 'PROD';
  }

  // ------------------------------------------------------------------ write

  private async persistCodes(
    variant: ProductVariantDocument,
    storeId: Types.ObjectId,
    opts: { needBarcode: boolean; needSku: boolean; skuBase: string | null },
  ): Promise<{ sku?: string | null; barcode?: string | null }> {
    let barcode = opts.needBarcode ? await this.nextEan13(storeId) : null;
    let suffix = 0;

    for (let attempt = 0; attempt < MAX_WRITE_TRIES; attempt += 1) {
      const set: Record<string, unknown> = {};
      if (opts.needBarcode) set.barcode = barcode;
      if (opts.needSku && opts.skuBase) {
        set.sku = suffix === 0 ? opts.skuBase : trimSku(`${opts.skuBase}${SKU_SEPARATOR}${suffix + 1}`);
      }

      try {
        const row = await this.variantModel
          .findOneAndUpdate({ _id: variant._id, storeId }, { $set: set }, { new: true })
          .lean()
          .exec();
        return (row ?? {}) as { sku?: string | null; barcode?: string | null };
      } catch (err: any) {
        if (err?.code !== 11000) throw err;
        const field = Object.keys(err.keyPattern ?? {}).join(',');
        if (opts.needBarcode && field.includes('barcode')) {
          barcode = await this.nextEan13(storeId);
          continue;
        }
        if (opts.needSku) {
          suffix += 1;
          continue;
        }
        throw err;
      }
    }

    throw new AppException(AppErrorCode.DUPLICATE_SKU, {
      variantId: String(variant._id),
      sku: opts.skuBase,
    });
  }
}

/** Uppercases, strips diacritics and non-alphanumerics, then truncates. */
function codeFragment(input: string, maxLen: number): string {
  return (input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, maxLen);
}

/** Caps a SKU at `SKU_MAX_LENGTH` without leaving a trailing separator. */
function trimSku(sku: string): string {
  if (sku.length <= SKU_MAX_LENGTH) return sku;
  return sku.slice(0, SKU_MAX_LENGTH).replace(/[-\s]+$/, '');
}
