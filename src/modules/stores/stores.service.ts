import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Store, StoreDocument } from './schemas/store.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { Category, CategoryDocument } from '../categories/schemas/category.schema';
import { NOT_ARCHIVED_PRODUCT_FILTER } from '../../common/constants/product.const';
import {
  SubCategory,
  SubCategoryDocument,
} from '../categories/schemas/sub-category.schema';
import { ensureDefaultCategoriesForStore } from '../categories/default-categories';
import { CreateStoreDto } from './dto/create-store.dto';
import { UpdateStoreDto } from './dto/update-store.dto';
import {
  StoreAdminStatus,
  StoreOwnerStatus,
  StoreStatus,
} from './schemas/store-status.enum';
import {
  availableStoreFilter,
  evaluateStoreAvailability,
  resolveAdminStatus,
  resolveOwnerStatus,
  StoreAvailabilitySource,
} from './store-availability';
import { UploadService } from '../upload/upload.service';
import { StoreMember, StoreMemberDocument } from '../team/schemas/store-member.schema';
import { StoreMemberStatus, StoreRole } from '../../common/constants/store-roles.enum';
import { permissionsForRole } from '../../common/constants/store-permissions.const';
import { isReservedStoreSubdomain } from '../../common/constants/store-subdomain.const';
import {
  normalizeSubdomain,
  STORE_SUBDOMAIN_MAX_LENGTH,
} from './store-subdomain.util';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

export interface SubdomainAvailability {
  value: string;
  available: boolean;
  reason?: 'invalid' | 'reserved' | 'taken';
}

export interface StoreAdminStatusActor {
  id: string;
  email: string;
}

export interface SetStoreAdminStatusInput {
  adminStatus: StoreAdminStatus;
  reason?: string | null;
  actor: StoreAdminStatusActor;
}

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
    @InjectModel(StoreMember.name) private storeMemberModel: Model<StoreMemberDocument>,
    private readonly uploadService: UploadService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly configService: ConfigService,
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

    // An explicit subdomain (dashboard/admin create form) is validated and pre-checked so a
    // conflict is a real error; otherwise one is derived deterministically from the slug.
    // The DTO field is never copied through unvalidated - `subdomain` below always wins.
    const rawSubdomain =
      typeof createStoreDto.subdomain === 'string' ? createStoreDto.subdomain.trim() : '';
    const explicitSubdomain = rawSubdomain ? this.assertSubdomainAllowed(rawSubdomain) : null;
    if (explicitSubdomain) {
      const taken = await this.storeModel.exists({ subdomain: explicitSubdomain }).exec();
      if (taken) {
        throw new AppException(AppErrorCode.STORE_SUBDOMAIN_TAKEN, {
          subdomain: explicitSubdomain,
        });
      }
    }
    const assignedSubdomain = explicitSubdomain ?? (await this.suggestSubdomain(storeSlug));

    const created = new this.storeModel({
      ...createStoreDto,
      vendorEmail,
      storeSlug,
      subdomain: assignedSubdomain,
      ownerStatus: StoreOwnerStatus.ENABLED,
      adminStatus: StoreAdminStatus.ACTIVE,
      status: StoreStatus.ACTIVE,
      // Cast explicitly rather than relying on Mongoose: a string here is exactly the
      // defect `vendorIdFilter()` has to tolerate, so do not create new instances of it.
      ...(vendorId ? { vendorId: new Types.ObjectId(vendorId) } : {}),
    });

    let saved: StoreDocument;
    try {
      saved = await created.save();
    } catch (err) {
      // A concurrent create can win the index race. On the auto path retry once with a fresh
      // suggestion; on an explicit request tell the caller the value is taken.
      if (this.isDuplicateSubdomainKey(err)) {
        if (explicitSubdomain) {
          throw new AppException(AppErrorCode.STORE_SUBDOMAIN_TAKEN, {
            subdomain: explicitSubdomain,
          });
        }
        created.set('subdomain', await this.suggestSubdomain(storeSlug));
        saved = await created.save();
      } else {
        throw err;
      }
    }
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

    // Keep the Owner-membership invariant true for every *new* store: the migration backfills
    // existing stores, and this seeds future ones. A failure here is logged, not fatal — the
    // Owner still resolves through `Store.vendorId`.
    try {
      await this.storeMemberModel
        .updateOne(
          { storeId: saved._id, userId: new Types.ObjectId(vendorId as string) },
          {
            $setOnInsert: {
              role: 'OWNER',
              permissionOverrides: [],
              status: StoreMemberStatus.ACTIVE,
              joinedAt: (saved as any).createdAt ?? new Date(),
            },
          },
          { upsert: true },
        )
        .exec();
    } catch (err) {
      this.logger.warn(
        `Failed to seed the Owner membership for store ${saved._id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Plans & Subscriptions: assign the configured default plan to a new store when the feature
    // is enabled. With enforcement on and no default plan, this throws; the store must not
    // survive without a usable subscription, so roll it back exactly like a taxonomy failure.
    const defaultPlanCode =
      this.configService.get<string>('subscriptions.defaultSignupPlanCode') || 'starter';
    try {
      await this.subscriptionsService.assignDefaultSignupPlan(String(saved._id), defaultPlanCode);
    } catch (err) {
      this.logger.error(
        `Default subscription failed for store ${saved._id}; rolling the store back. ${String(
          (err as Error)?.message ?? err,
        )}`,
      );
      await this.storeMemberModel.deleteMany({ storeId: saved._id }).exec().catch(() => undefined);
      await this.subCategoryModel.deleteMany({ storeId: saved._id }).exec().catch(() => undefined);
      await this.categoryModel.deleteMany({ storeId: saved._id }).exec().catch(() => undefined);
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
    const filter: Record<string, any> = availableStoreFilter();

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
    if (!opts?.skipStatusCheck) this.assertStoreAvailable(store, { id });
    if (opts?.includePublishedCount) await this.attachPublishedProductCounts([store]);
    return store;
  }

  async findBySlug(slug: string, opts?: { skipStatusCheck?: boolean; includePublishedCount?: boolean }): Promise<Store> {
    const store = await this.storeModel.findOne({ storeSlug: slug }).exec();
    if (!store) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { field: 'slug', value: slug });
    if (!opts?.skipStatusCheck) this.assertStoreAvailable(store, { slug });
    if (opts?.includePublishedCount) await this.attachPublishedProductCounts([store]);
    return store;
  }

  async findByVendor(vendorId: string, opts?: { skipStatusCheck?: boolean; includePublishedCount?: boolean }): Promise<Store> {
    const store = await this.storeModel.findOne({ vendorId }).exec();
    if (!store) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { field: 'vendorId', value: vendorId });
    if (!opts?.skipStatusCheck) this.assertStoreAvailable(store, { vendorId });
    if (opts?.includePublishedCount) await this.attachPublishedProductCounts([store]);
    return store;
  }

  async findByEmail(email: string, opts?: { skipStatusCheck?: boolean; includePublishedCount?: boolean }): Promise<Store> {
    const store = await this.storeModel.findOne({ vendorEmail: email.toLowerCase() }).exec();
    if (!store) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { field: 'email', value: email });
    if (!opts?.skipStatusCheck) this.assertStoreAvailable(store, { email });
    if (opts?.includePublishedCount) await this.attachPublishedProductCounts([store]);
    return store;
  }

  /** Normalize a candidate label, or `null` when it is not a valid store subdomain. */
  normalizeSubdomain(raw: string): string | null {
    return normalizeSubdomain(raw);
  }

  /**
   * Normalize + reject invalid/reserved labels. Used on every write path so a bad value can
   * never reach the database even if a caller bypasses the DTO.
   */
  assertSubdomainAllowed(raw: string): string {
    const value = normalizeSubdomain(raw);
    if (!value) {
      // Never echo the raw value back: it may contain arbitrary input.
      throw new AppException(AppErrorCode.STORE_SUBDOMAIN_INVALID);
    }
    if (isReservedStoreSubdomain(value)) {
      throw new AppException(AppErrorCode.STORE_SUBDOMAIN_RESERVED, { subdomain: value });
    }
    return value;
  }

  /**
   * Public availability check. Never reveals which (if any) store owns a taken value, and
   * answers `available: false` plus a reason rather than a 4xx so the UI can render every
   * state without treating it as a request failure.
   */
  async isSubdomainAvailable(raw: string): Promise<SubdomainAvailability> {
    const value = normalizeSubdomain(raw);
    if (!value) {
      return { value: typeof raw === 'string' ? raw.trim().toLowerCase() : '', available: false, reason: 'invalid' };
    }
    if (isReservedStoreSubdomain(value)) {
      return { value, available: false, reason: 'reserved' };
    }
    const taken = await this.storeModel.exists({ subdomain: value }).exec();
    return taken ? { value, available: false, reason: 'taken' } : { value, available: true };
  }

  /**
   * Deterministic suggestion derived from a seed (normally the store slug). Reserved or
   * invalid seeds fall back to `store`, and a taken value gets a `-2`, `-3`, ... suffix.
   * Bounded at 50 attempts; the final fallback is a timestamp-suffixed label so creation can
   * never dead-end.
   */
  async suggestSubdomain(seed: string): Promise<string> {
    let base = normalizeSubdomain(
      String(seed ?? '')
        .slice(0, STORE_SUBDOMAIN_MAX_LENGTH)
        .replace(/-+$/, ''),
    );
    if (!base || isReservedStoreSubdomain(base)) base = 'store';

    if (!(await this.storeModel.exists({ subdomain: base }).exec())) return base;

    for (let n = 2; n <= 50; n += 1) {
      const suffix = `-${n}`;
      const head = base.slice(0, STORE_SUBDOMAIN_MAX_LENGTH - suffix.length).replace(/-+$/, '');
      const candidate = normalizeSubdomain(`${head}${suffix}`);
      if (candidate && !(await this.storeModel.exists({ subdomain: candidate }).exec())) {
        return candidate;
      }
    }

    const stamp = (Date.now() % 1_000_000).toString(36);
    return `store-${stamp}`;
  }

  /**
   * Host-based public lookup. Invalid input, an unknown label and a store without a
   * subdomain are all `STORE_NOT_FOUND` (never a format hint); a non-active store mirrors
   * `findBySlug` with `STORE_NOT_ACTIVE`.
   */
  async findBySubdomain(
    rawSubdomain: string,
    opts?: { skipStatusCheck?: boolean; includePublishedCount?: boolean },
  ): Promise<Store> {
    const value = normalizeSubdomain(rawSubdomain);
    if (!value) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { field: 'subdomain' });
    const store = await this.storeModel.findOne({ subdomain: value }).exec();
    if (!store) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { field: 'subdomain' });
    if (!opts?.skipStatusCheck) this.assertStoreAvailable(store, { subdomain: value });
    if (opts?.includePublishedCount) await this.attachPublishedProductCounts([store]);
    return store;
  }

  /**
   * Dedicated update path for the storefront address. Deliberately not folded into
   * `update()`: a store rename must never move the public URL, and this path must not
   * recompute the slug or touch images/products.
   */
  async updateSubdomain(storeId: string, rawSubdomain: string): Promise<Store> {
    const existing = await this.storeModel.findById(storeId).exec();
    if (!existing) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { id: storeId });

    const value = this.assertSubdomainAllowed(rawSubdomain);
    if (existing.subdomain === value) return existing;

    const taken = await this.storeModel
      .exists({ subdomain: value, _id: { $ne: storeId } })
      .exec();
    if (taken) throw new AppException(AppErrorCode.STORE_SUBDOMAIN_TAKEN, { subdomain: value });

    let updated: Store | null;
    try {
      updated = await this.storeModel
        .findByIdAndUpdate(storeId, { $set: { subdomain: value } }, { returnDocument: 'after' })
        .exec();
    } catch (err) {
      // The pre-check loses to a concurrent write only here; surface the same 409.
      if (this.isDuplicateSubdomainKey(err)) {
        throw new AppException(AppErrorCode.STORE_SUBDOMAIN_TAKEN, { subdomain: value });
      }
      throw err;
    }

    if (!updated) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { id: storeId });
    return updated;
  }

  /** True when a Mongo duplicate-key error is on the `subdomain` index. */
  private isDuplicateSubdomainKey(err: unknown): boolean {
    const e = err as { code?: number; keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown> };
    return (
      e?.code === 11000 &&
      (!!e?.keyPattern?.subdomain || !!e?.keyValue?.subdomain)
    );
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
        { $match: { storeId: { $in: ids }, published: true, ...NOT_ARCHIVED_PRODUCT_FILTER } },
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
    if (!opts?.skipStatusCheck) this.assertStoreAvailable(store, { vendorId });
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
   * Resolves the store a user can act in, as **Owner or active employee**.
   *
   * This is the session-store lookup for every vendor-scoped endpoint after Team Management.
   * `findByVendorId*` stays strictly Owner-only (the Owner pointer is `Store.vendorId`); this
   * method is the one that honours a membership row.
   *
   * A deactivated membership never resolves a store. `findByMemberId` is the non-throwing
   * variant.
   */
  async findByMemberIdOrThrow(
    userId: string,
    opts?: { skipStatusCheck?: boolean },
  ): Promise<StoreDocument> {
    const store = await this.findByMemberId(userId);
    if (!store) {
      throw new AppException(AppErrorCode.STORE_NOT_FOUND, { field: 'userId', value: userId });
    }
    if (!opts?.skipStatusCheck) this.assertStoreAvailable(store, { userId });
    return store;
  }

  /** Non-throwing owner-or-active-member store lookup. Returns null when there is none. */
  async findByMemberId(userId: string): Promise<StoreDocument | null> {
    if (userId && Types.ObjectId.isValid(userId)) {
      const member = await this.storeMemberModel
        .findOne({
          userId: new Types.ObjectId(userId),
          status: StoreMemberStatus.ACTIVE,
        })
        .select('storeId')
        .lean()
        .exec();
      if (member?.storeId) {
        const store = await this.storeModel.findById(member.storeId).exec();
        if (store) return store;
      }
    }

    // Legacy owner without a membership row.
    return this.findByVendorId(userId);
  }

  /**
   * Resolves the caller's effective store permissions without the `TeamModule` graph.
   * Used by callers that must scope a non-static permission themselves (e.g. the upload
   * delete route, whose folder determines the capability). `StoreAccessService` remains the
   * primary source for route-level checks.
   */
  async resolvePermissionsForUser(
    userId: string,
  ): Promise<{ storeId: string | null; isOwner: boolean; permissions: string[] }> {
    if (userId && Types.ObjectId.isValid(userId)) {
      const member = await this.storeMemberModel
        .findOne({ userId: new Types.ObjectId(userId), status: StoreMemberStatus.ACTIVE })
        .lean()
        .exec();
      if (member) {
        return {
          storeId: String(member.storeId),
          isOwner: member.role === StoreRole.OWNER,
          permissions: permissionsForRole(member.role as StoreRole, member.permissionOverrides),
        };
      }
    }

    const store = await this.findByVendorId(userId);
    if (store) {
      return { storeId: String(store._id), isOwner: true, permissions: ['*'] };
    }
    return { storeId: null, isOwner: false, permissions: [] };
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
    if (updateStoreDto.streetAddress !== undefined) updateData.streetAddress = updateStoreDto.streetAddress;
    if (updateStoreDto.googleMapsUrl !== undefined) updateData.googleMapsUrl = updateStoreDto.googleMapsUrl;
    if (updateStoreDto.socialMedia !== undefined) updateData.socialMedia = updateStoreDto.socialMedia;
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

  /**
   * The owner's enable/disable switch.
   *
   * Only `ownerStatus` is written (together with the derived legacy `status` mirror). An
   * admin suspension is never touched, so an owner cannot re-enable a suspended store by
   * flipping this switch: `status` stays `Closed` and availability remains false.
   */
  async toggleOwnerStatus(id: string): Promise<Store> {
    return this.writeStatusAtomically(id, 'owner');
  }

  /**
   * The admin's suspend/reactivate action. Only admins reach this (through
   * `AdminStoresService`); the reason and actor metadata are retained on the store.
   */
  async setAdminStatus(
    id: string,
    input: SetStoreAdminStatusInput,
  ): Promise<Store> {
    const store = await this.storeModel.findById(id).exec();
    if (!store) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { id });

    const current = resolveAdminStatus(store as unknown as StoreAvailabilitySource);
    if (current === input.adminStatus) return store;

    const reason = input.reason?.trim() ? input.reason.trim() : null;
    return this.writeStatusAtomically(id, 'admin', {
      adminStatus: input.adminStatus,
      reason,
      actor: input.actor,
    });
  }

  /**
   * Atomically write one side of the two-status pair and recompute the legacy mirror from
   * the *stored* other side. The `$expr` predicate makes a concurrent owner/admin write
   * retry instead of silently overwriting the other party's decision.
   */
  private async writeStatusAtomically(
    id: string,
    side: 'owner' | 'admin',
    adminInput?: SetStoreAdminStatusInput,
  ): Promise<Store> {
    const ownerExpr = this.ownerStatusExpression();
    const adminExpr = this.adminStatusExpression();
    const now = new Date();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const store = await this.storeModel.findById(id).exec();
      if (!store) throw new AppException(AppErrorCode.STORE_NOT_FOUND, { id });

      if (side === 'owner') {
        const currentOwner = resolveOwnerStatus(
          store as unknown as StoreAvailabilitySource,
        );
        const nextOwner =
          currentOwner === StoreOwnerStatus.ENABLED
            ? StoreOwnerStatus.DISABLED
            : StoreOwnerStatus.ENABLED;

        const updated = await this.storeModel
          .findOneAndUpdate(
            { _id: id, $expr: { $eq: [ownerExpr, currentOwner] } },
            [
              {
                $set: {
                  ownerStatus: nextOwner,
                  adminStatus: adminExpr,
                  ownerStatusChangedAt: now,
                  status: this.storeStatusExpression({ $literal: nextOwner }, adminExpr),
                },
              },
            ] as any,
            { returnDocument: 'after', updatePipeline: true },
          )
          .exec();
        if (updated) return updated;
        continue;
      }

      const currentAdmin = resolveAdminStatus(
        store as unknown as StoreAvailabilitySource,
      );
      const adminStatus = adminInput?.adminStatus ?? currentAdmin;
      const actorId =
        adminInput?.actor.id && Types.ObjectId.isValid(adminInput.actor.id)
          ? new Types.ObjectId(adminInput.actor.id)
          : null;

      const updated = await this.storeModel
        .findOneAndUpdate(
          { _id: id, $expr: { $eq: [adminExpr, currentAdmin] } },
          [
            {
              $set: {
                ownerStatus: ownerExpr,
                adminStatus,
                adminStatusReason: adminInput?.reason ?? null,
                adminStatusChangedAt: now,
                adminStatusChangedBy: actorId,
                adminStatusChangedByEmail: adminInput?.actor.email ?? null,
                status: this.storeStatusExpression(ownerExpr, { $literal: adminStatus }),
              },
            },
          ] as any,
          { returnDocument: 'after', updatePipeline: true },
        )
        .exec();
      if (updated) return updated;
    }

    throw new AppException(AppErrorCode.STORE_STATUS_CONFLICT, { id });
  }

  private ownerStatusExpression(): Record<string, unknown> {
    return {
      $ifNull: [
        '$ownerStatus',
        {
          $cond: [
            { $in: ['$status', [StoreStatus.PAUSED, StoreStatus.CLOSED]] },
            StoreOwnerStatus.DISABLED,
            StoreOwnerStatus.ENABLED,
          ],
        },
      ],
    };
  }

  private adminStatusExpression(): Record<string, unknown> {
    return {
      $ifNull: [
        '$adminStatus',
        {
          $cond: [
            { $eq: ['$status', StoreStatus.CLOSED] },
            StoreAdminStatus.SUSPENDED,
            StoreAdminStatus.ACTIVE,
          ],
        },
      ],
    };
  }

  private storeStatusExpression(
    ownerExpr: unknown,
    adminExpr: unknown,
  ): Record<string, unknown> {
    return {
      $cond: [
        { $eq: [adminExpr, StoreAdminStatus.SUSPENDED] },
        StoreStatus.CLOSED,
        {
          $cond: [
            { $eq: [ownerExpr, StoreOwnerStatus.DISABLED] },
            StoreStatus.PAUSED,
            StoreStatus.ACTIVE,
          ],
        },
      ],
    };
  }

  /** Throws `STORE_NOT_ACTIVE` unless both independent statuses allow operation. */
  private assertStoreAvailable(
    store: StoreAvailabilitySource,
    params: Record<string, unknown>,
  ): void {
    const availability = evaluateStoreAvailability(store);
    if (!availability.available) {
      throw new AppException(AppErrorCode.STORE_NOT_ACTIVE, {
        ...params,
        reason: availability.blockedBy,
      });
    }
  }

  /**
   * Ids of every store that is currently available.
   *
   * Used to keep global marketplace reads (which have no single store scope) from listing
   * products belonging to a disabled/suspended store. Store-scoped reads should use
   * `findOne`/`findBySlug`/... which throw `STORE_NOT_ACTIVE` directly.
   */
  async findAvailableStoreIds(): Promise<Types.ObjectId[]> {
    const rows = (await this.storeModel
      .find(availableStoreFilter())
      .select('_id')
      .lean()
      .exec()) as Array<{ _id: Types.ObjectId }>;
    return rows.map((row) => row._id).filter(Boolean);
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
        '_id storeName storeSlug subdomain description storeLogo coverImage tagline wilaya commune streetAddress googleMapsUrl address contactEmail contactPhone contactPhones categories socialMedia status ownerStatus adminStatus totalProducts totalOrders createdAt',
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
