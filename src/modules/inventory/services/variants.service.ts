import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'crypto';
import { ClientSession, Model, Types } from 'mongoose';
import {
  ProductOption,
  ProductOptionDocument,
} from '../schemas/product-option.schema';
import {
  ProductOptionValue,
  ProductOptionValueDocument,
} from '../schemas/product-option-value.schema';
import {
  ProductVariant,
  ProductVariantDocument,
} from '../schemas/product-variant.schema';
import {
  VariantOptionValue,
  VariantOptionValueDocument,
} from '../schemas/variant-option-value.schema';
import {
  InventoryBalance,
  InventoryBalanceDocument,
} from '../schemas/inventory-balance.schema';
import {
  InventoryMovement,
  InventoryMovementDocument,
} from '../schemas/inventory-movement.schema';
import { Product, ProductDocument } from '../../products/schemas/product.schema';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { isValidEan13 } from '../../../common/barcode/ean13';
import {
  CreateOptionDto,
  CreateOptionValueDto,
  CreateVariantsDto,
  DeactivateVariantDto,
  OptionType,
  PreviewCombinationsDto,
  SelectedCombinationDto,
  UpdateOptionDto,
  UpdateOptionValueDto,
  UpdateVariantDto,
} from '../dto/variants.dto';
import { openTransactionSession } from './session.util';
import {
  buildVariantLabel,
  LabelOption,
  LabelValue,
} from './variant-label';
import {
  DEFAULT_LOW_STOCK_THRESHOLD,
  isLowStock as computeLowStock,
} from './low-stock';

/** What a rename would touch, so the seller can be shown it before committing (§5.2 / C.5). */
export interface AffectedVariants {
  productId: string;
  count: number;
  variants: Array<{
    variantId: string;
    combinationKey: string;
    label: string;
    sku: string | null;
    onHand: number;
    reserved: number;
  }>;
}

export interface MatrixRow {
  variantId: string | null;
  combinationKey: string;
  optionValueIds: string[];
  label: string;
  sku: string | null;
  barcode: string | null;
  priceOverride: number | null;
  effectivePrice: number;
  compareAtPrice: number | null;
  isActive: boolean;
  onHand: number;
  reserved: number;
  available: number;
  isLowStock: boolean;
  image: string | null;
  position: number;
  /** True when a variant exists for this combination but is soft-deleted. */
  isDeleted?: boolean;
}

export interface VariantMatrix {
  productId: string;
  productPrice: number;
  /** Product-level initial (pre-discount) price; the fallback for a variant with no compare-at. */
  productOriginalPrice: number;
  productLowStockThreshold: number | null;
  options: Array<{
    id: string;
    key: string;
    name: { en: string; ar: string; fr: string };
    position: number;
    type: OptionType;
    values: Array<{
      id: string;
      value: string;
      name: { en: string; ar: string; fr: string };
      color: string | null;
      position: number;
      isActive: boolean;
      /** True when at least one live variant uses this value. */
      inUse: boolean;
    }>;
  }>;
  variants: MatrixRow[];
}

/** Per-product rollup attached to list responses. One aggregation covers a whole page. */
export interface VariantSummary {
  variantCount: number;
  activeVariantCount: number;
  availableTotal: number;
  inStock: boolean;
  hasPriceOverride: boolean;
  overrideMin: number | null;
  overrideMax: number | null;
  skus?: string[];
  /**
   * Per-variant effective inputs, for deriving the listing's "was" (compare-at) price of the
   * variant that owns the range minimum. Internal to `ProductsService.attachVariantSummaries`,
   * which strips it before the response - the public payload keeps only
   * `priceRange.compareAtPrice`. Absent from mocked rows in older specs.
   */
  variantPrices?: Array<{ priceOverride: number | null; compareAtPrice: number | null }>;
}

/**
 * Everything an order line needs to keep describing what was bought after the seller renames
 * or deactivates the variant (roadmap 4.6, spec §7.4).
 */
export interface VariantOrderSnapshot {
  variantId: string;
  productId: string;
  storeId: string | null;
  sku: string | null;
  priceOverride: number | null;
  /** Compare-at (pre-discount) price at purchase time; absent on mocked rows in older specs. */
  compareAtPrice?: number | null;
  image: string | null;
  isActive: boolean;
  snapshot: {
    options: Array<{ optionKey: string; optionName: string; value: string; valueName: string }>;
    label: string;
  };
}

const MAX_COMBINATIONS = 1000;

/** The only movement a genuinely-untouched default variant ever has: its zero-delta scaffold. */
const DEFAULT_VARIANT_REASON = 'Default variant created on product creation';

@Injectable()
export class VariantsService {
  private readonly logger = new Logger(VariantsService.name);

  constructor(
    @InjectModel(ProductOption.name)
    private readonly optionModel: Model<ProductOptionDocument>,
    @InjectModel(ProductOptionValue.name)
    private readonly valueModel: Model<ProductOptionValueDocument>,
    @InjectModel(ProductVariant.name)
    private readonly variantModel: Model<ProductVariantDocument>,
    @InjectModel(VariantOptionValue.name)
    private readonly joinModel: Model<VariantOptionValueDocument>,
    @InjectModel(InventoryBalance.name)
    private readonly balanceModel: Model<InventoryBalanceDocument>,
    @InjectModel(InventoryMovement.name)
    private readonly movementModel: Model<InventoryMovementDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
  ) {}

  // ---------------------------------------------------------------- variant search

  /**
   * Product ids in this store whose option or option-value labels match `regex`.
   *
   * This replaces the `'variants.options.nameEn': regex` predicates that product search used to
   * run against the embedded array. Those matched a field that no longer exists, and matching
   * across collections cannot be expressed as a product-level `$or` - the caller has to resolve
   * the matching product ids first and add them as an `_id: { $in: [...] }` branch.
   *
   * Capped deliberately: this feeds a product search page, so an unbounded `$in` would let a
   * one-character query pull every product id in a large store into the query plan. The cap is
   * above the default page size, so a truncated result set still fills a page; the caller's own
   * store/category filter narrows it further.
   */
  async findProductIdsMatchingLabels(
    storeId: Types.ObjectId,
    regex: { $regex: string; $options: string },
    limit = 1000,
  ): Promise<Types.ObjectId[]> {
    // Both queries project `productId`: it is denormalised onto values for exactly this reason,
    // so neither hit has to be resolved back through its parent option a second time.
    const optionHits = await this.optionModel
      .find({ storeId, $or: [{ nameEn: regex }, { nameAr: regex }, { nameFr: regex }, { key: regex }] })
      .select('_id productId')
      .lean()
      .exec();

    const matchedOptionIds = optionHits.map((o: any) => o._id);

    const valueHits = await this.valueModel
      .find({
        storeId,
        $or: [
          { valueEn: regex },
          { valueAr: regex },
          { valueFr: regex },
          { value: regex },
          // A match on an option label should also surface every product that uses that option,
          // so searching "size" finds the products offering it, not only those whose own values
          // happen to be spelled the same way.
          ...(matchedOptionIds.length ? [{ optionId: { $in: matchedOptionIds } }] : []),
        ],
      })
      .select('productId')
      .lean()
      .exec();

    const productIds = new Set<string>();
    for (const hit of [...optionHits, ...valueHits]) {
      const id = (hit as any)?.productId;
      if (id && Types.ObjectId.isValid(String(id))) productIds.add(String(id));
    }

    return [...productIds].slice(0, limit).map((id) => new Types.ObjectId(id));
  }

  // ---------------------------------------------------------------- combinationKey

  /**
   * `sha1` of the sorted, `:`-joined option value ids.
   *
   * Sorting is the whole point: a seller may list dimensions in any order, and
   * reordering them must not yield a second variant for the same combination
   * (spec edge case 28). Two different sets of values can never collide because the input
   * is a set of ids, not labels.
   */
  combinationKeyFor(optionValueIds: string[]): string {
    return createHash('sha1')
      .update(this.canonicalize(optionValueIds))
      .digest('hex');
  }

  /** Sorted, deduplicated, `:`-joined ids — the single definition of a combination. */
  private canonicalize(optionValueIds: string[]): string {
    return [...new Set(optionValueIds.map(String))].sort().join(':');
  }

  // -------------------------------------------------------------------- option CRUD

  async createOption(productId: string, storeId: Types.ObjectId, dto: CreateOptionDto) {
    await this.assertProductInStore(productId, storeId);

    // Defining a real dimension makes the auto-seeded "Default > One Size" placeholder obsolete:
    // it must not sit beside genuinely offered sizes/colours afterwards. Purge happens *before*
    // the insert so a first option named "Default" is not blocked by the placeholder's key.
    await this.purgeAutoDefault(productId, storeId);

    let nameEn = dto.nameEn?.trim();
    let nameAr = dto.nameAr?.trim();
    let nameFr = dto.nameFr?.trim();
    const incomingType = dto.type;

    if (incomingType === 'color') {
      nameEn = nameEn || 'Color';
      nameAr = nameAr || 'لون';
      nameFr = nameFr || 'Couleur';
    } else if (incomingType === 'size') {
      nameEn = nameEn || 'Size';
      nameAr = nameAr || 'المقاس';
      nameFr = nameFr || 'Taille';
    }

    // The machine key is derived from the labels so the UI never has to invent slugs.
    // `key` stays the identity for every value/join row, so it is not editable later.
    // An explicit machine key counts as identity on its own (mirrors createValue's
    // explicit `value`), so bare-key scripting/legacy calls still work.
    const key =
      (dto.key?.trim() ? this.slug(dto.key) : '') ||
      (nameEn ? this.slug(nameEn) : '') ||
      (nameFr ? this.slug(nameFr) : '') ||
      (nameAr ? this.slug(nameAr) : '');
    if (!key) {
      throw new AppException(AppErrorCode.INVALID_COMBINATION, { reason: 'option_name_required' });
    }
    const type: OptionType = this.optionTypeOf({ type: dto.type });

    try {
      const option = new this.optionModel({
        storeId,
        productId: new Types.ObjectId(productId),
        key,
        nameEn: nameEn ?? null,
        nameAr: nameAr ?? null,
        nameFr: nameFr ?? null,
        position: dto.position ?? 0,
        type,
      });
      return await option.save();
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new AppException(AppErrorCode.OPTION_KEY_IN_USE, { productId, key });
      }
      throw err;
    }
  }

  /**
   * Renames labels, repositions, changes display type.
   *
   * `key` is not editable here on purpose, and neither `combinationKey` nor any join row is
   * touched: the key is derived from value **ids**, so a rename cannot change variant
   * identity (spec §5.2). The response reports which variants were affected so the seller
   * can be shown it before committing rather than after.
   */
  async updateOption(
    productId: string,
    storeId: Types.ObjectId,
    optionId: string,
    dto: UpdateOptionDto,
  ) {
    await this.assertProductInStore(productId, storeId);
    const option = await this.requireOption(optionId, productId, storeId);

    const update: Record<string, any> = {};
    if (dto.nameEn !== undefined) update.nameEn = dto.nameEn;
    if (dto.nameAr !== undefined) update.nameAr = dto.nameAr;
    if (dto.nameFr !== undefined) update.nameFr = dto.nameFr;
    if (dto.position !== undefined) update.position = dto.position;
    if (dto.type !== undefined) update.type = this.optionTypeOf({ type: dto.type });

    // Preview before writing, so the caller learns which variants a rename will move while it
    // can still decline it. Collected from this option's own values: `affectedVariants`
    // resolves a *value* id, so passing `option._id` here would always report zero.
    const valueIds = (
      await this.valueModel
        .find({ optionId: option._id, productId: new Types.ObjectId(productId), storeId })
        .select('_id')
        .lean()
        .exec()
    ).map((v) => v._id as Types.ObjectId);

    const affectedIds = new Set<string>();
    for (const valueId of valueIds) {
      for (const id of await this.variantIdsUsingValue(valueId)) affectedIds.add(String(id));
    }
    const affected = await this.describeVariants(productId, storeId, [...affectedIds]);

    const saved = await this.optionModel
      .findOneAndUpdate({ _id: option._id }, { $set: update }, { new: true })
      .exec();

    return { option: saved, affected, previewed: true };
  }

  /** Options for a product, ordered. Deleting an option is out of scope by design (§3.6). */
  async listOptions(productId: string, storeId: Types.ObjectId) {
    await this.assertProductInStore(productId, storeId);
    return this.optionModel
      .find({ productId: new Types.ObjectId(productId), storeId })
      .sort({ position: 1 })
      .lean()
      .exec();
  }

  // ---------------------------------------------------------------- value CRUD

  private fillValueLanguages(
    en?: string | null,
    ar?: string | null,
    fr?: string | null,
  ): { valueEn: string | null; valueAr: string | null; valueFr: string | null } {
    const first = [en, ar, fr].find((v) => typeof v === 'string' && v.trim().length > 0);
    const base = first?.trim() || null;
    return {
      valueEn: en?.trim() ? en.trim() : base,
      valueAr: ar?.trim() ? ar.trim() : base,
      valueFr: fr?.trim() ? fr.trim() : base,
    };
  }

  async createValue(productId: string, storeId: Types.ObjectId, optionId: string, dto: CreateOptionValueDto) {
    await this.assertProductInStore(productId, storeId);
    const option = await this.requireOption(optionId, productId, storeId);

    const filled = this.fillValueLanguages(dto.valueEn, dto.valueAr, dto.valueFr);
    const valueEn = filled.valueEn;
    const valueAr = filled.valueAr;
    const valueFr = filled.valueFr;

    // The machine value is derived from the labels so the UI never has to invent slugs;
    // a caller may still pass an explicit machine value for legacy/scripting use.
    const machine = (dto.value?.trim() ?? '') ||
      (valueEn ? this.slug(valueEn) : '') ||
      (valueFr ? this.slug(valueFr) : '') ||
      (valueAr ? this.slug(valueAr) : '');
    if (!machine) {
      throw new AppException(AppErrorCode.INVALID_COMBINATION, { reason: 'value_name_required' });
    }

    try {
      const value = new this.valueModel({
        storeId,
        productId: new Types.ObjectId(productId),
        optionId: option._id,
        value: machine,
        valueEn: valueEn ?? null,
        valueAr: valueAr ?? null,
        valueFr: valueFr ?? null,
        color: option.type === 'color' ? this.normalizeColor(dto.color) : null,
        position: dto.position ?? 0,
        isActive: true,
      });
      return await value.save();
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new AppException(AppErrorCode.OPTION_VALUE_IN_USE, { optionId, value: machine });
      }
      throw err;
    }
  }

  /**
   * Renames a value's **labels** and presentation metadata.
   *
   * `value` — the canonical machine value — is not editable. It is part of the identity
   * the seller references elsewhere, and letting it drift from the labels is how a variant
   * ends up displayed as "Large" under the key "medium".
   */
  async updateValue(
    productId: string,
    storeId: Types.ObjectId,
    optionId: string,
    valueId: string,
    dto: UpdateOptionValueDto,
  ) {
    await this.assertProductInStore(productId, storeId);
    const option = await this.requireOption(optionId, productId, storeId);
    const value = await this.requireValue(valueId, option._id, productId, storeId);

    // Activation state changes never ride along with a label edit. Deactivation takes the
    // same guarded, transactional path as `DELETE`; reactivation mirrors it so the value and
    // the variants that used it always move together (stock is untouched).
    if (dto.isActive !== undefined) {
      if (!dto.isActive) {
        return this.deactivateValue(productId, storeId, optionId, valueId);
      }
      return this.activateValue(productId, storeId, optionId, valueId);
    }

    const update: Record<string, any> = {};
    const hasValueLangUpdate = dto.valueEn !== undefined || dto.valueAr !== undefined || dto.valueFr !== undefined;
    if (hasValueLangUpdate) {
      const filled = this.fillValueLanguages(
        dto.valueEn !== undefined ? dto.valueEn : value.valueEn,
        dto.valueAr !== undefined ? dto.valueAr : value.valueAr,
        dto.valueFr !== undefined ? dto.valueFr : value.valueFr,
      );
      if (dto.valueEn !== undefined) update.valueEn = filled.valueEn;
      if (dto.valueAr !== undefined) update.valueAr = filled.valueAr;
      if (dto.valueFr !== undefined) update.valueFr = filled.valueFr;
    }
    if (dto.color !== undefined) {
      update.color = option.type === 'color' ? this.normalizeColor(dto.color) : null;
    }
    if (dto.position !== undefined) update.position = dto.position;

    // Preview before writing, so the seller sees which combinations move before the label changes.
// The canonical `value` is untouched: it is half of the combinationKey, so editing it would
// silently re-key every variant that uses it.
const affected = await this.affectedVariants(productId, storeId, value._id);

    const saved = await this.valueModel
      .findOneAndUpdate({ _id: value._id }, { $set: update }, { new: true })
      .exec();

    return { value: saved, affected, previewed: true };
  }

  /**
   * Deactivates a value — never deletes it (spec §5.2, C.6).
   *
   * A hard delete would orphan every join row pointing at it and silently change what the
   * matrix means, so the row is retired with `isActive: false` and every variant that used
   * it is deactivated in the same pass. Blocked outright while stock is reserved, because
   * an order in flight must not point at a value the seller just retired.
   */
  async deactivateValue(
    productId: string,
    storeId: Types.ObjectId,
    optionId: string,
    valueId: string,
  ) {
    await this.assertProductInStore(productId, storeId);
    const option = await this.requireOption(optionId, productId, storeId);
    const value = await this.requireValue(valueId, option._id, productId, storeId);

    const variantIds = await this.variantIdsUsingValue(value._id);
    const reserved = await this.reservedFor(variantIds);

    if (reserved.total > 0) {
      throw new AppException(AppErrorCode.VARIANT_INACTIVE, {
        reason: 'reserved_stock_exists',
        reserved: reserved.total,
        variants: reserved.byVariant,
      });
    }

    const session = await this.startSession();
    try {
      let deactivatedVariants = 0;
      await session.withTransaction(async () => {
        await this.valueModel
          .updateOne({ _id: value._id }, { $set: { isActive: false } }, { session })
          .exec();

        if (variantIds.length > 0) {
          // onHand is deliberately untouched: retiring a value must never silently discard
          // stock. The quantity stays visible on the deactivated variant and the seller
          // zeroes it deliberately if that is what they want.
          const result = await this.variantModel.updateMany(
            { _id: { $in: variantIds }, isDeleted: { $ne: true } },
            { $set: { isActive: false } },
            { session },
          );
          deactivatedVariants = result.modifiedCount ?? 0;
        }
      });

      return {
        valueId: String(value._id),
        isActive: false,
        deactivatedVariants,
        variantsRetained: variantIds.length,
        note: 'Value deactivated, not deleted. Stock on affected variants is retained and visible.',
      };
    } finally {
      await session.endSession();
    }
  }

  /**
   * Reactivates a retired value — the counterpart to `deactivateValue` (spec §5.2).
   *
   * The row is brought back with `isActive: true` and every *non-deleted* variant that
   * uses it is re-activated in the same transaction, so the offer returns exactly as it
   * was when the value was deactivated. Stock is deliberately untouched: the seller paused
   * those variants with their quantities intact, and reactivation must not invent or move
   * any of it. Variants the seller hard-retired (`isDeleted`) are left alone, and a value
   * that is already active is a no-op.
   */
  async activateValue(
    productId: string,
    storeId: Types.ObjectId,
    optionId: string,
    valueId: string,
  ) {
    await this.assertProductInStore(productId, storeId);
    const option = await this.requireOption(optionId, productId, storeId);
    const value = await this.requireValue(valueId, option._id, productId, storeId);

    const variantIds = await this.variantIdsUsingValue(value._id);
    const session = await this.startSession();
    try {
      let reactivatedVariants = 0;
      await session.withTransaction(async () => {
        await this.valueModel
          .updateOne({ _id: value._id, isActive: false }, { $set: { isActive: true } }, { session })
          .exec();

        if (variantIds.length > 0) {
          const result = await this.variantModel.updateMany(
            { _id: { $in: variantIds }, isDeleted: { $ne: true }, isActive: false },
            { $set: { isActive: true } },
            { session },
          );
          reactivatedVariants = result.modifiedCount ?? 0;
        }
      });

      return {
        valueId: String(value._id),
        isActive: true,
        reactivatedVariants,
        variantsRetained: variantIds.length,
        note: 'Value reactivated. Stock on affected variants is untouched.',
      };
    } finally {
      await session.endSession();
    }
  }

  // -------------------------------------------------------------- preview / create

  /**
   * Cartesian preview. **Creates nothing.**
   *
   * Every row is annotated with whether a variant already exists for it, so the seller can
   * tick a subset. The cartesian product is computed rather than stored: a 4×4×4 option set
   * is 64 rows, and persisting combinations the seller did not offer would create exactly
   * the phantom SKUs the spec forbids (spec §5.1(6)-(7)).
   */
  async previewCombinations(
    productId: string,
    storeId: Types.ObjectId,
    dto: PreviewCombinationsDto,
  ) {
    await this.assertProductInStore(productId, storeId);

    const options = await this.listOptions(productId, storeId);

    if (options.length === 0) {
      throw new AppException(AppErrorCode.NO_ACTIVE_VALUES, { productId });
    }

    const valuesByOption = new Map<string, ProductOptionValueDocument[]>();
    for (const option of options) {
      const values = await this.valueModel
        .find({
          optionId: option._id,
          productId: new Types.ObjectId(productId),
          storeId,
          ...(dto.includeInactive ? {} : { isActive: true }),
        })
        .sort({ position: 1 })
        .exec();

      if (values.length === 0) {
        throw new AppException(AppErrorCode.NO_ACTIVE_VALUES, {
          optionId: String(option._id),
          optionKey: option.key,
        });
      }
      valuesByOption.set(String(option._id), values);
    }

    let combos: string[][] = [[]];
    for (const option of options) {
      const values = valuesByOption.get(String(option._id)) as ProductOptionValueDocument[];
      const next: string[][] = [];
      for (const prefix of combos) {
        for (const value of values) next.push([...prefix, String(value._id)]);
      }
      combos = next;
      if (combos.length > MAX_COMBINATIONS) {
        // Refuse rather than truncate: a silently truncated matrix is indistinguishable
        // from one where those combinations do not exist.
        throw new AppException(AppErrorCode.INVALID_COMBINATION, {
          reason: 'too_many_combinations',
          limit: MAX_COMBINATIONS,
        });
      }
    }

    const existing = await this.variantsForProduct(productId, storeId);
    const byKey = new Map(existing.map((v) => [v.combinationKey, v]));

    // One query for every row's stock rather than one per row: a 4×4×4 preview is 64 rows,
    // and 64 round trips on a screen the seller opens constantly is not acceptable.
    const balances = existing.length
      ? await this.balanceModel
          .find({ variantId: { $in: existing.map((v) => v._id) } })
          .select('variantId onHand')
          .lean()
          .exec()
      : [];
    const onHandByVariant = new Map(balances.map((b) => [String(b.variantId), b.onHand]));

    const possibleCombinations = combos.map((ids) => {
      const key = this.combinationKeyFor(ids);
      const variant = byKey.get(key);
      return {
        combinationKey: key,
        optionValueIds: [...ids].sort(),
        label: this.labelFor(ids, options, valuesByOption),
        exists: !!variant,
        variantId: variant ? String(variant._id) : null,
        isActive: variant ? variant.isActive : false,
        sku: variant ? variant.sku ?? null : null,
        onHand: variant ? onHandByVariant.get(String(variant._id)) ?? 0 : 0,
      };
    });

    return {
      productId,
      hasVariants: true,
      options: options.map((o) => ({
        id: String(o._id),
        key: o.key,
        type: this.optionTypeOf(o),
        valueCount: (valuesByOption.get(String(o._id)) ?? []).length,
      })),
      possibleCombinations,
      summary: {
        total: possibleCombinations.length,
        existing: possibleCombinations.filter((c) => c.exists).length,
        creatable: possibleCombinations.filter((c) => !c.exists).length,
      },
      note: 'Preview only. Nothing is created until POST /products/:id/variants is called with a selection.',
    };
  }

  /**
   * Creates variants for the **selected subset only** (spec §5.1(7)-(8)).
   *
   * The submitted `combinationKey` is never trusted: it is recomputed from the submitted
   * value ids, so a client cannot create a variant whose key disagrees with its own
   * contents and later collide with a legitimate combination.
   *
   * Variants, join rows, balances and `initial_stock` movements are written in one
   * transaction — a matrix where half the variants exist and half do not is the exact
   * dual-source ambiguity §4.1 forbids.
   */
  async createVariants(
    productId: string,
    storeId: Types.ObjectId,
    dto: CreateVariantsDto,
    actorUserId?: Types.ObjectId | null,
  ) {
    // Ownership check: the product must belong to this store. Every product is in variant
    // mode now, so there is no simple-mode guard to pass here — the old "convert first"
    // requirement disappeared with `hasVariants`.
    const product = await this.assertProductInStore(productId, storeId);

    // Same rule as createOption: real combinations must never co-exist with the placeholder
    // default. Defense-in-depth for API clients that seed values and call this directly.
    await this.purgeAutoDefault(productId, storeId);

    if (!dto.selections.length) {
      throw new AppException(AppErrorCode.INVALID_COMBINATION, { reason: 'empty_selection' });
    }

    const options = await this.optionModel
      .find({ productId: new Types.ObjectId(productId), storeId })
      .lean()
      .exec();
    const optionIds = new Set(options.map((o) => String(o._id)));

    const valuesByOption = new Map<string, any>();
    for (const option of options) {
      const values = await this.valueModel
        .find({ optionId: option._id, storeId })
        .select('_id optionId isActive')
        .lean()
        .exec();
      for (const v of values) valuesByOption.set(String(v._id), { ...v, optionKey: option.key });
    }

    const expectedOptionCount = options.length;
    const created: string[] = [];
    const duplicates: string[] = [];

    const session = await this.startSession();
    try {
      await session.withTransaction(async () => {
        created.length = 0;
        duplicates.length = 0;

        for (const selection of dto.selections) {
          const ids = selection.optionValueIds;

          if (new Set(ids).size !== ids.length) {
            throw new AppException(AppErrorCode.INVALID_COMBINATION, {
              reason: 'duplicate_value_in_combination',
              optionValueIds: ids,
            });
          }
          if (ids.length !== expectedOptionCount) {
            throw new AppException(AppErrorCode.INVALID_COMBINATION, {
              reason: 'option_count_mismatch',
              expected: expectedOptionCount,
              received: ids.length,
            });
          }

          const optionKeys = new Set<string>();
          for (const rawId of ids) {
            const value = valuesByOption.get(rawId);
            // Spec §8.5: every value must belong to this product. A value from another
            // product would silently create a variant that mixes two products' dimensions.
            if (!value) {
              throw new AppException(AppErrorCode.OPTION_VALUE_NOT_FOUND, { optionValueId: rawId });
            }
            if (!optionKeys.has(value.optionKey)) optionKeys.add(value.optionKey);
            if (!optionIds.has(String((value as any).optionId))) {
              throw new AppException(AppErrorCode.OPTION_VALUE_NOT_FOUND, { optionValueId: rawId });
            }
          }
          if (optionKeys.size !== expectedOptionCount) {
            throw new AppException(AppErrorCode.INVALID_COMBINATION, {
              reason: 'combination_does_not_cover_every_option',
              expected: expectedOptionCount,
              received: optionKeys.size,
            });
          }

          const key = this.combinationKeyFor(ids);

          const existing = await this.variantModel
            .findOne({ productId: new Types.ObjectId(productId), combinationKey: key })
            .session(session)
            .exec();
          if (existing) {
            duplicates.push(key);
            continue;
          }

          // A variant's price may be discounted below its initial price, never above. The
          // selection supplies only what it wants to override, so the effective pair falls back
          // to the product's own price/original price.
          this.assertVariantPriceNotAboveInitial(
            selection.priceOverride ?? product.price,
            selection.compareAtPrice ?? product.originalPrice,
          );

          const variant = new this.variantModel({
            storeId,
            productId: new Types.ObjectId(productId),
            combinationKey: key,
            sku: selection.sku?.trim() || null,
            priceOverride: selection.priceOverride ?? null,
            compareAtPrice: selection.compareAtPrice ?? null,
            lowStockThreshold: selection.lowStockThreshold ?? null,
            image: selection.image ?? null,
            position: created.length,
            isActive: true,
          });
          await variant.save({ session });
          created.push(String(variant._id));

          await this.joinModel.insertMany(
            ids.map((valueId) => ({
              storeId,
              variantId: variant._id,
              optionValueId: new Types.ObjectId(valueId),
            })),
            { session, ordered: true },
          );

          await this.balanceModel.create(
            [
              {
                storeId,
                variantId: variant._id,
                onHand: 0,
                reserved: 0,
                lowStockThreshold: selection.lowStockThreshold ?? null,
              },
            ],
            { session },
          );
        }

        // Movements are appended after the loop so one insert covers the whole selection.
        // `quantityDelta` 0 with `initial_stock` records the counted quantity honestly:
        // a newly created variant starts at zero and the seller sets stock deliberately.
        if (created.length > 0) {
          const ids = created.map((id) => new Types.ObjectId(id));
          await this.movementModel.insertMany(
            ids.map((variantId) => ({
              storeId,
              variantId,
              type: 'initial_stock' as const,
              // 0, honestly recorded: a new variant starts at zero and the seller sets
              // stock deliberately. A non-zero default here would invent inventory nobody
              // counted, which is the phantom-SKU failure the spec forbids.
              quantityDelta: 0,
              onHandBefore: 0,
              onHandAfter: 0,
              reservedBefore: 0,
              reservedAfter: 0,
              reason: dto.reason ?? 'Variant created',
              actorUserId: actorUserId ?? null,
            })),
            { session, ordered: true },
          );
        }
      });
    } catch (err: any) {
      this.mapDuplicateErrors(err, { productId, operation: 'create_variants' });
      throw err;
    } finally {
      await session.endSession();
    }

    return {
      productId,
      created,
      createdCount: created.length,
      skippedDuplicates: duplicates,
      note: 'Only the submitted subset was created. No other combination was implied.',
    };
  }

  // -------------------------------------------------------- variant metadata / state

  async updateVariant(
    productId: string,
    storeId: Types.ObjectId,
    variantId: string,
    dto: UpdateVariantDto,
  ) {
    const product = await this.assertProductInStore(productId, storeId);
    const variant = await this.requireVariant(variantId, productId, storeId);

    const update: Record<string, any> = {};
    if (dto.sku !== undefined) update.sku = dto.sku?.trim() || null;
    if (dto.barcode !== undefined) {
      const barcode = dto.barcode?.trim() || null;
      // Shape (13 digits) is enforced by the DTO; the mod-10 checksum can only be checked here.
      if (barcode !== null && !isValidEan13(barcode)) {
        throw new AppException(AppErrorCode.BARCODE_INVALID, { barcode });
      }
      update.barcode = barcode;
    }
    if (dto.priceOverride !== undefined) update.priceOverride = dto.priceOverride;
    if (dto.compareAtPrice !== undefined) update.compareAtPrice = dto.compareAtPrice;
    if (dto.lowStockThreshold !== undefined) update.lowStockThreshold = dto.lowStockThreshold;
    if (dto.image !== undefined) update.image = dto.image || null;
    if (dto.position !== undefined) update.position = dto.position;

    // Only re-check the price pair when a price field is part of the PATCH: an unrelated edit
    // (SKU, image) must not fail on legacy data that predates the rule. The effective pair falls
    // back to the variant's stored value, then to the product's, exactly like `ProductsService.update`.
    if (dto.priceOverride !== undefined || dto.compareAtPrice !== undefined) {
      const effectivePrice =
        dto.priceOverride !== undefined ? dto.priceOverride : variant.priceOverride;
      const effectiveInitial =
        dto.compareAtPrice !== undefined ? dto.compareAtPrice : variant.compareAtPrice;
      this.assertVariantPriceNotAboveInitial(
        effectivePrice ?? product.price,
        effectiveInitial ?? product.originalPrice,
      );
    }

    try {
      return await this.variantModel
        .findOneAndUpdate({ _id: variant._id }, { $set: update }, { new: true })
        .exec();
    } catch (err: any) {
      // Per-store SKU/barcode uniqueness is enforced by the index, not by the service
      // (spec §5.4 / C.8). Neither field is pre-checked: clearing a code to null must still
      // surface any other unique violation rather than being swallowed as "nothing to check".
      this.mapDuplicateErrors(err, { variantId, sku: update.sku, barcode: update.barcode });
      throw err;
    }
  }

  /**
   * Activates a variant. A soft-deleted one is refused — restoring is a separate decision
   * with its own stock history, not something an activate click implies.
   */
  async activateVariant(productId: string, storeId: Types.ObjectId, variantId: string) {
    await this.assertProductInStore(productId, storeId);
    const variant = await this.requireVariant(variantId, productId, storeId);
    if (variant.isDeleted) {
      throw new AppException(AppErrorCode.VARIANT_NOT_FOUND, { variantId, reason: 'deleted' });
    }

    // Same reserved-stock guard as deactivation: activating a variant while its stock is
    // committed to open orders would put stock on sale that is already promised.
    const reserved = await this.reservedFor([variant._id as Types.ObjectId]);
    if (reserved.total > 0) {
      throw new AppException(AppErrorCode.VARIANT_INACTIVE, {
        reason: 'reserved_stock_exists',
        reserved: reserved.total,
        variantId,
      });
    }

    return this.variantModel
      .findOneAndUpdate({ _id: variant._id, isDeleted: { $ne: true } }, { $set: { isActive: true } }, { new: true })
      .exec();
  }

  /**
   * Deactivates a variant under the spec §5.2 guard.
   *
   * Two rules, in order:
   *  1. `reserved > 0` → blocked outright. Stock is promised to an order in flight.
   *  2. `onHand > 0` → the caller must state what happens to the quantity. Omitting `choice`
   *     is an error, not a default, because the two obvious defaults are both wrong:
   *     discarding stock silently, or deactivating while stock remains sellable.
   */
  async deactivateVariant(
    productId: string,
    storeId: Types.ObjectId,
    variantId: string,
    dto: DeactivateVariantDto,
    actorUserId?: Types.ObjectId | null,
  ) {
    await this.assertProductInStore(productId, storeId);
    const variant = await this.requireVariant(variantId, productId, storeId);

    const balance = await this.balanceModel.findOne({ variantId: variant._id }).exec();
    const onHand = balance?.onHand ?? 0;
    const reserved = balance?.reserved ?? 0;

    if (reserved > 0) {
      throw new AppException(AppErrorCode.VARIANT_INACTIVE, {
        reason: 'reserved_stock_exists',
        reserved,
        onHand,
      });
    }

    if (onHand > 0) {
      if (!dto.choice) {
        throw new AppException(AppErrorCode.VARIANT_DEACTIVATE_REQUIRES_CHOICE, {
          onHand,
          reserved,
          choices: ['keep', 'zero', 'stay_active'],
        });
      }
      if (dto.choice === 'stay_active') {
        throw new AppException(AppErrorCode.VARIANT_INACTIVE, { reason: 'choice_stay_active' });
      }
      if (dto.choice === 'zero' && !dto.reason?.trim()) {
        throw new AppException(AppErrorCode.ADJUSTMENT_REASON_REQUIRED, { context: 'deactivate_zero' });
      }
    }

    const session = await this.startSession();
    try {
      return await session.withTransaction(async () => {
        if (dto.choice === 'zero' && onHand > 0) {
          // `reserved: 0` is asserted in the write predicate, not just in the read above.
          // Between the read and this write another session could reserve stock; matching on
          // the observed onHand alone would zero a balance that is now committed to an
          // order, and a zeroed match would quietly under-report how much was written off.
          const zeroed = await this.balanceModel.updateOne(
            { variantId: variant._id, onHand, reserved: 0 },
            { $set: { onHand: 0 } },
            { session },
          );
          if (zeroed.modifiedCount !== 1) {
            throw new AppException(AppErrorCode.VARIANT_INACTIVE, {
              reason: 'reserved_stock_exists',
              variantId,
              detail: 'Stock changed while deactivating. Reload and retry.',
            });
          }
          // The write-off is a ledger row, not a silent field edit: the quantity has to
          // remain explainable afterwards.
          await this.movementModel.create(
            [
              {
                storeId,
                variantId: variant._id,
                type: 'manual_decrease',
                quantityDelta: -onHand,
                onHandBefore: onHand,
                onHandAfter: 0,
                reservedBefore: reserved,
                reservedAfter: reserved,
                reason: dto.reason ?? 'Zeroed on deactivation',
                actorUserId: actorUserId ?? null,
              },
            ],
            { session },
          );
        }

        return this.variantModel
          .findOneAndUpdate({ _id: variant._id }, { $set: { isActive: false } }, { new: true, session })
          .exec();
      });
    } finally {
      await session.endSession();
    }
  }

  // --------------------------------------------------------------------- matrix read

  /**
   * Options, values, and every **offered** combination — not the Cartesian product.
   *
   * A variant that exists is a row; a combination the seller never offered is not. The
   * storefront cannot order what was not created, so exposing the full cartesian product
   * here would advertise unavailable combinations as merely unlisted.
   */
  async getMatrix(
    productId: string,
    storeId: Types.ObjectId,
    locale?: string,
  ): Promise<VariantMatrix> {
    const product = await this.productModel.findById(productId).lean().exec();
    if (!product || String(product.storeId ?? '') !== String(storeId)) {
      throw new AppException(AppErrorCode.PRODUCT_NOT_IN_STORE, { productId });
    }

    const options = await this.optionModel
      .find({ productId: new Types.ObjectId(productId), storeId })
      .sort({ position: 1 })
      .exec();

    const values = options.length
      ? await this.valueModel
          .find({ productId: new Types.ObjectId(productId), storeId })
          .sort({ position: 1 })
          .exec()
      : [];

    const variants = await this.variantsForProduct(productId, storeId);
    const joins = variants.length
      ? await this.joinModel
          .find({ variantId: { $in: variants.map((v) => v._id) } })
          .lean()
          .exec()
      : [];

    const balances = variants.length
      ? await this.balanceModel
          .find({ variantId: { $in: variants.map((v) => v._id) } })
          .lean()
          .exec()
      : [];

    const balanceByVariant = new Map(balances.map((b) => [String(b.variantId), b]));
    const idsByVariant = new Map<string, string[]>();
    for (const join of joins) {
      const list = idsByVariant.get(String(join.variantId)) ?? [];
      list.push(String(join.optionValueId));
      idsByVariant.set(String(join.variantId), list);
    }

    const valueById = new Map(values.map((v) => [String(v._id), v]));
    const inUse = new Set(joins.map((j) => String(j.optionValueId)));
    const productThreshold = product.lowStockThreshold ?? null;

    return {
      productId,
      productPrice: product.price,
      productOriginalPrice: product.originalPrice,
      productLowStockThreshold: productThreshold,
      options: options.map((o) => ({
        id: String(o._id),
        key: o.key,
        name: { en: o.nameEn ?? o.key, ar: o.nameAr ?? o.key, fr: o.nameFr ?? o.key },
        position: o.position,
        type: this.optionTypeOf(o),
        values: values
          .filter((v) => String(v.optionId) === String(o._id))
          .map((v) => ({
            id: String(v._id),
            value: v.value,
            name: { en: v.valueEn ?? v.value, ar: v.valueAr ?? v.value, fr: v.valueFr ?? v.value },
            color: this.valueColorOf(v),
            position: v.position,
            isActive: v.isActive,
            inUse: inUse.has(String(v._id)),
          })),
      })),
      variants: variants.map((v) => {
        const ids = (idsByVariant.get(String(v._id)) ?? []).sort();
        const balance = balanceByVariant.get(String(v._id));
        const onHand = balance?.onHand ?? 0;
        const reserved = balance?.reserved ?? 0;
        const available = onHand - reserved;
        const threshold =
          balance?.lowStockThreshold ??
          v.lowStockThreshold ??
          productThreshold ??
          DEFAULT_LOW_STOCK_THRESHOLD;
        return {
          variantId: String(v._id),
          combinationKey: v.combinationKey,
          optionValueIds: ids,
          label: this.labelFor(ids, options, this.valuesGrouped(values), locale),
          sku: v.sku ?? null,
          barcode: v.barcode ?? null,
          priceOverride: v.priceOverride ?? null,
          effectivePrice: v.priceOverride ?? product.price,
          compareAtPrice: v.compareAtPrice ?? null,
          isActive: v.isActive,
          onHand,
          reserved,
          available,
          isLowStock: computeLowStock(available, threshold),
          image: v.image ?? null,
          position: v.position,
          isDeleted: !!v.isDeleted,
        };
      }),
    };
  }

/**
 * The buyer-facing projection of the same data.
 *
 * The storefront needs the matrix to let a customer choose, and `getMatrix` cannot serve it: that
 * one is behind the vendor role guard, because it exposes a seller's internal view - SKUs,
 * barcodes, reserved quantities, deactivated rows and the product's low-stock thresholds. Those
 * are all things a shopper should not see.
 *
 * So this is a deliberately narrower shape rather than `getMatrix` with a flag:
 *   - only `published` + `Active` products resolve, so an unpublished draft cannot be probed
 *   - only `isActive`, non-deleted variants are returned
 *   - `sku`, `barcode`, `reserved`, `lowStockThreshold` and `storeId` are not in the response at all
 *   - `available` is what the buyer may actually order; `onHand` is not exposed, because
 *     reserved units would otherwise be inferable and could be over-promised
 *
 * `priceOverride` *is* included: it is the price the shopper pays, so hiding it would make the
 * page quote a price the checkout then contradicts.
 */
async getPublicMatrix(productId: string) {
  const product = await this.productModel
    .findById(productId)
    .select('_id storeId price published')
    .lean()
    .exec();

  // Same shape of answer for "does not exist", "not published" and "not yours to ask about" -
  // a shopper must not be able to tell an unpublished product from a missing one. Every live
  // product is a variant product, so the old `!product.hasVariants` branch no longer exists.
  if (!product || !product.published) {
    return { productId, hasVariants: false, productPrice: 0, options: [], variants: [] };
  }

  const storeId = product.storeId as Types.ObjectId;

  const options = await this.optionModel
    .find({ productId: new Types.ObjectId(productId), storeId })
    .sort({ position: 1 })
    .exec();

  const values = options.length
    ? await this.valueModel
        .find({ productId: new Types.ObjectId(productId), storeId })
        .sort({ position: 1 })
        .exec()
    : [];

  const variants = (await this.variantsForProduct(productId, storeId)).filter(
    (v) => v.isActive && !v.isDeleted,
  );

  const joins = variants.length
    ? await this.joinModel
        .find({ variantId: { $in: variants.map((v) => v._id) } })
        .lean()
        .exec()
    : [];

  const balances = variants.length
    ? await this.balanceModel
        .find({ variantId: { $in: variants.map((v) => v._id) } })
        .lean()
        .exec()
    : [];

  const balanceByVariant = new Map(balances.map((b) => [String(b.variantId), b]));
  const idsByVariant = new Map<string, string[]>();
  for (const join of joins) {
    const list = idsByVariant.get(String(join.variantId)) ?? [];
    list.push(String(join.optionValueId));
    idsByVariant.set(String(join.variantId), list);
  }

  return {
    productId,
    hasVariants: true,
    productPrice: product.price,
    options: options.map((o) => ({
      id: String(o._id),
      key: o.key,
      name: { en: o.nameEn ?? o.key, ar: o.nameAr ?? o.key, fr: o.nameFr ?? o.key },
      type: this.optionTypeOf(o),
      values: values
        .filter((v) => String(v.optionId) === String(o._id) && v.isActive)
        .map((v) => ({
          id: String(v._id),
          value: v.value,
          name: { en: v.valueEn ?? v.value, ar: v.valueAr ?? v.value, fr: v.valueFr ?? v.value },
          color: this.valueColorOf(v),
        })),
    })),
    variants: variants.map((v) => {
      const ids = (idsByVariant.get(String(v._id)) ?? []).sort();
      const balance = balanceByVariant.get(String(v._id));
      const available = Math.max(0, (balance?.onHand ?? 0) - (balance?.reserved ?? 0));
      return {
        variantId: String(v._id),
        combinationKey: v.combinationKey,
        optionValueIds: ids,
        label: this.labelFor(ids, options, this.valuesGrouped(values)),
        priceOverride: v.priceOverride ?? null,
        effectivePrice: v.priceOverride ?? product.price,
        compareAtPrice: v.compareAtPrice ?? null,
        available,
      };
    }),
  };
}

/**
 * Slim buyer-facing availability (inventory audit ME-11a, roadmap 4.1).
 *
 * The same variant set and balance math as {@link getPublicMatrix}, so the two endpoints can
 * never disagree about what is orderable: anything this reports as `available` must be
 * selectable there, and anything it omits must be absent there. The full matrix also carries
 * labels and prices and is the same public throttle bucket; callers that only need to refresh
 * a sold-out state (the storefront's availability polling) fetch this instead of re-downloading
 * the whole matrix.
 */
async getAvailability(productId: string): Promise<{
  productId: string;
  variants: { variantId: string; available: number }[];
}> {
  const product = await this.productModel
    .findById(productId)
    .select('_id storeId published')
    .lean()
    .exec();

  // Identical gate to `getPublicMatrix`: unknown and unpublished products all answer with an
  // empty list, so a shopper cannot distinguish them.
  if (!product || !product.published) {
    return { productId, variants: [] };
  }

  const storeId = product.storeId as Types.ObjectId;
  const variants = (await this.variantsForProduct(productId, storeId)).filter(
    (v) => v.isActive && !v.isDeleted,
  );

  const balances = variants.length
    ? await this.balanceModel
        .find({ variantId: { $in: variants.map((v) => v._id) } })
        .select('variantId onHand reserved')
        .lean()
        .exec()
    : [];

  const availableByVariant = new Map(
    balances.map((b) => [String(b.variantId), Math.max(0, b.onHand - b.reserved)]),
  );

  return {
    productId,
    variants: variants.map((v) => ({
      variantId: String(v._id),
      available: availableByVariant.get(String(v._id)) ?? 0,
    })),
  };
}

/**
 * Batch variant summary for list screens (§4.5).
   *
   * **One aggregation for the whole page**, never a call per product: a listing screen is
   * the hottest read in the system and §4.5 explicitly calls out the N+1 that a per-product
   * lookup would introduce.
   *
   * `priceOverrideMin/Max` cover only variants that override the price; the caller combines
   * them with each product's own `price`, because a variant with no override inherits it.
   */
  async getProductSummaries(productIds: string[]): Promise<Map<string, VariantSummary>> {
    const out = new Map<string, VariantSummary>();
    const ids = productIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (ids.length === 0) return out;

    const rows = await this.variantModel
      .aggregate([
        { $match: { productId: { $in: ids }, isDeleted: { $ne: true } } },
        {
          $lookup: {
            // Resolved from the injected model, never written as a literal: the collection name
            // is whatever Mongoose pluralizes `InventoryBalance` into (`inventorybalances`).
            // A hardcoded 'inventory_balances' made this $lookup match nothing at all, so every
            // listing page reported availableTotal 0 and inStock false for stocked variants.
            from: this.balanceModel.collection.name,
            localField: '_id',
            foreignField: 'variantId',
            as: 'bal',
          },
        },
        { $unwind: { path: '$bal', preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: '$productId',
            variantCount: { $sum: 1 },
            activeVariantCount: { $sum: { $cond: [{ $ifNull: ['$isActive', false] }, 1, 0] } },
            availableTotal: {
              $sum: {
                $subtract: [
                  { $ifNull: ['$bal.onHand', 0] },
                  { $ifNull: ['$bal.reserved', 0] },
                ],
              },
            },
            // $$REMOVE drops the variant's contribution when the field is null, so a
            // product with no overrides reports no min/max rather than a bogus zero.
            overrides: {
              $push: {
                $cond: [
                  { $ne: [{ $type: '$priceOverride' }, 'missing'] },
                  '$priceOverride',
                  '$$REMOVE',
                ],
              },
            },
            skus: {
              $push: { $cond: [{ $ne: [{ $type: '$sku' }, 'missing'] }, '$sku', '$$REMOVE'] },
            },
            // Kept together (not two parallel arrays) so the caller can pair a variant's
            // override with that same variant's compare-at when it derives the listing price.
            variantPrices: {
              $push: {
                priceOverride: { $ifNull: ['$priceOverride', null] },
                compareAtPrice: { $ifNull: ['$compareAtPrice', null] },
              },
            },
          },
        },
        {
          $project: {
            variantCount: 1,
            activeVariantCount: 1,
            availableTotal: 1,
            overrideValues: { $filter: { input: '$overrides', as: 'o', cond: { $ne: ['$$o', null] } } },
            skuValues: { $filter: { input: '$skus', as: 's', cond: { $ne: ['$$s', null] } } },
            variantPrices: 1,
          },
        },
      ])
      .exec();

    for (const row of rows) {
      const overrides = (row.overrideValues ?? []).filter(
        (v: unknown): v is number => typeof v === 'number',
      );
      out.set(String(row._id), {
        variantCount: row.variantCount ?? 0,
        activeVariantCount: row.activeVariantCount ?? 0,
        availableTotal: row.availableTotal ?? 0,
        inStock: (row.availableTotal ?? 0) > 0,
        hasPriceOverride: overrides.length > 0,
        overrideMin: overrides.length ? Math.min(...overrides) : null,
        overrideMax: overrides.length ? Math.max(...overrides) : null,
        variantPrices: (row.variantPrices ?? [])
          .filter((v: any) => v && typeof v === 'object')
          .map((v: any) => ({
            priceOverride: typeof v.priceOverride === 'number' ? v.priceOverride : null,
            compareAtPrice: typeof v.compareAtPrice === 'number' ? v.compareAtPrice : null,
          })),
        skus: row.skuValues?.length ? row.skuValues : undefined,
      });
    }

    return out;
  }

  // ------------------------------------------------------------- default-variant factory

  /**
   * Creates the "Default / One Size" variant every product starts with.
   *
   * Products are always in variant mode now, so the create flow cannot leave a product
   * without a matrix. This builds the smallest honest one - a single option with a single
   * value - and seeds a balance + `initial_stock` ledger opening at `initialQuantity`. That
   * number is always zero at factory time: stock is owned by the inventory module, so a
   * fresh product's default variant holds nothing until the seller stocks it through
   * `PATCH /inventory`. The parameter exists for tooling, never for the create payload.
   * Keeping an opening quantity here would guess inventory the seller never recorded, so it
   * defaults to 0 like every other variant factory.
   *
   * Idempotent: a product that already has variants is reported as skipped, never doubled.
   */
  async createDefaultVariant(
    productId: string,
    storeId: Types.ObjectId,
    initialQuantity = 0,
    actorUserId?: Types.ObjectId | null,
  ) {
    await this.assertProductInStore(productId, storeId);

    const existingVariants = await this.variantModel
      .countDocuments({ productId: new Types.ObjectId(productId), storeId })
      .exec();
    if (existingVariants > 0) {
      return { productId, skipReason: 'already_has_variants', variantsCreated: 0 };
    }

    const session = await this.startSession();
    try {
      await session.withTransaction(async () => {
        const option = new this.optionModel({
          storeId,
          productId: new Types.ObjectId(productId),
          key: 'default',
          nameEn: 'Default',
          nameAr: 'افتراضي',
          nameFr: 'Par défaut',
          position: 0,
          type: 'text',
          isDefault: true,
        });
        await option.save({ session });

        const value = new this.valueModel({
          storeId,
          productId: new Types.ObjectId(productId),
          optionId: option._id,
          value: 'default',
          valueEn: 'One Size',
          valueAr: 'مقاس واحد',
          valueFr: 'Taille unique',
          color: null,
          position: 0,
          isActive: true,
        });
        await value.save({ session });

        const variantId = new Types.ObjectId();
        const now = new Date();
        await this.variantModel.insertMany(
          [
            {
              _id: variantId,
              storeId,
              productId: new Types.ObjectId(productId),
              combinationKey: this.combinationKeyFor([String(value._id)]),
              sku: null,
              isActive: true,
              isDeleted: false,
              position: 0,
              createdAt: now,
              updatedAt: now,
            },
          ],
          { session, ordered: true },
        );

        await this.joinModel.insertMany(
          [{ storeId, variantId, optionValueId: value._id }],
          { session, ordered: true },
        );

        await this.balanceModel.create(
          [
            {
              storeId,
              variantId,
              onHand: initialQuantity,
              reserved: 0,
              lowStockThreshold: null,
            },
          ],
          { session },
        );

        await this.movementModel.insertMany(
          [
            {
              storeId,
              variantId,
              type: 'initial_stock' as const,
              quantityDelta: initialQuantity,
              onHandBefore: 0,
              onHandAfter: initialQuantity,
              reservedBefore: 0,
              reservedAfter: 0,
              reason: 'Default variant created on product creation',
              actorUserId: actorUserId ?? null,
              createdAt: now,
            },
          ],
          { session, ordered: true },
        );
      });
    } catch (err: any) {
      this.mapDuplicateErrors(err, { productId, operation: 'create_default_variant' });
      throw err;
    } finally {
      await session.endSession();
    }

    return { productId, variantsCreated: 1, openingQuantity: initialQuantity };
  }

  /**
   * Removes the auto-seeded "Default > One Size" scaffolding the moment a product grows real
   * variant dimensions, so a size/colour matrix never sits beside a phantom "One Size" row.
   *
   * Product creation seeds a placeholder default variant so a product is orderable before the
   * seller touches variants. The moment a real option is created that placeholder must go -
   * otherwise it would linger in the matrix next to the genuinely offered sizes and colours.
   * A product that never gains real options keeps its default, which is exactly the desired
   * "One Size" product.
   *
   * Two eras are folded into one path:
   *   - clean scaffold - only the default option/value/variant exist. Hard-deleted (its only
   *     movement is the zero-delta scaffold row, so removing it loses no history) and the
   *     product simply has no options again until real ones are added.
   *   - legacy contaminated matrix - real variants whose combination keys already embed the
   *     default value's id (created before this method existed). Their join rows and
   *     combination keys are rewritten to drop the default value, then the scaffold is removed.
   *
   * Safety gates (never destroy data):
   *   - if the default option has grown a second value, the seller is using it as a real
   *     dimension - leave everything alone.
   *   - if the default variant has ever actually moved (non-zero balance, reservation, or any
   *     movement beyond the zero-delta scaffold), soft-deactivate instead of deleting so the
   *     ledger and past orders keep resolving.
   *   - if re-keying a contaminated combination would collide with a variant that already owns
   *     that key, abort for this product rather than guess which row is the real one.
   */
  async purgeAutoDefault(productId: string, storeId: Types.ObjectId) {
    const product = new Types.ObjectId(productId);
    const session = await this.startSession();
    try {
      return await session.withTransaction(async () => {
        const option = await this.optionModel
          .findOne({
            storeId,
            productId: product,
            // Prefer the explicit flag; fall back to the exact scaffold pattern for legacy rows
            // created before the flag existed.
            $or: [
              { isDefault: true },
              { key: 'default', nameEn: 'Default', nameAr: 'افتراضي', nameFr: 'Par défaut' },
            ],
          })
          .session(session)
          .exec();
        if (!option) return { productId, purged: 0, rewritten: 0, deactivated: 0 };

        const values = await this.valueModel
          .find({ optionId: option._id, productId: product, storeId })
          .session(session)
          .exec();

        const isScaffold =
          values.length === 1 && values[0].value === 'default' && values[0].valueEn === 'One Size';
        if (!isScaffold) {
          return { productId, purged: 0, rewritten: 0, deactivated: 0 };
        }
        const defaultValId = values[0]._id as Types.ObjectId;

        const variants = await this.variantModel
          .find({ productId: product, storeId })
          .session(session)
          .exec();
        const joins = variants.length
          ? await this.joinModel
              .find({ variantId: { $in: variants.map((v) => v._id) } })
              .session(session)
              .exec()
          : [];

        const idsByVariant = new Map<string, string[]>();
        for (const join of joins) {
          const list = idsByVariant.get(String(join.variantId)) ?? [];
          list.push(String(join.optionValueId));
          idsByVariant.set(String(join.variantId), list);
        }

        const pureDefault: Types.ObjectId[] = [];
        const contaminated: Array<{ variantId: Types.ObjectId; remainingIds: string[] }> = [];
        for (const v of variants) {
          const ids = idsByVariant.get(String(v._id)) ?? [];
          if (!ids.includes(String(defaultValId))) continue;
          if (ids.length === 1) pureDefault.push(v._id);
          else {
            contaminated.push({
              variantId: v._id,
              remainingIds: ids.filter((id) => id !== String(defaultValId)),
            });
          }
        }

        // Safety gate: a default that actually moved is kept (deactivated) with its history.
        if (pureDefault.length) {
          const ids = pureDefault.map((i) => new Types.ObjectId(i));
          const balances = await this.balanceModel
            .find({ variantId: { $in: ids } })
            .session(session)
            .exec();
          const moves = await this.movementModel
            .find({ variantId: { $in: ids } })
            .session(session)
            .exec();
          const touched =
            balances.some((b) => b.onHand !== 0 || b.reserved !== 0) ||
            moves.some((m) => m.reason !== DEFAULT_VARIANT_REASON || m.quantityDelta !== 0);
          if (touched) {
            await this.variantModel
              .updateMany(
                { _id: { $in: ids }, storeId },
                { $set: { isActive: false, isDeleted: true } },
                { session },
              )
              .exec();
            return { productId, purged: 0, rewritten: 0, deactivated: pureDefault.length };
          }
        }

        // Strip the default value out of legacy combinations and re-key them so the remaining
        // ids are exactly what preview would propose today.
        let rewritten = 0;
        for (const row of contaminated) {
          const nextKey = this.combinationKeyFor(row.remainingIds);
          const clash = await this.variantModel
            .findOne({
              productId: product,
              storeId,
              combinationKey: nextKey,
              _id: { $ne: row.variantId },
            })
            .session(session)
            .exec();
          if (clash) {
            return { productId, purged: 0, rewritten: 0, deactivated: 0 };
          }
          await this.variantModel
            .updateOne({ _id: row.variantId }, { $set: { combinationKey: nextKey } }, { session })
            .exec();
          await this.joinModel
            .deleteOne({ variantId: row.variantId, optionValueId: defaultValId }, { session })
            .exec();
          rewritten++;
        }

        if (pureDefault.length) {
          const ids = pureDefault.map((i) => new Types.ObjectId(i));
          await this.movementModel
            .deleteMany({ variantId: { $in: ids }, storeId }, { session })
            .exec();
          await this.balanceModel
            .deleteMany({ variantId: { $in: ids }, storeId }, { session })
            .exec();
          await this.joinModel
            .deleteMany({ variantId: { $in: ids }, storeId }, { session })
            .exec();
          await this.variantModel.deleteMany({ _id: { $in: ids }, storeId }, { session }).exec();
        }

        const stillReferenced = await this.joinModel
          .countDocuments({ optionValueId: defaultValId, storeId })
          .session(session)
          .exec();
        if (stillReferenced === 0) {
          await this.valueModel.deleteOne({ _id: defaultValId }, { session }).exec();
          await this.optionModel.deleteOne({ _id: option._id }, { session }).exec();
        } else {
          // A stray (normally deactivated) variant still names the value; keep the rows so the
          // join keeps resolving, but retire the value from buyer-facing views.
          await this.valueModel
            .updateOne({ _id: defaultValId }, { $set: { isActive: false } }, { session })
            .exec();
        }

        return { productId, purged: pureDefault.length, rewritten, deactivated: 0 };
      });
    } catch (err: any) {
      this.mapDuplicateErrors(err, { productId, operation: 'purge_auto_default' });
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Copies the source product's option/value/variant structure onto a freshly duplicated
   * product, with every balance opened at zero.
   *
   * A duplicate must never inherit quantities - the seller said nothing about how much the
   * copy holds, so inventing numbers would seed phantom inventory. Instead the structure is
   * copied and each new balance opens at 0 through an honest `initial_stock` (0) movement,
   * exactly like `createVariants`. SKUs and barcodes are not copied (they are store-unique);
   * pricing overrides and thresholds are (they are the point of the copy).
   */
  async duplicateMatrix(
    sourceProductId: string,
    newProductId: string,
    storeId: Types.ObjectId,
    actorUserId?: Types.ObjectId | null,
  ) {
    const options = await this.optionModel
      .find({ productId: new Types.ObjectId(sourceProductId), storeId })
      .sort({ position: 1 })
      .lean()
      .exec();
    if (options.length === 0) {
      return { productId: newProductId, skipReason: 'source_has_no_options', variantsCreated: 0 };
    }

    // The freshly created target product was seeded with an auto-default placeholder at product
    // creation. It must not survive beside the copied real options, or the target would inherit
    // both the source's genuine dimensions and a phantom "One Size".
    await this.purgeAutoDefault(newProductId, storeId);

    const values = await this.valueModel
      .find({ productId: new Types.ObjectId(sourceProductId), storeId })
      .sort({ position: 1 })
      .lean()
      .exec();
    const variants = (await this.variantsForProduct(sourceProductId, storeId)).filter(
      (v) => !v.isDeleted,
    );
    const joins = variants.length
      ? await this.joinModel
          .find({ variantId: { $in: variants.map((v) => v._id) } })
          .lean()
          .exec()
      : [];
    const balances = variants.length
      ? await this.balanceModel
          .find({ variantId: { $in: variants.map((v) => v._id) } })
          .lean()
          .exec()
      : [];

    const idsByVariant = new Map<string, string[]>();
    for (const join of joins) {
      const list = idsByVariant.get(String(join.variantId)) ?? [];
      list.push(String(join.optionValueId));
      idsByVariant.set(String(join.variantId), list);
    }
    const balanceByVariant = new Map(balances.map((b) => [String(b.variantId), b]));

    const session = await this.startSession();
    try {
      await session.withTransaction(async () => {
        const productId = new Types.ObjectId(newProductId);

        const optionIds = new Map<string, Types.ObjectId>();
        for (const option of options) {
          const created = new this.optionModel({
            storeId,
            productId,
            key: option.key,
            nameEn: option.nameEn ?? null,
            nameAr: option.nameAr ?? null,
            nameFr: option.nameFr ?? null,
            position: option.position ?? 0,
            type: this.optionTypeOf(option),
            isDefault: !!option.isDefault,
          });
          await created.save({ session });
          optionIds.set(String(option._id), created._id as Types.ObjectId);
        }

        const valueIds = new Map<string, Types.ObjectId>();
        for (const value of values) {
          const created = new this.valueModel({
            storeId,
            productId,
            optionId: optionIds.get(String(value.optionId)),
            value: value.value,
            valueEn: value.valueEn ?? null,
            valueAr: value.valueAr ?? null,
            valueFr: value.valueFr ?? null,
            color: this.valueColorOf(value),
            position: value.position ?? 0,
            isActive: value.isActive ?? true,
          });
          await created.save({ session });
          valueIds.set(String(value._id), created._id as Types.ObjectId);
        }

        const variantIds = variants.map(() => new Types.ObjectId());
        const now = new Date();

        await this.variantModel.insertMany(
          variants.map((v, i) => {
            const oldIds = idsByVariant.get(String(v._id)) ?? [];
            const mapped = oldIds.map((id) => String(valueIds.get(id) ?? id));
            return {
              _id: variantIds[i],
              storeId,
              productId,
              combinationKey: this.combinationKeyFor(mapped),
              sku: null,
              isActive: v.isActive ?? true,
              isDeleted: false,
              position: i,
              createdAt: now,
              updatedAt: now,
            };
          }),
          { session, ordered: true },
        );

        await this.joinModel.insertMany(
          variants.flatMap((v, i) =>
            (idsByVariant.get(String(v._id)) ?? []).map((id) => ({
              storeId,
              variantId: variantIds[i],
              optionValueId: valueIds.get(id),
            })),
          ),
          { session, ordered: true },
        );

        await this.balanceModel.insertMany(
          variants.map((v, i) => ({
            storeId,
            variantId: variantIds[i],
            onHand: 0,
            reserved: 0,
            lowStockThreshold: balanceByVariant.get(String(v._id))?.lowStockThreshold ?? null,
          })),
          { session, ordered: true },
        );

        await this.movementModel.insertMany(
          variantIds.map((variantId) => ({
            storeId,
            variantId,
            type: 'initial_stock' as const,
            quantityDelta: 0,
            onHandBefore: 0,
            onHandAfter: 0,
            reservedBefore: 0,
            reservedAfter: 0,
            reason: 'Variant copied from duplicate product',
            actorUserId: actorUserId ?? null,
            createdAt: now,
          })),
          { session, ordered: true },
        );
      });
    } catch (err: any) {
      this.mapDuplicateErrors(err, { productId: newProductId, operation: 'duplicate_matrix' });
      throw err;
    } finally {
      await session.endSession();
    }

    return {
      productId: newProductId,
      optionsCreated: options.length,
      variantsCreated: variants.length,
      note: 'Structure copied. Every quantity opened at zero - the copy holds nothing until stocked.',
    };
  }

  // ------------------------------------------------------------------------ helpers

  /**
   * `PRODUCT_NOT_IN_STORE` (404) rather than 403, so a seller cannot enumerate another
   * store's products through the variant API (spec §9).
   */
  private async assertProductInStore(
    productId: string,
    storeId: Types.ObjectId,
  ): Promise<{
    _id: Types.ObjectId;
    storeId: Types.ObjectId;
    price: number;
    originalPrice: number;
  }> {
    const product = (await this.productModel
      .findById(productId)
      // `price`/`originalPrice` are read here, beside ownership, because the variant price
      // invariant (see `assertVariantPriceNotAboveInitial`) needs the product-level fallbacks.
      .select('_id storeId price originalPrice')
      .lean()
      .exec()) as unknown as {
      _id: Types.ObjectId;
      storeId: Types.ObjectId;
      price: number;
      originalPrice: number;
    } | null;
    if (!product || String(product.storeId ?? '') !== String(storeId)) {
      throw new AppException(AppErrorCode.PRODUCT_NOT_IN_STORE, { productId });
    }
    return { ...product };
  }

  /**
   * A variant's selling price may be discounted below its initial (compare-at) price, never above
   * — the same invariant `ProductsService` enforces one level up, applied to the *effective* pair
   * the storefront actually renders: `priceOverride ?? product.price` against
   * `compareAtPrice ?? product.originalPrice`. A variant therefore cannot advertise a price that
   * sits above the "was" figure its card would strike through.
   *
   * `updateVariant` is a partial PATCH and `createVariants` may omit a side, so the effective
   * value falls back to the other input, then to what the variant or product already carries.
   * When neither an override nor a compare-at exists there is still a product-level pair to
   * compare against, so the rule always has something to enforce.
   */
  private assertVariantPriceNotAboveInitial(
    price: number | null | undefined,
    initialPrice: number | null | undefined,
  ): void {
    if (typeof price !== 'number' || typeof initialPrice !== 'number') return;
    if (price > initialPrice) {
      throw new AppException(AppErrorCode.VARIANT_PRICE_EXCEEDS_INITIAL_PRICE, {
        price,
        initialPrice,
      });
    }
  }

  private async requireOption(optionId: string, productId: string, storeId: Types.ObjectId) {
    if (!Types.ObjectId.isValid(optionId)) {
      throw new AppException(AppErrorCode.OPTION_NOT_FOUND, { optionId });
    }
    const option = await this.optionModel
      .findOne({ _id: optionId, productId: new Types.ObjectId(productId), storeId })
      .exec();
    if (!option) throw new AppException(AppErrorCode.OPTION_NOT_FOUND, { optionId });
    return option;
  }

  private async requireValue(valueId: string, optionId: Types.ObjectId, productId: string, storeId: Types.ObjectId) {
    if (!Types.ObjectId.isValid(valueId)) {
      throw new AppException(AppErrorCode.OPTION_VALUE_NOT_FOUND, { valueId });
    }
    const value = await this.valueModel
      .findOne({
        _id: valueId,
        optionId,
        productId: new Types.ObjectId(productId),
        storeId,
      })
      .exec();
    if (!value) throw new AppException(AppErrorCode.OPTION_VALUE_NOT_FOUND, { valueId });
    return value;
  }

  private async requireVariant(variantId: string, productId: string, storeId: Types.ObjectId) {
    if (!Types.ObjectId.isValid(variantId)) {
      throw new AppException(AppErrorCode.VARIANT_NOT_FOUND, { variantId });
    }
    const variant = await this.variantModel
      .findOne({ _id: variantId, productId: new Types.ObjectId(productId), storeId })
      .exec();
    if (!variant) throw new AppException(AppErrorCode.VARIANT_NOT_FOUND, { variantId });
    return variant;
  }

  private async variantsForProduct(productId: string, storeId: Types.ObjectId, includeDeleted = false) {
    return this.variantModel
      .find({
        productId: new Types.ObjectId(productId),
        storeId,
        ...(includeDeleted ? {} : { isDeleted: { $ne: true } }),
      })
      .sort({ position: 1 })
      .exec();
  }

  /**
   * Every variant _id ever created for a product, deleted or not (HI-3, inventory audit).
   *
   * `ProductsService.remove()` uses this to harden its order-history guard: an order line may
   * carry only `variantId`, so a product whose entire order history references it through
   * variants would otherwise pass the `items.productId` count and be deleted under a live
   * reservation. `includeDeleted` matters because the tombstone variant rows are exactly what
   * an older order reference points at.
   */
  async listVariantIdsForProduct(productId: string, storeId: string | Types.ObjectId): Promise<string[]> {
    const variants = await this.variantsForProduct(productId, new Types.ObjectId(String(storeId)), true);
    return variants.map((v) => String(v._id));
  }

  private valuesGrouped(values: ProductOptionValueDocument[]): Map<string, ProductOptionValueDocument[]> {
    const grouped = new Map<string, ProductOptionValueDocument[]>();
    for (const value of values) {
      const list = grouped.get(String(value.optionId)) ?? [];
      list.push(value);
      grouped.set(String(value.optionId), list);
    }
    return grouped;
  }

  /**
 * Tears down the variant matrix when its product is deleted (roadmap 4.10).
 *
 * The shapes are deliberate and match what Phase 3 already established:
 *  - **Variants soft-delete.** Their balances and movements are the audit trail; a hard
 *    delete would leave both pointing at nothing.
 *  - **Option values deactivate** rather than disappear, the same rule as the "never hard
 *    delete a referenced value" decision in Phase 3.
 *  - **Join rows are removed.** They are pure linkage with no history, and the unique
 *    `{ variantId, optionValueId }` index means leftovers would block re-creating the same
 *    combination if the product were ever restored.
 *
 * Refuses outright while any variant still holds an active reservation (spec §7.5): the
 * seller has to resolve the order first, because a deleted variant cannot be reserved,
 * fulfilled, or released against.
 */
async cascadeSoftDeleteForProduct(
  productId: string,
  storeId: string,
): Promise<{ variants: number; values: number; joins: number }> {
  const productObjectId = new Types.ObjectId(productId);
  const storeObjectId = new Types.ObjectId(storeId);

  const variants = await this.variantModel
    .find({ productId: productObjectId, isDeleted: { $ne: true } })
    .select('_id')
    .lean()
    .exec();

  if (variants.length === 0) {
    return { variants: 0, values: 0, joins: 0 };
  }

  const variantIds = variants.map((v) => v._id as Types.ObjectId);

  // Same guard as variant deactivation and the `false -> true` flip: a positive `reserved`
  // balance is what an active reservation produces, and reading the balance rather than the
  // reservation rows also catches a reservation left behind by an older build.
  const reserved = await this.reservedFor(variantIds);
  if (reserved.total > 0) {
    throw new AppException(AppErrorCode.VARIANT_HAS_RESERVED_STOCK, {
      productId,
      reason: 'reserved_stock_exists',
      reserved: reserved.total,
      variants: reserved.byVariant,
    });
  }

  const session = await this.startSession();
  try {
    let summary = { variants: 0, values: 0, joins: 0 };

    await session.withTransaction(async () => {
      const now = new Date();

      const variantResult = await this.variantModel
        .updateMany(
          { _id: { $in: variantIds }, isDeleted: { $ne: true } },
          { $set: { isDeleted: true, deletedAt: now } },
          { session },
        )
        .exec();

      const valueResult = await this.valueModel
        .updateMany(
          { productId: productObjectId, storeId: storeObjectId },
          { $set: { isActive: false } },
          { session },
        )
        .exec();

      const joinResult = await this.joinModel
        .deleteMany({ variantId: { $in: variantIds } }, { session })
        .exec();

      summary = {
        variants: variantResult.modifiedCount || 0,
        values: valueResult.modifiedCount || 0,
        joins: joinResult.deletedCount || 0,
      };
    });

    return summary;
  } finally {
    await session.endSession();
  }
}

/**
 * Order-line snapshot data for a set of variants (roadmap 4.6, spec §7.4).
 * Lives here rather than in `OrdersService` because the label format has to be the *same*
 * string the seller already sees in the matrix. Building it a second time would let the two
 * drift, and an order whose label reads differently from the product page is exactly the
 * "historical orders must stay readable" failure spec §7.4 warns about.
 *
 * Re-resolved on every call and never cached: a rename after the order was placed must not
 * rewrite the snapshot, because the snapshot is a copy taken at purchase time.
 */
async snapshotsForVariants(
  variantIds: string[],
): Promise<Map<string, VariantOrderSnapshot>> {
  const ids = variantIds
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  if (ids.length === 0) return new Map();

  const [variants, joins] = await Promise.all([
    this.variantModel.find({ _id: { $in: ids } }).lean().exec(),
    this.joinModel.find({ variantId: { $in: ids } }).lean().exec(),
  ]);

  if (variants.length === 0) return new Map();

  // Options are reached through the values, so the value load has to finish first.
  const values = await this.valueModel
    .find({ _id: { $in: [...new Set(joins.map((j: any) => String(j.optionValueId)))] } })
    .lean()
    .exec();

  const options = await this.optionModel
    .find({ _id: { $in: [...new Set(values.map((v: any) => String(v.optionId)))] } })
    .lean()
    .exec();

  const optionById = new Map<string, any>(options.map((o: any) => [String(o._id), o]));
  const valueById = new Map<string, any>(values.map((v: any) => [String(v._id), v]));
  const valuesGrouped = this.valuesGrouped(values as any);

  const idsByVariant = new Map<string, string[]>();
  for (const join of joins) {
    const list = idsByVariant.get(String(join.variantId)) ?? [];
    list.push(String(join.optionValueId));
    idsByVariant.set(String(join.variantId), list);
  }

  const snapshots = new Map<string, VariantOrderSnapshot>();

  for (const variant of variants) {
    const optionValueIds = (idsByVariant.get(String(variant._id)) ?? []).sort();
    const snapshotOptions = optionValueIds
      .map((id) => {
        const value = valueById.get(id);
        if (!value) return null;
        const option = optionById.get(String(value.optionId));
        const optionName = option?.nameEn || option?.key || '';
        const valueName = value.valueEn || value.value;
        return {
          optionKey: option?.key ?? '',
          optionName: optionName || String(value.optionId),
          value: value.value ?? '',
          valueName: valueName ?? '',
        };
      })
      .filter((o): o is NonNullable<typeof o> => !!o);

    snapshots.set(String(variant._id), {
      variantId: String(variant._id),
      productId: String(variant.productId),
      storeId: variant.storeId ? String(variant.storeId) : null,
      sku: variant.sku ?? null,
      priceOverride: variant.priceOverride ?? null,
      compareAtPrice: variant.compareAtPrice ?? null,
      image: variant.image ?? null,
      isActive: !!variant.isActive,
      snapshot: {
        options: snapshotOptions,
        label: this.labelFor(optionValueIds, options as any, valuesGrouped),
      },
    });
  }

  return snapshots;
}

/**
 * Delegates to the shared builder so the matrix, the inventory list and the movement ledger
 * cannot drift apart. See `variant-label.ts` for the rule.
 */
private labelFor(
    optionValueIds: string[],
    options: Array<{ _id: Types.ObjectId; nameEn?: string | null; nameAr?: string | null; nameFr?: string | null; key: string }>,
    valuesByOption: Map<string, ProductOptionValueDocument[]>,
    locale?: string,
  ): string {
    const valueById = new Map<string, LabelValue>();
    for (const list of valuesByOption.values()) {
      for (const value of list) valueById.set(String(value._id), value);
    }

    const optionById = new Map<string, LabelOption>();
    for (const option of options) optionById.set(String(option._id), option);

    return buildVariantLabel(optionValueIds, optionById, valueById, locale);
  }

  /**
   * Variants a label change would touch. Returned so the seller can be shown it before
   * committing (spec §5.2) rather than discovering afterwards that twenty variants changed.
   */
  private async affectedVariants(
    productId: string,
    storeId: Types.ObjectId,
    valueId: Types.ObjectId,
  ): Promise<AffectedVariants> {
    return this.describeVariants(productId, storeId, await this.variantIdsUsingValue(valueId));
  }

  /** Describes the given variants (labels, SKU, stock) for an "this rename touches N" preview. */
  private async describeVariants(
    productId: string,
    storeId: Types.ObjectId,
    variantIds: Array<Types.ObjectId | string>,
  ): Promise<AffectedVariants> {
    if (variantIds.length === 0) return { productId, count: 0, variants: [] };

    const all = await this.variantsForProduct(productId, storeId);
    const wanted = new Set(variantIds.map(String));
    const variants = all.filter((v) => wanted.has(String(v._id)));
    if (variants.length === 0) return { productId, count: 0, variants: [] };

    const options = await this.optionModel
      .find({ productId: new Types.ObjectId(productId), storeId })
      .lean()
      .exec();
    const allValues = await this.valueModel
      .find({ productId: new Types.ObjectId(productId), storeId })
      .exec();
    const grouped = this.valuesGrouped(allValues);

    const joins = await this.joinModel
      .find({ variantId: { $in: variants.map((v) => v._id) } })
      .lean()
      .exec();
    const idsByVariant = new Map<string, string[]>();
    for (const join of joins) {
      const list = idsByVariant.get(String(join.variantId)) ?? [];
      list.push(String(join.optionValueId));
      idsByVariant.set(String(join.variantId), list);
    }

    const balances = await this.balanceModel
      .find({ variantId: { $in: variants.map((v) => v._id) } })
      .select('variantId onHand reserved')
      .lean()
      .exec();
    const balanceByVariant = new Map(balances.map((b) => [String(b.variantId), b]));

    return {
      productId,
      count: variants.length,
      variants: variants.map((v) => ({
        variantId: String(v._id),
        combinationKey: v.combinationKey,
        label: this.labelFor(
          (idsByVariant.get(String(v._id)) ?? []).sort(),
          options,
          grouped,
        ),
        sku: v.sku ?? null,
        onHand: balanceByVariant.get(String(v._id))?.onHand ?? 0,
        reserved: balanceByVariant.get(String(v._id))?.reserved ?? 0,
      })),
    };
  }

  private async variantIdsUsingValue(valueId: Types.ObjectId): Promise<Types.ObjectId[]> {
    const joins = await this.joinModel.find({ optionValueId: valueId }).select('variantId').lean().exec();
    return joins.map((j) => j.variantId as Types.ObjectId);
  }

  private async reservedFor(variantIds: Types.ObjectId[]): Promise<{ total: number; byVariant: number }> {
    if (variantIds.length === 0) return { total: 0, byVariant: 0 };
    const balances = await this.balanceModel
      .find({ variantId: { $in: variantIds } })
      .select('reserved')
      .lean()
      .exec();
    const byVariant = balances.reduce((sum, b) => sum + (b.reserved ?? 0), 0);
    return { total: byVariant, byVariant };
  }

  /**
   * Translates a MongoDB `E11000` into the specific conflict it represents.
   *
   * The index is the authority for uniqueness (spec §5.4 / C.8), so the mapping is driven by
   * the index that fired — `keyPattern`/`keyValue` from the driver, falling back to the
   * message only when an older server omits them. Anything unrecognised is rethrown rather
   * than guessed at: reporting a SKU clash for a combination clash sends the seller looking in
   * the wrong place, and silently swallowing the error hides a data-integrity problem.
   */
private mapDuplicateErrors(err: any, context: Record<string, unknown> = {}): void {
    if (err?.code !== 11000) return;

    const fields = Object.keys(err.keyPattern ?? {}).join(',');
    const indexName = String(err?.errmsg ?? '').match(/index:\s*(\S+)/)?.[1] ?? '';
    const haystack = `${fields} ${indexName} ${String(err?.message ?? '')}`;

    if (haystack.includes('combinationKey')) {
      throw new AppException(AppErrorCode.DUPLICATE_VARIANT_COMBINATION, {
        ...context,
        index: indexName || 'productId_1_combinationKey_1',
      });
    }
    if (haystack.includes('barcode')) {
      throw new AppException(AppErrorCode.BARCODE_DUPLICATE, {
        ...context,
        barcode: err.keyValue?.barcode ?? context.barcode ?? null,
        index: indexName || 'storeId_1_barcode_1',
      });
    }
    if (haystack.includes('sku')) {
      throw new AppException(AppErrorCode.DUPLICATE_SKU, {
        ...context,
        sku: err.keyValue?.sku ?? context.sku,
        index: indexName || 'storeId_1_sku_1',
      });
    }
    throw err;
  }
  /** Resolves the canonical write/read value for `type` with a legacy tolerance.
   */
  private optionTypeOf(option: { type?: string | null; displayType?: string | null }): OptionType {
    if (option.type === 'color' || option.type === 'text' || option.type === 'size') return option.type;
    return option.displayType === 'swatch' ? 'color' : 'text';
  }

  /** Resolves the canonical read value for `color` with a legacy tolerance. */
  private valueColorOf(value: { color?: string | null; swatch?: string | null }): string | null {
    return value.color ?? value.swatch ?? null;
  }

  /**
   * Normalises a display-only swatch hex. Empty values become `null` (no swatch).
   * The hex is purely presentational - the option's real value is its text name.
   */
  private normalizeColor(raw?: string | null): string | null {
    if (raw == null) return null;
    const v = raw.trim();
    if (!v) return null;
    if (!/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) {
      throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, { field: 'color', value: raw });
    }
    return v;
  }

  private slug(raw: string): string {
    return String(raw)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);
  }

  /**
   * Transactions need a replica set. On a standalone mongod they throw
   * `Transaction numbers are only allowed on a replica set member`, so the failure is
   * translated into an actionable message instead of a 500 (Phase 0.3).
   */
/**
     * Opens a session and verifies this deployment can actually run transactions.
     *
     * The probe is a real `startTransaction` on a throwaway session, never the caller's: callers
     * hand the returned session to `withTransaction`, which starts its own transaction, and
     * starting one here first left the session mid-transaction ("Transaction already in
     * progress"). The probe session is always ended before this returns.
     */
    private async startSession(): Promise<ClientSession> {
      return openTransactionSession(this.balanceModel, this.logger);
    }
}