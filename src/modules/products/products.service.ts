import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Product, ProductDocument } from './schemas/product.schema';
import { Category, CategoryDocument } from '../categories/schemas/category.schema';
import { SubCategory, SubCategoryDocument } from '../categories/schemas/sub-category.schema';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { ProductQueryDto, VendorProductQueryDto, ProductSuggestionQueryDto, CursorDto } from './dto/product-query.dto';
import { CacheService } from '../../common/cache.service';
import { StoresService } from '../stores/stores.service';
import { UploadService } from '../upload/upload.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/constants/audit-action.enum';
import { ResourceType } from '../../common/constants/resource-type.enum';
import { VariantsService } from '../inventory/services/variants.service';

function firstNonEmpty(...values: (string | undefined | null)[]): string {
  return values.find((v) => typeof v === 'string' && v.trim().length > 0) || '';
}

/**
 * The one place user text becomes a regex. Every search path here matches with `$regex`,
 * so every path escapes the same metacharacters first — otherwise a product named "C++"
 * (or a query containing one) would be a syntax error rather than a literal match.
 */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fillLanguages(
  en: string | undefined | null,
  ar: string | undefined | null,
  fr: string | undefined | null,
): { nameEn: string; nameAr: string; nameFr: string } {
  const first = firstNonEmpty(en, ar, fr);
  return {
    nameEn: en || first,
    nameAr: ar || first,
    nameFr: fr || first,
  };
}

export interface CursorPaginatedResult<T> {
  products: T[];
  nextCursor: CursorDto | null;
  hasMore: boolean;
}

/**
 * Offset-paginated page of products, shaped exactly like `GET /orders` so the vendor UI can
 * reuse the same `<Pagination>` control and "showing X–Y of Z" footer.
 */
export interface PaginatedProductsResult<T> {
  products: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * One row of the inventory search box's autocomplete.
 *
 * Exactly what a dropdown renders — an id to select, the three name languages to show,
 * the thumbnail and the slug — and nothing else. No price, no stock, no category
 * population: suggestions are fetched while the vendor types, so the payload has to be
 * proportional to the dropdown, not to a product page.
 */
export interface ProductSuggestion {
  id: string;
  name: { en: string; ar: string; fr: string };
  image: string | null;
  slug: string | null;
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);
  constructor(
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    @InjectModel(Category.name) private categoryModel: Model<CategoryDocument>,
    @InjectModel(SubCategory.name) private subCategoryModel: Model<SubCategoryDocument>,
    @InjectModel(Order.name) private orderModel: Model<OrderDocument>,
    private readonly cacheService: CacheService,
    private readonly storesService: StoresService,
    private readonly uploadService: UploadService,
    private readonly variantsService: VariantsService,
    private readonly auditService: AuditService,
  ) {}

  private slugify(name: string): string {
    let slug = name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!slug) {
      slug = `product-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    }
    return slug;
  }

  /**
   * The discount price (`price`) may be lower than the original price, never higher.
   *
   * Enforced here rather than in the DTO because `PATCH` is partial: one of the pair can
   * arrive without the other, so the comparison must run against the *effective* values
   * (incoming value, else the stored one). On create `price` defaults to `originalPrice`,
   * which is trivially valid (equal), so a payload carrying only `originalPrice` is fine.
   */
  private assertPriceNotAboveOriginal(
    price: number | undefined | null,
    originalPrice: number | undefined | null,
  ): void {
    if (typeof price !== 'number' || typeof originalPrice !== 'number') return;
    if (price > originalPrice) {
      throw new AppException(AppErrorCode.PRODUCT_PRICE_EXCEEDS_ORIGINAL_PRICE, {
        price,
        originalPrice,
      });
    }
  }

  /**
   * Store-owned taxonomy invariant: a product may only reference a category and
   * subcategory that are non-deleted, belong to the product's store, and whose parent
   * relationship matches. Every product write calls this with the *effective* pair.
   */
  private async assertProductCategories(
    storeId: string | Types.ObjectId,
    categoryId: string | Types.ObjectId | undefined | null,
    subCategoryId?: string | Types.ObjectId | null,
  ): Promise<void> {
    // `CreateProductDto`/`UpdateProductDto` guarantee a valid ObjectId on the HTTP path. The
    // optional branch keeps internal/service-level callers that carry no category unchanged.
    if (!categoryId) return;
    if (!Types.ObjectId.isValid(String(categoryId))) {
      throw new AppException(AppErrorCode.PRODUCT_CATEGORY_NOT_IN_STORE, { categoryId });
    }
    const category = await this.categoryModel
      .findOne({ _id: categoryId, storeId, isDeleted: false })
      .select('_id')
      .lean()
      .exec();
    if (!category) {
      throw new AppException(AppErrorCode.PRODUCT_CATEGORY_NOT_IN_STORE, { categoryId });
    }

    if (!subCategoryId) return;
    if (!Types.ObjectId.isValid(String(subCategoryId))) {
      throw new AppException(AppErrorCode.PRODUCT_CATEGORY_NOT_IN_STORE, {
        subCategoryId,
      });
    }
    const subCategory = await this.subCategoryModel
      .findOne({ _id: subCategoryId, storeId, isDeleted: false })
      .select('_id categoryId')
      .lean()
      .exec();
    if (!subCategory) {
      throw new AppException(AppErrorCode.PRODUCT_CATEGORY_NOT_IN_STORE, { subCategoryId });
    }
    if (String(subCategory.categoryId) !== String(categoryId)) {
      throw new AppException(AppErrorCode.SUBCATEGORY_PARENT_MISMATCH, {
        categoryId: String(categoryId),
        subCategoryId: String(subCategoryId),
        parentId: String(subCategory.categoryId),
      });
    }
  }

  private async filterInStore(
    storeId: Types.ObjectId,
    categoryId?: string,
    subCategoryId?: string,
  ): Promise<boolean> {
    if (!categoryId && !subCategoryId) return true;
    if (categoryId && !(await this.categoryModel.exists({ _id: categoryId, storeId, isDeleted: false }))) {
      return false;
    }
    if (!subCategoryId) return true;
    const subFilter: Record<string, unknown> = {
      _id: subCategoryId,
      storeId,
      isDeleted: false,
    };
    if (categoryId) subFilter.categoryId = categoryId;
    return !!(await this.subCategoryModel.exists(subFilter));
  }

  async create(
    createProductDto: CreateProductDto,
    vendorEmail: string,
    userId?: string,
  ): Promise<Product> {
    this.assertPriceNotAboveOriginal(
      createProductDto.price ?? createProductDto.originalPrice,
      createProductDto.originalPrice,
    );

    const filled = fillLanguages(createProductDto.nameEn, createProductDto.nameAr, createProductDto.nameFr);

    const baseName = firstNonEmpty(createProductDto.nameEn, createProductDto.nameAr, createProductDto.nameFr);
    let slug = this.slugify(baseName);

    const existing = await this.productModel.findOne({ slug }).exec();
    if (existing) {
      slug = `${slug}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    }

    // storeId migration shim: dual-write the canonical store reference alongside vendorEmail.
    // Prefer the session's vendor id (a stable ownership key) and fall back to the legacy
    // email lookup only when the caller has no store record yet.
    const sessionStore = userId
      ? await this.storesService.findByVendorId(userId).catch(() => null)
      : null;
    const storeId =
      sessionStore?._id ??
      (await this.storesService.resolveStoreIdByEmail(vendorEmail).catch(() => null));

    if (storeId) {
      await this.assertProductCategories(storeId, createProductDto.category, createProductDto.subCategory);
    }

    const created = new this.productModel({
      ...createProductDto,
      vendorEmail,
      ...(storeId ? { storeId } : {}),
      ...filled,
      price: createProductDto.price ?? createProductDto.originalPrice,
      slug,
    });

    this.cacheService.clear('categories:');
    const saved = await created.save();
    await this.storesService.incrementProductCount(vendorEmail, 1);

    // Every product is a variant product, so a brand-new product needs its default
    // "One Size" variant + balance before the seller ever sees it. The balance opens at
    // zero — stock is owned by the inventory module and set through the inventory endpoints.
    try {
      if (storeId) {
        const factory = await this.variantsService.createDefaultVariant(
          String(saved._id),
          storeId,
          0,
        );
        (saved as any).variantFactory = factory;
      }
    } catch (err) {
      // Roll the product back rather than leave a bare document with no matrix: a product
      // without variants now violates the universal-variant invariant. The counter was
      // already incremented for the saved product, so this compensating decrement keeps
      // the store's product count net-zero on the rollback path.
      this.logger.warn(
        `Default variant creation failed for product ${saved._id}; rolling back. ${String(
          (err as Error)?.message ?? err,
        )}`,
      );
      await this.productModel.deleteOne({ _id: saved._id }).exec();
      this.storesService.incrementProductCount(vendorEmail, -1);
      throw err;
    }

    return saved;
  }

  async findAll(query: ProductQueryDto): Promise<CursorPaginatedResult<Product>> {
    const filter: Record<string, any> = { published: true };

    // `storeId` is preferred and takes precedence. The legacy `vendorEmail` remains
    // supported so the un-migrated storefront keeps working through Phase 3.
    if (query.storeId) {
      filter.storeId = new Types.ObjectId(query.storeId);
    } else if (query.vendorEmail) {
      filter.vendorEmail = query.vendorEmail;
    }
    if (query.category) filter.category = query.category;
    if (query.subCategory) filter.subCategory = query.subCategory;
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      filter.price = {};
      if (query.minPrice !== undefined) filter.price.$gte = query.minPrice;
      if (query.maxPrice !== undefined) filter.price.$lte = query.maxPrice;
    }

    const sortMapping: Record<string, any> = {
      price_asc: { price: 1, createdAt: -1, _id: -1 },
      price_desc: { price: -1, createdAt: -1, _id: -1 },
      newest: { createdAt: -1, _id: -1 },
      name: { nameEn: 1, createdAt: -1, _id: -1 },
    };

    const limit = query.limit || 20;
    let sortOption: Record<string, any>;
    let searchFilter: Record<string, any>;

    let cursorObj: CursorDto | null = null;
    if (query.cursor) {
      try { cursorObj = JSON.parse(query.cursor); } catch { console.warn('Invalid cursor JSON:', query.cursor); }
    }

    if (query.search) {
      const search = query.search;
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = { $regex: escaped, $options: 'i' };

      const andConditions: Record<string, any>[] = [
        filter,
        {
          $or: [
            { nameEn: regex },
            { nameAr: regex },
            { nameFr: regex },
            { storyEn: regex },
            { storyAr: regex },
            { storyFr: regex },
          ],
        },
      ];

      // A category/subcategory label match must never pull another store's products in.
      const categoryScope: Record<string, unknown> = {
        isDeleted: false,
        isPublished: true,
      };
      if (query.storeId) categoryScope.storeId = new Types.ObjectId(query.storeId);

      const matchingCategories = await this.categoryModel.find({
        ...categoryScope,
        $or: [
          { nameEn: regex },
          { nameAr: regex },
          { nameFr: regex },
          { slug: regex },
        ],
      }).select('_id').lean().exec();
      if (matchingCategories.length > 0) {
        andConditions.push({ category: { $in: matchingCategories.map(c => c._id) } });
      }

      const matchingSubCategories = await this.subCategoryModel.find({
        ...categoryScope,
        $or: [
          { nameEn: regex },
          { nameAr: regex },
          { nameFr: regex },
          { slug: regex },
        ],
      }).select('_id').lean().exec();
      if (matchingSubCategories.length > 0) {
        andConditions.push({ subCategory: { $in: matchingSubCategories.map(s => s._id) } });
      }

      if (cursorObj && cursorObj.createdAt && cursorObj._id) {
        andConditions.push({
          $or: [
            { createdAt: { $lt: new Date(cursorObj.createdAt) } },
            { createdAt: new Date(cursorObj.createdAt), _id: { $lt: new Types.ObjectId(cursorObj._id) } },
          ],
        });
      }

      searchFilter = { $and: andConditions };
      sortOption = sortMapping[query.sortBy || 'newest'] || { createdAt: -1, _id: -1 };
    } else {
      searchFilter = { ...filter };
      sortOption = sortMapping[query.sortBy || 'newest'] || { createdAt: -1, _id: -1 };

      if (cursorObj && cursorObj.createdAt && cursorObj._id) {
        searchFilter.$or = [
          { createdAt: { $lt: new Date(cursorObj.createdAt) } },
          { createdAt: new Date(cursorObj.createdAt), _id: { $lt: new Types.ObjectId(cursorObj._id) } },
        ];
      }
    }
    const items = await this.productModel
      .find(searchFilter)
      // Public payload: the seller's email and user id are not part of a storefront listing,
      // and `vendorEmail` was the identifier the removed public carrier-config route accepted.
      .select('-vendorEmail -vendorId')
      .sort(sortOption)
      .limit(limit + 1)
      .populate('category', 'nameEn nameAr nameFr slug image isPublished')
      .populate('subCategory', 'nameEn nameAr nameFr slug isPublished categoryId')
      // Lean, because `variantSummary` is computed and has no schema path. On a hydrated
      // document `set()` on an undeclared path is dropped by strict mode, and the summary
      // would silently vanish from the response.
      .lean()
      .exec();

    const hasMore = items.length > limit;
    if (hasMore) items.pop();

    await this.attachVariantSummaries(items);

    let nextCursor: CursorDto | null = null;
    if (items.length > 0) {
      const last = items[items.length - 1];
      nextCursor = {
        createdAt: (last as any).createdAt instanceof Date
          ? (last as any).createdAt.toISOString()
          : String((last as any).createdAt),
        _id: String(last._id),
      };
    }

    return { products: items as Product[], nextCursor, hasMore };
  }

  /**
   * Adds a `variantSummary` to every product in a page (spec §10.5).
   *
   * Every product is a variant product now, so there is no simple/variant split to respect:
   * each row gets a summary of its own matrix (a product whose factory never ran reports
   * zero variants, which is how an empty matrix is distinguishable from an ordinary one).
   *
   * One aggregation for the whole page, never a query per product.
   */
  private async attachVariantSummaries(
    items: Array<Record<string, any>>,
  ): Promise<void> {
    if (items.length === 0) return;

    const summaries = await this.variantsService.getProductSummaries(
      items.map((p) => String(p._id)),
    );

    for (const product of items) {
      const summary = summaries.get(String(product._id));
      if (!summary) continue;

      const basePrice = product.price ?? 0;
      const min = summary.hasPriceOverride
        ? Math.min(summary.overrideMin as number, basePrice)
        : basePrice;
      const max = summary.hasPriceOverride
        ? Math.max(summary.overrideMax as number, basePrice)
        : basePrice;

      // The listing pairs "from <min>" with the compare-at of the variant that actually owns
      // that minimum, so the struck-through "was" and the discount badge describe the same
      // unit. A null stays null; the card then falls back to the product's own originalPrice.
      const variantPrices = summary.variantPrices ?? [];
      const effectiveOf = (p: { priceOverride: number | null }) =>
        typeof p.priceOverride === 'number' ? p.priceOverride : basePrice;
      const owner =
        variantPrices.find((p) => effectiveOf(p) === min) ??
        summary.variantPrices?.reduce<(typeof summary.variantPrices)[number] | undefined>(
          (best, p) => (!best || effectiveOf(p) < effectiveOf(best) ? p : best),
          undefined,
        );

      // `variantPrices` is an internal derivation input, never part of the public payload.
      const { variantPrices: _variantPrices, ...publicSummary } = summary;
      product.variantSummary = {
        ...publicSummary,
        // A variant with no override inherits `Product.price`, so that price belongs in the
        // range — otherwise one cheap override would report a false minimum.
        priceRange: { min, max, compareAtPrice: owner?.compareAtPrice ?? null },
      };
    }
  }

  /**
   * D3 ownership check (PLAN_STORE_ID_MIGRATION.md).
   *
   * A vendor may only touch documents that belong to their own store. Compares the stable
   * `storeId` rather than the mutable `vendorEmail`. Falls back to the legacy email
   * comparison only for documents written before the migration (no `storeId`) or for
   * callers that have no store record yet.
   */
  private async assertOwnership(
    doc: { storeId?: Types.ObjectId | null; vendorEmail?: string | null },
    userId: string | undefined,
    userEmail: string,
    action: string,
  ): Promise<void> {
    const store = userId ? await this.storesService.findByVendorId(userId).catch(() => null) : null;

    if (store) {
      const docStoreId = doc.storeId ? String(doc.storeId) : null;
      if (docStoreId === String(store._id)) return;
      // Document predates the migration: allow the legacy email match, otherwise deny.
      if (!docStoreId && this.sameEmail(doc.vendorEmail, userEmail)) return;
      throw new AppException(AppErrorCode.PRODUCT_ACCESS_DENIED, { action });
    }

    if (this.sameEmail(doc.vendorEmail, userEmail)) return;
    throw new AppException(AppErrorCode.PRODUCT_ACCESS_DENIED, { action });
  }

  private sameEmail(a?: string | null, b?: string | null): boolean {
    return !!a && !!b && a.toLowerCase() === b.toLowerCase();
  }

  /**
   * Lightweight product lookup behind the inventory search box's suggestions (spec §6).
   *
   * Deliberately not `findVendorProducts`: that is a catalogue listing — cursor-paginated,
   * category-populated, variant-summarised per row — which is precisely what a dropdown
   * must not do while the vendor types. This is one indexed ownership match, a projection
   * over five fields and a small limit; it never touches stock, and it shares nothing with
   * the `GET /inventory` listing query, so a keystroke cannot move the grid.
   *
   * Store scope comes from the session's vendor id, never from the request, so a caller
   * can only ever be shown their own catalogue. The `vendorEmail` branch is the same
   * pre-migration fallback `findVendorProducts` uses, for products not yet backfilled.
   */
  async searchSuggestions(
    vendorId: string,
    query: ProductSuggestionQueryDto,
  ): Promise<ProductSuggestion[]> {
    const store = await this.storesService.findByVendorIdOrThrow(vendorId);

    const q = (query.q ?? '').trim();
    if (!q) return [];

    const ownership: Record<string, unknown>[] = [{ storeId: store._id }];
    if (store.vendorEmail) ownership.push({ vendorEmail: store.vendorEmail });

    const regex = { $regex: escapeRegex(q), $options: 'i' };
    const limit = Math.min(Math.max(query.limit ?? 8, 1), 20);

    const items = await this.productModel
      .find({
        $and: [
          { $or: ownership },
          { $or: [{ nameEn: regex }, { nameAr: regex }, { nameFr: regex }, { slug: regex }] },
        ],
      })
      .select('_id nameEn nameAr nameFr slug image')
      .sort({ nameEn: 1, _id: 1 })
      .limit(limit)
      .lean()
      .exec();

    return items.map((p) => ({
      id: String(p._id),
      name: { en: p.nameEn ?? '', ar: p.nameAr ?? '', fr: p.nameFr ?? '' },
      image: p.image ?? null,
      slug: p.slug ?? null,
    }));
  }

  async findVendorProducts(vendorEmail: string, query: VendorProductQueryDto): Promise<PaginatedProductsResult<Product>> {
    const storeId = await this.storesService.resolveStoreIdByEmail(vendorEmail).catch(() => null);
    const filter: Record<string, any> = storeId
      ? { $or: [{ storeId }, { vendorEmail }] }
      : { vendorEmail };

    // Offset pagination, mirroring `OrdersService.findAll`: the vendor page renders a page
    // selector and a total, both of which a cursor response cannot express.
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    // A category/subcategory filter from another store can never match; answer with an
    // empty page instead of silently ignoring the filter and showing the whole catalogue.
    if (storeId && (query.category || query.subCategory)) {
      const allowed = await this.filterInStore(
        storeId,
        query.category,
        query.subCategory,
      );
      if (!allowed) {
        return { products: [], total: 0, page, limit, totalPages: 0 };
      }
    }

    if (query.category) filter.category = query.category;
    if (query.subCategory) filter.subCategory = query.subCategory;
    if (query.published !== undefined) filter.published = query.published === 'true';
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      filter.price = {};
      if (query.minPrice !== undefined) filter.price.$gte = query.minPrice;
      if (query.maxPrice !== undefined) filter.price.$lte = query.maxPrice;
    }

    const skip = (page - 1) * limit;

    let sortOption: Record<string, any>;
    let searchFilter: Record<string, any>;

    if (query.search) {
      const regex = { $regex: escapeRegex(query.search), $options: 'i' };

      const orConditions: Record<string, any>[] = [
        { nameEn: regex },
        { nameAr: regex },
        { nameFr: regex },
        { storyEn: regex },
        { storyAr: regex },
        { storyFr: regex },
        { slug: regex },
      ];

      // Variant labels ("red", "xl") used to be matched with `'variants.options.name*'` against
      // the embedded array. That array is gone, and an option or value label lives in its own
      // collection, so the ids are resolved first and added as one `_id` branch. Scoped to this
      // seller's store: without it, a label belonging to another store could pull this store's
      // products into the results.
      if (storeId) {
        const variantMatches = await this.variantsService.findProductIdsMatchingLabels(
          storeId,
          regex as { $regex: string; $options: string },
        );
        if (variantMatches.length > 0) orConditions.push({ _id: { $in: variantMatches } });
      }

      searchFilter = { $and: [filter, { $or: orConditions }] };
      sortOption = { createdAt: -1, _id: -1 };
    } else {
      const sortMapping: Record<string, any> = {
        price_asc: { price: 1, createdAt: -1, _id: -1 },
        price_desc: { price: -1, createdAt: -1, _id: -1 },
        newest: { createdAt: -1, _id: -1 },
        name: { nameEn: 1, createdAt: -1, _id: -1 },
      };

      searchFilter = { ...filter };
      sortOption = sortMapping[query.sortBy || 'newest'] || { createdAt: -1, _id: -1 };
    }

    const [total, items] = await Promise.all([
      this.productModel.countDocuments(searchFilter).exec(),
      this.productModel
        .find(searchFilter)
        .sort(sortOption)
        .skip(skip)
        .limit(limit)
        .populate('category', 'nameEn nameAr nameFr slug image isPublished')
        .populate('subCategory', 'nameEn nameAr nameFr slug isPublished categoryId')
        // Lean, for the same reason as findAll: `variantSummary` is computed and has no schema
        // path, and on a hydrated document assigning it is dropped by strict mode.
        .lean()
        .exec(),
    ]);

    // The seller listing is the main surface for variants, so it needs the same summary as
    // findAll: without it a product row shows no availability, no price range and no variant
    // count, and the seller cannot tell a stocked variant product from an out-of-stock one.
    await this.attachVariantSummaries(items as unknown as Array<Record<string, any>>);

    return {
      products: items as Product[],
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string): Promise<Product> {
    const product = await this.productModel
      .findById(id)
      .select('-vendorEmail -vendorId')
      .populate('category', 'nameEn nameAr nameFr slug image isPublished')
      .populate('subCategory', 'nameEn nameAr nameFr slug isPublished categoryId')
      .exec();
    if (!product) throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { id });

    // The detail response carries the full matrix rather than making the storefront issue a
    // second request for the page it renders first (§4.5). `toObject()` first: a lean
    // document has no `.get()`, and mixing the two is where a half-populated response
    // silently comes from. Every product is a variant product, so the matrix is always built.
    const plain = product.toObject();
    try {
      const matrix = await this.variantsService.getMatrix(
        id,
        product.storeId as Types.ObjectId,
      );
      // Only *active* variants and values reach the storefront — an inactive variant is
      // not buyable, and exposing it invites orders against stock that is not for sale.
      (plain as any).variantMatrix = {
        ...matrix,
        options: matrix.options.map((o) => ({
          ...o,
          values: o.values.filter((v) => v.isActive),
        })),
        variants: matrix.variants.filter((v) => v.isActive && !v.isDeleted),
      };
    } catch (err: any) {
      // A matrix failure must not take the product page down with it: the buyer can still
      // see the product, and the seller surfaces the error in the dashboard.
      this.logger.warn(`Failed to build variant matrix for product ${id}: ${err?.message}`);
    }
    return plain as Product;
  }

  async findBySlugId(slugId: string): Promise<Product> {
    const separatorIndex = slugId.lastIndexOf('--');
    if (separatorIndex === -1) throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { slugId });

    const slug = slugId.slice(0, separatorIndex);
    const idSuffix = slugId.slice(separatorIndex + 2);

    if (!/^[0-9a-f]{8}$/i.test(idSuffix)) {
      throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { slugId });
    }

    const product = await this.productModel
      .findOne({ slug })
      .select('-vendorEmail -vendorId')
      .populate('category', 'nameEn nameAr nameFr slug image isPublished')
      .populate('subCategory', 'nameEn nameAr nameFr slug isPublished categoryId')
      .exec();

    if (!product) throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { slug });

    const productId = String(product._id);
    if (!productId.endsWith(idSuffix)) {
      throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { slugId });
    }

    return product;
  }

  async update(id: string, updateProductDto: UpdateProductDto, userEmail: string, userId?: string): Promise<Product> {
    const existing = await this.productModel.findById(id).exec();
    if (!existing) throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { id });
    await this.assertOwnership(existing, userId, userEmail, 'update');

    const updateData: Record<string, any> = {};

    if (updateProductDto.nameEn !== undefined || updateProductDto.nameAr !== undefined || updateProductDto.nameFr !== undefined) {
      const filled = fillLanguages(
        updateProductDto.nameEn ?? (existing as any).nameEn,
        updateProductDto.nameAr ?? (existing as any).nameAr,
        updateProductDto.nameFr ?? (existing as any).nameFr,
      );

      if (!filled.nameEn && !filled.nameAr && !filled.nameFr) {
        throw new AppException(AppErrorCode.VALIDATION_AT_LEAST_ONE_LANGUAGE);
      }

      updateData.nameEn = filled.nameEn;
      updateData.nameAr = filled.nameAr;
      updateData.nameFr = filled.nameFr;

      const baseName = firstNonEmpty(updateProductDto.nameEn, updateProductDto.nameAr, updateProductDto.nameFr);
      if (baseName) {
        let slug = this.slugify(baseName);
        const slugConflict = await this.productModel.findOne({
          slug,
          _id: { $ne: id },
        }).exec();
        if (slugConflict) {
          slug = `${slug}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        }
        updateData.slug = slug;
      }
    }

    for (const key of Object.keys(updateProductDto) as (keyof UpdateProductDto)[]) {
      if (key === 'nameEn' || key === 'nameAr' || key === 'nameFr') continue;
      if (updateProductDto[key] !== undefined) {
        (updateData as Record<string, unknown>)[key] = updateProductDto[key] as unknown;
      }
    }

    // Validate that updated images are not all empty
    if (updateProductDto.image !== undefined || updateProductDto.images !== undefined) {
      const hasImage = typeof updateData.image === 'string' && updateData.image.trim().length > 0;
      const hasImages = Array.isArray(updateData.images) && updateData.images.length > 0;
      if (!hasImage && !hasImages) {
        throw new AppException(AppErrorCode.VALIDATION_AT_LEAST_ONE_IMAGE);
      }
    }

    if (updateData.originalPrice !== undefined && updateData.price === undefined) {
      updateData.price = updateData.originalPrice;
    }

    // Both fields may be absent from a partial PATCH, so compare the effective pair:
    // the incoming value when present, otherwise the value already on the document.
    this.assertPriceNotAboveOriginal(
      updateData.price ?? (existing as any).price,
      updateData.originalPrice ?? (existing as any).originalPrice,
    );

    // The product's store is immutable here (never accepted from the DTO), so validate the
    // effective pair against the stored owner. Changing only the category also validates the
    // stored subcategory against it, which is exactly the parent-mismatch case.
    if (existing.storeId) {
      const effectiveCategory =
        (updateData.category as string | undefined) ?? (existing as any).category;
      const effectiveSubCategory =
        updateData.subCategory !== undefined
          ? (updateData.subCategory as string | undefined)
          : (existing as any).subCategory;
      await this.assertProductCategories(
        existing.storeId,
        effectiveCategory,
        effectiveSubCategory,
      );
    }

    const updated = await this.productModel
      .findByIdAndUpdate(id, updateData, { new: true })
      .populate('category', 'nameEn nameAr nameFr slug image isPublished')
      .populate('subCategory', 'nameEn nameAr nameFr slug isPublished categoryId')
      .exec();

    if (!updated) throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { id });
    this.cacheService.clear('categories:');

    // A gallery URL that left the product can no longer back an option-value link. Clear those
    // links best-effort: the product save has already committed, so failing here must not undo it.
    const oldGallery = new Set(
      [(existing as any).image, ...(((existing as any).images as string[]) ?? [])]
        .map((url) => (typeof url === 'string' ? url.trim() : ''))
        .filter(Boolean),
    );
    const newGallery = new Set(
      [(updated as any).image, ...(((updated as any).images as string[]) ?? [])]
        .map((url) => (typeof url === 'string' ? url.trim() : ''))
        .filter(Boolean),
    );
    const removedGalleryUrls = [...oldGallery].filter((url) => !newGallery.has(url));
    const galleryStoreId = (updated as any).storeId ?? (existing as any).storeId;
    if (removedGalleryUrls.length > 0 && galleryStoreId) {
      try {
        await this.variantsService.clearImageAssignments(
          String(updated._id),
          galleryStoreId as Types.ObjectId,
          removedGalleryUrls,
        );
      } catch (err) {
        this.logger.warn(
          `Failed to clear option-value image links for product ${updated._id}: ${String(
            (err as Error)?.message ?? err,
          )}`,
        );
      }
    }

    // Clean up old images from R2 when replaced
    const oldImageKey = this.uploadService.extractKeyFromUrl(existing.image);
    const newImageKey = updateProductDto.image ? this.uploadService.extractKeyFromUrl(updateProductDto.image) : null;
    if (oldImageKey && newImageKey && oldImageKey !== newImageKey) {
      await this.uploadService.deleteProductImages(oldImageKey).catch((err) => {
        this.logger.warn(`Failed to delete old image ${oldImageKey}: ${err.message}`);
      });
    }

    // H12: price and visibility changes are the two product edits that move money, so they are
    // audited. The entry records the before/after values only for the fields that changed.
    const auditedFields: Record<string, unknown> = {};
    if (updateProductDto.price !== undefined && updateProductDto.price !== (existing as any).price) {
      auditedFields.price = { from: (existing as any).price, to: updateProductDto.price };
    }
    if (
      updateProductDto.originalPrice !== undefined &&
      updateProductDto.originalPrice !== (existing as any).originalPrice
    ) {
      auditedFields.originalPrice = {
        from: (existing as any).originalPrice,
        to: updateProductDto.originalPrice,
      };
    }
    if (updateProductDto.published !== undefined && updateProductDto.published !== (existing as any).published) {
      auditedFields.published = { from: (existing as any).published, to: updateProductDto.published };
    }
    if (Object.keys(auditedFields).length > 0) {
      await this.auditService.record({
        action: AuditAction.PRODUCT_UPDATE,
        actorId: userId ?? null,
        actorEmail: userEmail,
        storeId: existing.storeId ? String(existing.storeId) : null,
        resourceType: ResourceType.PRODUCT,
        resourceId: String(updated._id),
        details: { operation: 'product_update', changes: auditedFields },
      });
    }

    if (updateProductDto.images !== undefined) {
      const oldKeys = (existing.images || [])
        .map((u) => this.uploadService.extractKeyFromUrl(u))
        .filter(Boolean) as string[];
      const newKeys = new Set(
        (updateProductDto.images || [])
          .map((u) => this.uploadService.extractKeyFromUrl(u))
          .filter(Boolean),
      );
      const removed = oldKeys.filter((k) => !newKeys.has(k));
      if (removed.length > 0) {
        await this.uploadService.deleteFiles(removed).catch((err) => {
          this.logger.warn(`Failed to delete old images: ${err.message}`);
        });
      }
    }

    return updated;
  }

  async getMaxPrice(): Promise<number> {
    const result = await this.productModel
      .findOne({ published: true })
      .sort({ price: -1 })
      .select('price')
      .exec();
    return result?.price ?? 4500;
  }

  async findAllRaw(filter: Record<string, any>, sort?: Record<string, any>): Promise<Product[]> {
    const safeFilter: Record<string, any> = { published: true, ...filter };
    return this.productModel
      .find(safeFilter)
      .populate('category', 'nameEn nameAr nameFr slug image isPublished')
      .populate('subCategory', 'nameEn nameAr nameFr slug isPublished categoryId')
      .sort(sort || { createdAt: -1 })
      .limit(50)
      .exec();
  }

  async remove(id: string, userEmail: string, userId?: string): Promise<{ id: string; deleted: true }> {
    const existing = await this.productModel.findById(id).exec();
    if (!existing) throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { id });
    await this.assertOwnership(existing, userId, userEmail, 'delete');

    // HI-3: order lines are allowed to carry only `variantId`, so the product's own id is
    // not enough to prove absence from order history. Count lines that mention the product
    // OR any of its variants (tombstones included - an old order may reference a deleted
    // variant). The store scope is resolved here so the lookup stays tenant-safe.
    const storeId = existing.storeId ? String(existing.storeId) : null;
    const variantLineFilters: Array<Record<string, unknown>> = [];
    if (storeId) {
      const variantIds = await this.variantsService.listVariantIdsForProduct(id, storeId);
      if (variantIds.length > 0) {
        variantLineFilters.push({ 'items.variantId': { $in: variantIds } });
      }
    }

    const orderCount = await this.orderModel
      .countDocuments({ $or: [{ 'items.productId': id }, ...variantLineFilters] })
      .exec();
    if (orderCount > 0) {
      throw new AppException(AppErrorCode.PRODUCT_CANNOT_DELETE_HAS_ORDERS, { id, count: orderCount });
    }

    // Phase 4 (roadmap 4.10). Not redundant with the hardened order count above: it also
    // refuses while any variant still holds an active reservation (spec §7.5), which a
    // count can never see. Every product is a variant product, so the cascade always runs
    // (the simple-mode branch disappeared with `hasVariants`).
    if (!storeId) {
      // A product without store scope has no matrix that can be attributed to a tenant and
      // must not be deleted piecemeal.
      throw new AppException(AppErrorCode.PRODUCT_NOT_IN_STORE, {
        id,
        reason: 'product_has_no_store_scope',
      });
    }

    const cascade = await this.variantsService.cascadeSoftDeleteForProduct(id, storeId);
    this.logger.log(
      `Deleted product ${id}: soft-deleted ${cascade.variants} variant(s), ` +
        `deactivated ${cascade.values} value(s), removed ${cascade.joins} join row(s)`,
    );

    // Filter is scoped by `_id` plus the already-verified owner, so this cannot delete
    // another vendor's product even under a concurrent write.
    const result = await this.productModel.findOneAndDelete({
      _id: id,
      ...(existing.storeId
        ? { storeId: existing.storeId }
        : { vendorEmail: existing.vendorEmail }),
    }).exec();
    if (!result) {
      throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { id });
    }

    this.cacheService.clear('categories:');
    await this.storesService.incrementProductCount(result.vendorEmail, -1);

    // Clean up images from R2
    const imageKeys = [result.image, ...(result.images || [])]
      .map((u) => this.uploadService.extractKeyFromUrl(u))
      .filter(Boolean) as string[];
    if (imageKeys.length > 0) {
      const allKeys = imageKeys.flatMap((k) => {
        const base = k.replace(/\.webp$/, '');
        return [k, `${base}-thumb.webp`, `${base}-medium.webp`, `${base}-large.webp`];
      });
      await this.uploadService.deleteFiles(allKeys).catch((err) => {
        this.logger.warn(`Failed to delete product images: ${err.message}`);
      });
    }

    return { id: String(result._id), deleted: true };
  }

  async duplicate(id: string, userEmail: string, userId?: string): Promise<Product> {
    const original = await this.productModel.findById(id).exec();
    if (!original) throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { id });
    await this.assertOwnership(original, userId, userEmail, 'duplicate');

    // The copy inherits the original's category pair, so the pair must still be valid for
    // the store (a category could have been removed since the original was saved).
    if (original.storeId) {
      await this.assertProductCategories(
        original.storeId,
        original.category,
        original.subCategory,
      );
    }

    const baseName = firstNonEmpty(original.nameEn, original.nameAr, original.nameFr);
    let slug = `${this.slugify(baseName)}-copy`;
    const existing = await this.productModel.findOne({ slug }).exec();
    if (existing) {
      slug = `${slug}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    }

    const duplicateDoc = new this.productModel({
      vendorEmail: original.vendorEmail,
      vendorId: original.vendorId,
      ...(original.storeId ? { storeId: original.storeId } : {}),
      nameEn: original.nameEn,
      nameAr: original.nameAr,
      nameFr: original.nameFr,
      slug,
      storyEn: original.storyEn,
      storyAr: original.storyAr,
      storyFr: original.storyFr,
      category: original.category,
      subCategory: original.subCategory,
      originalPrice: original.originalPrice,
      price: original.price,
      weight: original.weight,
      image: original.image,
      images: original.images,
      published: false,
    });

    this.cacheService.clear('categories:');
    const saved = await duplicateDoc.save();

    // The option/value/variant structure is cloned onto the duplicate, but every quantity
    // opens at zero (see `duplicateMatrix`): the copy must not claim stock it was never
    // given. `stock`, `hasVariants` and the legacy embedded `variants` array are not copied
    // at all — the fields no longer exist.
    const matrixStoreId = original.storeId ? (original.storeId as Types.ObjectId) : null;
    if (matrixStoreId) {
      try {
        await this.variantsService.duplicateMatrix(
          id,
          String(saved._id),
          matrixStoreId,
          userId && Types.ObjectId.isValid(userId) ? new Types.ObjectId(userId) : null,
        );
      } catch (err) {
        this.logger.warn(
          `Matrix duplication failed for product ${saved._id}; rolling back. ${String(
            (err as Error)?.message ?? err,
          )}`,
        );
        await this.productModel.deleteOne({ _id: saved._id }).exec();
        this.storesService.incrementProductCount(original.vendorEmail, -1);
        throw err;
      }
    }

    return saved;
  }
}
