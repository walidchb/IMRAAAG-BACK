import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Store, StoreDocument } from './schemas/store.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { Category, CategoryDocument } from '../categories/schemas/category.schema';
import {
  SubCategory,
  SubCategoryDocument,
} from '../categories/schemas/sub-category.schema';
import { ensureDefaultCategoriesForStore } from '../categories/default-categories';
import { CreateStoreDto } from './dto/create-store.dto';
import { UpdateStoreDto } from './dto/update-store.dto';
import { StoreStatus } from './schemas/store-status.enum';
import { UploadService } from '../upload/upload.service';

export interface CursorDto {
  createdAt: string;
  _id: string;
}

export interface CursorPaginatedStoresResult {
  stores: Store[];
  nextCursor: CursorDto | null;
  hasMore: boolean;
}

@Injectable()
export class StoresService {
  private static readonly STORE_ID_CACHE_TTL_MS = 60_000;
  private readonly storeIdByEmailCache = new Map<string, { id: Types.ObjectId | null; at: number }>();
  private readonly logger = new Logger(StoresService.name);
  constructor(
    @InjectModel(Store.name) private storeModel: Model<StoreDocument>,
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    @InjectModel(Category.name) private categoryModel: Model<CategoryDocument>,
    @InjectModel(SubCategory.name) private subCategoryModel: Model<SubCategoryDocument>,
    private readonly uploadService: UploadService,
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
      slug = `store-${Date.now()}`;
    }
    return slug;
  }

  /**
   * `vendorId` is passed explicitly by the controller from the authenticated session -
   * it is never read from the request body, so a caller cannot claim another vendor's
   * store. Omitting it creates an unlinked store (admin tooling), which no vendor-scoped
   * endpoint can resolve.
   */
  async create(createStoreDto: CreateStoreDto, vendorId?: string): Promise<StoreDocument> {
    const vendorEmail = createStoreDto.vendorEmail?.toLowerCase();
    if (!vendorEmail) {
      throw new AppException(AppErrorCode.STORE_VENDOR_EMAIL_REQUIRED);
    }

    if (vendorId !== undefined && !Types.ObjectId.isValid(vendorId)) {
      throw new AppException(AppErrorCode.VALIDATION_INVALID_ID, { field: 'vendorId' });
    }

    const existingVendor = await this.storeModel.findOne({ vendorEmail }).exec();
    if (existingVendor) {
      throw new AppException(AppErrorCode.STORE_ALREADY_EXISTS);
    }

    // A vendor owns at most one store. Checked up front so the failure is a clear 409
    // rather than a duplicate-key E11000 from the `vendorId` unique index.
    const vendorIdFilter = vendorId ? this.vendorIdFilter(vendorId) : null;
    if (vendorIdFilter) {
      const existingByVendorId = await this.storeModel.findOne(vendorIdFilter).exec();
      if (existingByVendorId) {
        throw new AppException(AppErrorCode.STORE_ALREADY_EXISTS);
      }
    }

    let storeSlug = createStoreDto.storeSlug || this.slugify(createStoreDto.storeName);
    const existingSlug = await this.storeModel.findOne({ storeSlug }).exec();
    if (existingSlug) {
      storeSlug = `${storeSlug}-${Date.now()}`;
    }
    const created = new this.storeModel({
      ...createStoreDto,
      vendorEmail,
      storeSlug,
      // Cast explicitly rather than relying on Mongoose: a string here is exactly the
      // defect `vendorIdFilter()` has to tolerate, so do not create new instances of it.
      ...(vendorId ? { vendorId: new Types.ObjectId(vendorId) } : {}),
    });

    const saved = await created.save();
    this.storeIdByEmailCache.set(vendorEmail, { id: saved._id, at: Date.now() });

    // Every store owns a General/General category tree from the moment it exists. A failure
    // here must not leave a store with no taxonomy, and on the signup path it must roll the
    // user back with the store - so delete the just-created store and rethrow.
    try {
      await ensureDefaultCategoriesForStore(this.categoryModel, this.subCategoryModel, saved._id);
    } catch (err) {
      this.logger.error(
        `Default categories failed for store ${saved._id}; rolling the store back. ${String(
          (err as Error)?.message ?? err,
        )}`,
      );
      // A half-created taxonomy would be orphaned by the store deletion, so remove it with
      // the store. Nothing public ever referenced this store yet.
      await this.subCategoryModel
        .deleteMany({ storeId: saved._id })
        .exec()
        .catch(() => undefined);
      await this.categoryModel
        .deleteMany({ storeId: saved._id })
        .exec()
        .catch(() => undefined);
      await this.storeModel.findByIdAndDelete(saved._id).exec().catch(() => undefined);
      this.storeIdByEmailCache.delete(vendorEmail);
      throw err;
    }

    return saved;
  }

  async findAll(query: {
    search?: string;
    limit?: number;
    cursor?: string;
  }): Promise<CursorPaginatedStoresResult> {
    const filter: Record<string, any> = { status: StoreStatus.ACTIVE };

    const limit = query.limit || 10;

    let cursorObj: CursorDto | null = null;
    if (query.cursor) {
      try { cursorObj = JSON.parse(query.cursor); } catch {}
    }

    let searchFilter: Record<string, any>;

    if (query.search) {
      const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = { $regex: escaped, $options: 'i' };

      const orConditions = [
        { storeName: regex },
        { storeSlug: regex },
        { description: regex },
        { tagline: regex },
        { vendorEmail: regex },
        { contactEmail: regex },
        { contactPhone: regex },
        { wilaya: regex },
      ];

      const andConditions: Record<string, any>[] = [filter, { $or: orConditions }];

      if (cursorObj && cursorObj.createdAt && cursorObj._id) {
        andConditions.push({
          $or: [
            { createdAt: { $lt: new Date(cursorObj.createdAt) } },
            { createdAt: new Date(cursorObj.createdAt), _id: { $lt: new Types.ObjectId(cursorObj._id) } },
          ],
        });
      }

      searchFilter = { $and: andConditions };
    } else {
      searchFilter = { ...filter };

      if (cursorObj && cursorObj.createdAt && cursorObj._id) {
        searchFilter.$or = [
          { createdAt: { $lt: new Date(cursorObj.createdAt) } },
          { createdAt: new Date(cursorObj.createdAt), _id: { $lt: new Types.ObjectId(cursorObj._id) } },
        ];
      }
    }

    const items = await this.storeModel
      .find(searchFilter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .exec();

    const hasMore = items.length > limit;
    if (hasMore) items.pop();

    await this.attachPublishedProductCounts(items);

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

    return { stores: items as Store[], nextCursor, hasMore };
  }

  async findOne(id: string, opts?: { skipStatusCheck?: boolean; includePublishedCount?: boolean }): Promise<Store> {
    const store = await this.storeModel.findById(id).exec();
    if (!store) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { id });
    if (!opts?.skipStatusCheck && store.status !== StoreStatus.ACTIVE) {
      throw new AppException(AppErrorCode.STORE_NOT_ACTIVE, { id });
    }
    if (opts?.includePublishedCount) await this.attachPublishedProductCounts([store]);
    return store;
  }

  async findBySlug(slug: string, opts?: { skipStatusCheck?: boolean; includePublishedCount?: boolean }): Promise<Store> {
    const store = await this.storeModel.findOne({ storeSlug: slug }).exec();
    if (!store) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { field: 'slug', value: slug });
    if (!opts?.skipStatusCheck && store.status !== StoreStatus.ACTIVE) {
      throw new AppException(AppErrorCode.STORE_NOT_ACTIVE, { slug });
    }
    if (opts?.includePublishedCount) await this.attachPublishedProductCounts([store]);
    return store;
  }

  async findByVendor(vendorId: string, opts?: { skipStatusCheck?: boolean; includePublishedCount?: boolean }): Promise<Store> {
    const store = await this.storeModel.findOne({ vendorId }).exec();
    if (!store) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { field: 'vendorId', value: vendorId });
    if (!opts?.skipStatusCheck && store.status !== StoreStatus.ACTIVE) {
      throw new AppException(AppErrorCode.STORE_NOT_ACTIVE, { vendorId });
    }
    if (opts?.includePublishedCount) await this.attachPublishedProductCounts([store]);
    return store;
  }

  async findByEmail(email: string, opts?: { skipStatusCheck?: boolean; includePublishedCount?: boolean }): Promise<Store> {
    const store = await this.storeModel.findOne({ vendorEmail: email.toLowerCase() }).exec();
    if (!store) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { field: 'email', value: email });
    if (!opts?.skipStatusCheck && store.status !== StoreStatus.ACTIVE) {
      throw new AppException(AppErrorCode.STORE_NOT_ACTIVE, { email });
    }
    if (opts?.includePublishedCount) await this.attachPublishedProductCounts([store]);
    return store;
  }

  /**
   * Replaces the denormalised `totalProducts` counter with a live count of the products
   * the storefront can actually list (`published: true`). The counter is incremented on
   * product creation (including drafts), is not touched by publish/unpublish or product
   * duplication, and can therefore drift far below the real catalogue size. Public store
   * reads must not trust it.
   *
   * One aggregation for a whole store page, never one query per store.
   */
  private async attachPublishedProductCounts(stores: any[]): Promise<void> {
    const ids = stores
      .map((store) => store?._id)
      .filter((id) => !!id && Types.ObjectId.isValid(String(id)))
      .map((id) => new Types.ObjectId(String(id)));
    if (ids.length === 0) return;

    const rows = await this.productModel
      .aggregate<{ _id: Types.ObjectId; count: number }>([
        { $match: { storeId: { $in: ids }, published: true } },
        { $group: { _id: '$storeId', count: { $sum: 1 } } },
      ])
      .exec();

    const counts = new Map<string, number>(
      rows.map((row) => [String(row._id), row.count] as [string, number]),
    );
    for (const store of stores) {
      if (store?._id) store.totalProducts = counts.get(String(store._id)) ?? 0;
    }
  }

  /**
   * Filter that matches a store by its owning vendor user.
   *
   * `Store.vendorId` is declared as an ObjectId, and Mongoose casts on every write it
   * performs, so new documents are stored as BSON ObjectId. Some rows however predate
   * that, or were written by a raw-driver script (`db.collection().updateOne()`), which
   * bypasses Mongoose casting and leaves the value as a BSON **string**.
   *
   * MongoDB compares by BSON type, so `findOne({ vendorId: ObjectId(id) })` silently
   * misses a row holding the identical 24 hex characters as a string. That is not
   * hypothetical: it 404'd a real vendor's tracking settings. Both branches below sit
   * on the same indexed field, so this stays a single index scan.
   *
   * See `scripts/migrate-store-vendorid-type.js` for the one-time data repair, and
   * `PLAN_STOREFRONT.md` for the backfill gate. The fallback is kept deliberately so a
   * future bad write degrades to "works" instead of "vendor locked out of their own
   * settings".
   */
  private vendorIdFilter(vendorId: string): Record<string, unknown> | null {
    if (!vendorId || !Types.ObjectId.isValid(vendorId)) return null;
    return { vendorId: { $in: [new Types.ObjectId(vendorId), vendorId] } };
  }

  /**
   * Resolves the store that owns a given vendor user.
   * Used by the storeId migration to derive `storeId` from an authenticated request
   * instead of from the vendor's mutable email address.
   */
  async findByVendorIdOrThrow(
    vendorId: string,
    opts?: { skipStatusCheck?: boolean },
  ): Promise<StoreDocument> {
    const filter = this.vendorIdFilter(vendorId);
    const store = filter
      ? await this.storeModel.findOne(filter).exec()
      : null;
    if (!store) {
      throw new AppException(AppErrorCode.STORE_NOT_FOUND, { field: 'vendorId', value: vendorId });
    }
    if (!opts?.skipStatusCheck && store.status !== StoreStatus.ACTIVE) {
      throw new AppException(AppErrorCode.STORE_NOT_ACTIVE, { vendorId });
    }
    return store;
  }

  /** Non-throwing variant. Returns null when the vendor has no store yet. */
  async findByVendorId(
    vendorId: string,
  ): Promise<StoreDocument | null> {
    const filter = this.vendorIdFilter(vendorId);
    if (!filter) return null;
    return this.storeModel.findOne(filter).exec();
  }

  /**
   * Resolves a storeId from a vendor email. Used to backfill `storeId` on write paths and
   * to build storeId-preferring read filters.
   *
   * Results are memoised for 60s: this sits on hot read paths (delivery fees, tracking
   * pixels), and the store↔email mapping changes only when a vendor edits their store.
   */
  async resolveStoreIdByEmail(email: string): Promise<Types.ObjectId | null> {
    if (!email) return null;
    const key = email.toLowerCase();
    const hit = this.storeIdByEmailCache.get(key);
    if (hit && Date.now() - hit.at < StoresService.STORE_ID_CACHE_TTL_MS) {
      return hit.id;
    }
    const store = await this.storeModel
      .findOne({ vendorEmail: key })
      .select('_id')
      .lean()
      .exec();
    const id = store ? (store._id as Types.ObjectId) : null;
    this.storeIdByEmailCache.set(key, { id, at: Date.now() });
    return id;
  }

  async update(id: string, updateStoreDto: UpdateStoreDto): Promise<Store> {
    const existing = await this.storeModel.findById(id).exec();
    if (!existing) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { id });

    const updateData: Record<string, any> = {};

    if (updateStoreDto.storeName !== undefined) updateData.storeName = updateStoreDto.storeName;
    if (updateStoreDto.description !== undefined) updateData.description = updateStoreDto.description;
    if (updateStoreDto.contactEmail !== undefined) updateData.contactEmail = updateStoreDto.contactEmail;
    if (updateStoreDto.contactPhone !== undefined) updateData.contactPhone = updateStoreDto.contactPhone;
    if (updateStoreDto.contactPhones !== undefined) updateData.contactPhones = updateStoreDto.contactPhones;
    if (updateStoreDto.commune !== undefined) updateData.commune = updateStoreDto.commune;
    if (updateStoreDto.socialMedia !== undefined) updateData.socialMedia = updateStoreDto.socialMedia;
    if (updateStoreDto.status !== undefined) updateData.status = updateStoreDto.status;
    if (updateStoreDto.storeLogo !== undefined) updateData.storeLogo = updateStoreDto.storeLogo;
    if (updateStoreDto.coverImage !== undefined) updateData.coverImage = updateStoreDto.coverImage;
    if (updateStoreDto.wilaya !== undefined) updateData.wilaya = updateStoreDto.wilaya;
    if (updateStoreDto.categories !== undefined) updateData.categories = updateStoreDto.categories;
    if (updateStoreDto.tagline !== undefined) updateData.tagline = updateStoreDto.tagline;
    if (updateStoreDto.inventoryEnabled !== undefined) {
      updateData.inventoryEnabled = updateStoreDto.inventoryEnabled;
    }

    if (updateStoreDto.storeName) {
      let storeSlug = this.slugify(updateStoreDto.storeName);
      const slugConflict = await this.storeModel.findOne({
        storeSlug,
        _id: { $ne: id },
      }).exec();
      if (slugConflict) {
        storeSlug = `${storeSlug}-${Date.now()}`;
      }
      updateData.storeSlug = storeSlug;
    }

    const updated = await this.storeModel
      .findByIdAndUpdate(id, updateData, { returnDocument: 'after' })
      .exec();

    if (!updated) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { id });

    // Clean up old images from R2 when replaced
    if (updateStoreDto.storeLogo !== undefined && existing.storeLogo && existing.storeLogo !== updateStoreDto.storeLogo) {
      const oldKey = this.uploadService.extractKeyFromUrl(existing.storeLogo);
      if (oldKey) {
        await this.uploadService.deleteFile(oldKey).catch((err) =>
          this.logger.warn(`Failed to delete old store logo: ${err.message}`),
        );
      }
    }
    if (updateStoreDto.coverImage !== undefined && existing.coverImage && existing.coverImage !== updateStoreDto.coverImage) {
      const oldKey = this.uploadService.extractKeyFromUrl(existing.coverImage);
      if (oldKey) {
        await this.uploadService.deleteFile(oldKey).catch((err) =>
          this.logger.warn(`Failed to delete old store cover: ${err.message}`),
        );
      }
    }

    return updated;
  }

  async toggleStatus(id: string): Promise<Store> {
    const store = await this.storeModel.findById(id).exec();
    if (!store) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { id });

    const newStatus = store.status === StoreStatus.ACTIVE ? StoreStatus.PAUSED : StoreStatus.ACTIVE;
    const updated = await this.storeModel.findByIdAndUpdate(
      id,
      { status: newStatus },
      { returnDocument: 'after' }
    ).exec();

    if (!updated) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { id });
    return updated;
  }

  async findAllRaw(filter: Record<string, any>): Promise<Store[]> {
    return this.storeModel.find(filter).sort({ createdAt: -1 }).limit(50).exec();
  }

  /**
   * Public search results (H2). A storefront listing needs the shop's public identity only:
   * `vendorEmail` (enumerable, and the key the removed public carrier-config route used),
   * `vendorId` (an internal user ObjectId) and the contact fields are deliberately projected
   * out. The public store page (`GET /stores/:id`) remains the place that shows contact
   * details for a store the shopper is actually looking at.
   */
  async findAllRawPublic(filter: Record<string, any>): Promise<Store[]> {
    return this.storeModel
      .find(filter)
      .select(
        '_id storeName storeSlug description storeLogo coverImage tagline wilaya commune categories socialMedia status totalProducts totalOrders createdAt',
      )
      .sort({ createdAt: -1 })
      .limit(50)
      .exec();
  }

  async incrementProductCount(vendorEmail: string, delta = 1): Promise<void> {
    await this.storeModel.updateOne(
      { vendorEmail: vendorEmail.toLowerCase() },
      { $inc: { totalProducts: delta } },
    ).exec();
  }

  async incrementOrderCount(vendorEmail: string, delta = 1): Promise<void> {
    await this.storeModel.updateOne(
      { vendorEmail: vendorEmail.toLowerCase() },
      { $inc: { totalOrders: delta } },
    ).exec();
  }

  async remove(id: string): Promise<void> {
    const result = await this.storeModel.findByIdAndDelete(id).exec();
    if (!result) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { id });

    // The taxonomy belongs to the store. Soft-delete the whole tree so no orphan
    // category/subcategory can outlive (or later be attached to) a deleted store.
    const storeId = new Types.ObjectId(String(result._id));
    const now = new Date();
    const categories = await this.categoryModel
      .find({ storeId, isDeleted: false })
      .select('_id image')
      .lean()
      .exec();
    if (categories.length > 0) {
      await this.subCategoryModel
        .updateMany(
          { storeId, isDeleted: false },
          { $set: { isDeleted: true, deletedAt: now } },
        )
        .exec();
      await this.categoryModel
        .updateMany(
          { storeId, isDeleted: false },
          { $set: { isDeleted: true, deletedAt: now } },
        )
        .exec();
      const imageKeys = categories
        .map((category) => this.uploadService.extractKeyFromUrl(category.image ?? ''))
        .filter((key): key is string => !!key && key.startsWith(`store/${String(storeId)}/categories/`));
      if (imageKeys.length > 0) {
        await this.uploadService.deleteFiles(imageKeys).catch((err) => {
          this.logger.warn(`Failed to delete category images: ${err.message}`);
        });
      }
    }

    // Clean up store images from R2
    const imageKeys = [result.storeLogo, result.coverImage]
      .map((u) => this.uploadService.extractKeyFromUrl(u))
      .filter(Boolean) as string[];
    if (imageKeys.length > 0) {
      await this.uploadService.deleteFiles(imageKeys).catch((err) => {
        this.logger.warn(`Failed to delete store images: ${err.message}`);
      });
    }
  }
}
