import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Category, CategoryDocument } from './schemas/category.schema';
import { SubCategory, SubCategoryDocument } from './schemas/sub-category.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CreateSubCategoryDto } from './dto/create-sub-category.dto';
import { UpdateSubCategoryDto } from './dto/update-sub-category.dto';
import { StoresService } from '../stores/stores.service';
import { UploadService } from '../upload/upload.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/constants/audit-action.enum';
import { ResourceType } from '../../common/constants/resource-type.enum';
import { ensureDefaultCategoriesForStore, GENERAL_CATEGORY } from './default-categories';

const DUPLICATE_KEY = 11000;

export interface CategoryGroup {
  category: Category & { _id?: Types.ObjectId; productCount: number };
  subCategories: Array<SubCategory & { _id?: Types.ObjectId; productCount: number }>;
  productCount: number;
}

function slugify(text: string, fallback: string): string {
  let slug = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) slug = `${fallback}-${Date.now()}`;
  return slug;
}

function trimName(value: string | undefined | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Store-owned category taxonomy.
 *
 * Every read/write here is scoped by `storeId` resolved from the caller's session. There is
 * no global category list and no public seed route; `storeId` is never accepted from a
 * vendor write DTO. Public reads accept exactly one store reference and return only
 * published, non-deleted rows.
 */
@Injectable()
export class CategoriesService {
  private readonly logger = new Logger(CategoriesService.name);

  constructor(
    @InjectModel(Category.name) private categoryModel: Model<CategoryDocument>,
    @InjectModel(SubCategory.name) private subCategoryModel: Model<SubCategoryDocument>,
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    private readonly storesService: StoresService,
    private readonly uploadService: UploadService,
    private readonly auditService: AuditService,
  ) {}

  private toStoreId(storeId: string | Types.ObjectId): Types.ObjectId {
    if (storeId instanceof Types.ObjectId) return storeId;
    if (!Types.ObjectId.isValid(storeId)) {
      throw new AppException(AppErrorCode.STORE_NOT_FOUND, { storeId });
    }
    return new Types.ObjectId(storeId);
  }

  private toActorId(actorId?: string): Types.ObjectId | undefined {
    return actorId && Types.ObjectId.isValid(actorId) ? new Types.ObjectId(actorId) : undefined;
  }

  private normalizeNames(
    en: string | undefined,
    ar: string | undefined,
    fr: string | undefined,
    existing?: { nameEn?: string; nameAr?: string; nameFr?: string },
  ): { nameEn: string; nameAr: string; nameFr: string } {
    const nameEn = trimName(en ?? existing?.nameEn);
    const nameAr = trimName(ar ?? existing?.nameAr);
    const nameFr = trimName(fr ?? existing?.nameFr);
    const first = nameEn || nameFr || nameAr;
    if (!first) {
      throw new AppException(AppErrorCode.VALIDATION_AT_LEAST_ONE_LANGUAGE);
    }
    return { nameEn: nameEn || first, nameAr: nameAr || first, nameFr: nameFr || first };
  }

  private assertImageUrl(image: string): void {
    const trimmed = image.trim();
    if (!trimmed) return;
    if (!/^https?:\/\//i.test(trimmed) && !trimmed.startsWith('/')) {
      throw new AppException(AppErrorCode.VALIDATION_INVALID_VALUE, { field: 'image' });
    }
  }

  private async findCategoryOrThrow(
    storeId: Types.ObjectId,
    categoryId: string,
  ): Promise<CategoryDocument> {
    if (!Types.ObjectId.isValid(categoryId)) {
      throw new AppException(AppErrorCode.CATEGORY_NOT_IN_STORE, { id: categoryId });
    }
    const category = await this.categoryModel
      .findOne({ _id: categoryId, storeId, isDeleted: false })
      .exec();
    if (!category) {
      throw new AppException(AppErrorCode.CATEGORY_NOT_IN_STORE, { id: categoryId });
    }
    return category;
  }

  private async findSubCategoryOrThrow(
    storeId: Types.ObjectId,
    categoryId: string,
    subId: string,
  ): Promise<SubCategoryDocument> {
    if (!Types.ObjectId.isValid(categoryId) || !Types.ObjectId.isValid(subId)) {
      throw new AppException(AppErrorCode.SUBCATEGORY_NOT_IN_STORE, { id: subId });
    }
    const subCategory = await this.subCategoryModel
      .findOne({ _id: subId, categoryId, storeId, isDeleted: false })
      .exec();
    if (!subCategory) {
      throw new AppException(AppErrorCode.SUBCATEGORY_NOT_IN_STORE, { id: subId });
    }
    return subCategory;
  }

  private async categorySlugTaken(
    storeId: Types.ObjectId,
    slug: string,
    excludeId?: Types.ObjectId,
  ): Promise<boolean> {
    const filter: Record<string, unknown> = { storeId, slug, isDeleted: false };
    if (excludeId) filter._id = { $ne: excludeId };
    return !!(await this.categoryModel.exists(filter));
  }

  private async subCategorySlugTaken(
    storeId: Types.ObjectId,
    categoryId: Types.ObjectId,
    slug: string,
    excludeId?: Types.ObjectId,
  ): Promise<boolean> {
    const filter: Record<string, unknown> = { storeId, categoryId, slug, isDeleted: false };
    if (excludeId) filter._id = { $ne: excludeId };
    return !!(await this.subCategoryModel.exists(filter));
  }

  private async resolveUniqueCategorySlug(
    storeId: Types.ObjectId,
    requested: string | undefined,
    baseName: string,
    excludeId?: Types.ObjectId,
  ): Promise<string> {
    const explicit = typeof requested === 'string' && requested.trim().length > 0;
    const base = slugify(explicit ? requested!.trim() : baseName, 'category');
    if (explicit) {
      if (await this.categorySlugTaken(storeId, base, excludeId)) {
        throw new AppException(AppErrorCode.CATEGORY_SLUG_DUPLICATE, { slug: base });
      }
      return base;
    }
    let candidate = base;
    let suffix = 1;
    while (await this.categorySlugTaken(storeId, candidate, excludeId)) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    return candidate;
  }

  private async resolveUniqueSubCategorySlug(
    storeId: Types.ObjectId,
    categoryId: Types.ObjectId,
    requested: string | undefined,
    baseName: string,
    excludeId?: Types.ObjectId,
  ): Promise<string> {
    const explicit = typeof requested === 'string' && requested.trim().length > 0;
    const base = slugify(explicit ? requested!.trim() : baseName, 'subcategory');
    let candidate = base;
    if (explicit) {
      if (await this.subCategorySlugTaken(storeId, categoryId, candidate, excludeId)) {
        throw new AppException(AppErrorCode.SUBCATEGORY_ALREADY_EXISTS, { slug: candidate });
      }
      return candidate;
    }
    let suffix = 1;
    while (await this.subCategorySlugTaken(storeId, categoryId, candidate, excludeId)) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    return candidate;
  }

  private handleDuplicate(
    err: any,
    code: (typeof AppErrorCode)[keyof typeof AppErrorCode],
    params: Record<string, unknown>,
  ): never {
    if (err?.code === DUPLICATE_KEY) {
      throw new AppException(code, params);
    }
    throw err;
  }

  private async deleteOwnedImage(storeId: Types.ObjectId, url?: string | null): Promise<void> {
    const key = url ? this.uploadService.extractKeyFromUrl(url) : null;
    if (!key) return;
    if (!key.startsWith(`store/${String(storeId)}/categories/`)) return;
    await this.uploadService.deleteFile(key).catch((err) =>
      this.logger.warn(`Failed to delete category image ${key}: ${err?.message ?? err}`),
    );
  }

  /**
   * One aggregation for the whole store: products grouped by their (category, subcategory)
   * pair. Vendor counts include drafts; public counts include published products only.
   */
  private async productCounts(
    storeId: Types.ObjectId,
    publishedOnly: boolean,
  ): Promise<{
    byCategory: Map<string, number>;
    bySubCategory: Map<string, number>;
  }> {
    const match: Record<string, unknown> = { storeId };
    if (publishedOnly) match.published = true;

    const rows = await this.productModel
      .aggregate<{ _id: { category?: Types.ObjectId; subCategory?: Types.ObjectId }; count: number }>([
        { $match: match },
        {
          $group: {
            _id: { category: '$category', subCategory: '$subCategory' },
            count: { $sum: 1 },
          },
        },
      ])
      .exec();

    const byCategory = new Map<string, number>();
    const bySubCategory = new Map<string, number>();
    for (const row of rows) {
      if (row._id.category) {
        const key = String(row._id.category);
        byCategory.set(key, (byCategory.get(key) || 0) + row.count);
      }
      if (row._id.subCategory) {
        bySubCategory.set(String(row._id.subCategory), row.count);
      }
    }
    return { byCategory, bySubCategory };
  }

  private async buildGroups(
    storeId: Types.ObjectId,
    publishedOnly: boolean,
  ): Promise<CategoryGroup[]> {
    const visibility = publishedOnly ? { isPublished: true } : {};
    const [categories, subCategories, counts] = await Promise.all([
      this.categoryModel
        .find({ storeId, isDeleted: false, ...visibility })
        .sort({ nameEn: 1, _id: 1 })
        .lean()
        .exec(),
      this.subCategoryModel
        .find({ storeId, isDeleted: false, ...visibility })
        .sort({ nameEn: 1, _id: 1 })
        .lean()
        .exec(),
      this.productCounts(storeId, publishedOnly),
    ]);

    const subsByCategory = new Map<string, Array<SubCategory & { productCount: number }>>();
    for (const sub of subCategories) {
      const key = String(sub.categoryId);
      const list = subsByCategory.get(key) || [];
      list.push({
        ...(sub as unknown as SubCategory),
        productCount: counts.bySubCategory.get(String(sub._id)) || 0,
      });
      subsByCategory.set(key, list);
    }

    return categories.map((category) => {
      const id = String(category._id);
      const productCount = counts.byCategory.get(id) || 0;
      return {
        category: { ...(category as unknown as Category), productCount },
        subCategories: subsByCategory.get(id) || [],
        productCount,
      };
    });
  }

  /** Idempotently ensures the store has its General/General defaults. */
  async ensureDefaultCategories(storeId: string | Types.ObjectId): Promise<void> {
    const id = this.toStoreId(storeId);
    await ensureDefaultCategoriesForStore(this.categoryModel, this.subCategoryModel, id);
  }

  async findMine(storeId: string | Types.ObjectId): Promise<CategoryGroup[]> {
    return this.buildGroups(this.toStoreId(storeId), false);
  }

  async findPublicByStore(ref: {
    storeId?: string;
    storeSlug?: string;
    vendorEmail?: string;
  }): Promise<CategoryGroup[]> {
    let store: any = null;
    try {
      if (ref.storeId) {
        if (!Types.ObjectId.isValid(ref.storeId)) return [];
        store = await this.storesService.findOne(ref.storeId);
      } else if (ref.storeSlug) {
        store = await this.storesService.findBySlug(ref.storeSlug);
      } else if (ref.vendorEmail) {
        store = await this.storesService.findByEmail(ref.vendorEmail);
      }
    } catch {
      // Unknown store, inactive store or a non-ObjectId identifier: a public category read
      // has nothing to show and must not leak the reason.
      return [];
    }
    if (!store) return [];
    return this.buildGroups(new Types.ObjectId(String(store._id)), true);
  }

  async findPublicById(categoryId: string): Promise<CategoryGroup> {
    // Id-only: a slug is unique per store, not globally, so a slug lookup could return an
    // arbitrary store's category.
    if (!Types.ObjectId.isValid(categoryId)) {
      throw new AppException(AppErrorCode.CATEGORY_NOT_FOUND, { id: categoryId });
    }
    const category = await this.categoryModel
      .findOne({ _id: categoryId, isDeleted: false, isPublished: true })
      .lean()
      .exec();
    if (!category || !category.storeId) {
      throw new AppException(AppErrorCode.CATEGORY_NOT_FOUND, { id: categoryId });
    }

    // A category on a missing/paused store is not public.
    try {
      await this.storesService.findOne(String(category.storeId));
    } catch {
      throw new AppException(AppErrorCode.CATEGORY_NOT_FOUND, { id: categoryId });
    }

    const [subCategories, counts] = await Promise.all([
      this.subCategoryModel
        .find({ storeId: category.storeId, categoryId: category._id, isDeleted: false, isPublished: true })
        .sort({ nameEn: 1, _id: 1 })
        .lean()
        .exec(),
      this.productCounts(new Types.ObjectId(String(category.storeId)), true),
    ]);

    const productCount = counts.byCategory.get(String(category._id)) || 0;
    return {
      category: { ...(category as unknown as Category), productCount },
      subCategories: subCategories.map((sub) => ({
        ...(sub as unknown as SubCategory),
        productCount: counts.bySubCategory.get(String(sub._id)) || 0,
      })),
      productCount,
    };
  }

  async createCategory(
    storeId: string | Types.ObjectId,
    dto: CreateCategoryDto,
    actorId?: string,
  ): Promise<CategoryGroup> {
    const id = this.toStoreId(storeId);
    const names = this.normalizeNames(dto.nameEn, dto.nameAr, dto.nameFr);
    const slug = await this.resolveUniqueCategorySlug(
      id,
      dto.slug,
      names.nameEn || names.nameFr || names.nameAr,
    );
    const image = dto.image !== undefined ? dto.image.trim() : '';
    if (image) this.assertImageUrl(image);

    let category: CategoryDocument;
    try {
      category = await this.categoryModel.create({
        storeId: id,
        ...names,
        slug,
        image: image || null,
        isPublished: dto.isPublished ?? true,
        isDeleted: false,
      });
    } catch (err) {
      this.handleDuplicate(err, AppErrorCode.CATEGORY_SLUG_DUPLICATE, { slug });
    }

    const createdSubs: SubCategoryDocument[] = [];
    try {
      for (const subDto of dto.subcategories ?? []) {
        createdSubs.push(await this.insertSubCategory(id, category!._id as Types.ObjectId, subDto));
      }
    } catch (err) {
      // Keep the create all-or-nothing: a bad nested subcategory must not leave a half tree.
      await this.subCategoryModel
        .updateMany(
          { _id: { $in: createdSubs.map((s) => s._id) } },
          { $set: { isDeleted: true, deletedAt: new Date() } },
        )
        .exec();
      await this.categoryModel
        .updateOne(
          { _id: category!._id },
          { $set: { isDeleted: true, deletedAt: new Date() } },
        )
        .exec();
      throw err;
    }

    await this.auditService.record({
      action: AuditAction.CATEGORY_CREATE,
      actorId: actorId ?? null,
      storeId: String(id),
      resourceType: ResourceType.CATEGORY,
      resourceId: String(category!._id),
      details: { slug, subcategories: createdSubs.length },
    });

    const groups = await this.buildGroups(id, false);
    return groups.find((g) => String(g.category._id) === String(category!._id)) ?? {
      category: { ...(category! as unknown as Category), productCount: 0 },
      subCategories: createdSubs.map((sub) => ({
        ...(sub as unknown as SubCategory),
        productCount: 0,
      })),
      productCount: 0,
    };
  }

  async updateCategory(
    storeId: string | Types.ObjectId,
    categoryId: string,
    dto: UpdateCategoryDto,
    actorId?: string,
  ): Promise<CategoryGroup> {
    const id = this.toStoreId(storeId);
    const existing = await this.findCategoryOrThrow(id, categoryId);

    const updateData: Record<string, unknown> = {};
    if (dto.nameEn !== undefined || dto.nameAr !== undefined || dto.nameFr !== undefined) {
      const names = this.normalizeNames(dto.nameEn, dto.nameAr, dto.nameFr, existing);
      updateData.nameEn = names.nameEn;
      updateData.nameAr = names.nameAr;
      updateData.nameFr = names.nameFr;
    }
    if (dto.slug !== undefined) {
      const baseName =
        (typeof updateData.nameEn === 'string' && updateData.nameEn) ||
        existing.nameEn ||
        existing.nameFr ||
        existing.nameAr;
      updateData.slug = await this.resolveUniqueCategorySlug(
        id,
        dto.slug,
        baseName,
        existing._id as Types.ObjectId,
      );
    }
    if (dto.image !== undefined) {
      const image = dto.image.trim();
      if (image) this.assertImageUrl(image);
      updateData.image = image || null;
    }
    if (dto.isPublished !== undefined) updateData.isPublished = dto.isPublished;

    let updated: CategoryDocument | null;
    try {
      updated = await this.categoryModel
        .findOneAndUpdate(
          { _id: existing._id, storeId: id, isDeleted: false },
          updateData,
          { new: true },
        )
        .exec();
    } catch (err) {
      this.handleDuplicate(err, AppErrorCode.CATEGORY_SLUG_DUPLICATE, {
        slug: updateData.slug,
      });
    }
    if (!updated) throw new AppException(AppErrorCode.CATEGORY_NOT_IN_STORE, { id: categoryId });

    if (dto.image !== undefined && existing.image && existing.image !== updated.image) {
      await this.deleteOwnedImage(id, existing.image);
    }

    await this.auditService.record({
      action: AuditAction.CATEGORY_UPDATE,
      actorId: actorId ?? null,
      storeId: String(id),
      resourceType: ResourceType.CATEGORY,
      resourceId: String(updated._id),
      details: { changes: Object.keys(updateData) },
    });

    const groups = await this.buildGroups(id, false);
    return groups.find((g) => String(g.category._id) === String(updated!._id))!;
  }

  async removeCategory(
    storeId: string | Types.ObjectId,
    categoryId: string,
    actorId?: string,
  ): Promise<{ id: string; deleted: true }> {
    const id = this.toStoreId(storeId);
    const category = await this.findCategoryOrThrow(id, categoryId);

    const subCategories = await this.subCategoryModel
      .find({ storeId: id, categoryId: category._id, isDeleted: false })
      .select('_id')
      .lean()
      .exec();
    const subIds = subCategories.map((sub) => sub._id);

    const productCount = await this.productModel
      .countDocuments({
        storeId: id,
        $or: [{ category: category._id }, ...(subIds.length ? [{ subCategory: { $in: subIds } }] : [])],
      })
      .exec();
    if (productCount > 0) {
      throw new AppException(AppErrorCode.CATEGORY_HAS_PRODUCTS, {
        id: categoryId,
        count: productCount,
      });
    }

    const now = new Date();
    const actor = this.toActorId(actorId);
    const deletedAt = now;
    await this.subCategoryModel
      .updateMany(
        { storeId: id, categoryId: category._id, isDeleted: false },
        { $set: { isDeleted: true, deletedAt } },
      )
      .exec();
    await this.categoryModel
      .updateOne(
        { _id: category._id, storeId: id, isDeleted: false },
        { $set: { isDeleted: true, deletedAt, ...(actor ? { deletedBy: actor } : {}) } },
      )
      .exec();

    await this.deleteOwnedImage(id, category.image);

    await this.auditService.record({
      action: AuditAction.CATEGORY_DELETE,
      actorId: actorId ?? null,
      storeId: String(id),
      resourceType: ResourceType.CATEGORY,
      resourceId: String(category._id),
      details: { softDeletedSubcategories: subIds.length },
    });

    return { id: String(category._id), deleted: true };
  }

  private async insertSubCategory(
    storeId: Types.ObjectId,
    categoryId: Types.ObjectId,
    dto: CreateSubCategoryDto,
  ): Promise<SubCategoryDocument> {
    const names = this.normalizeNames(dto.nameEn, dto.nameAr, dto.nameFr);
    const slug = await this.resolveUniqueSubCategorySlug(
      storeId,
      categoryId,
      dto.slug,
      names.nameEn || names.nameFr || names.nameAr,
    );
    try {
      return await this.subCategoryModel.create({
        storeId,
        categoryId,
        ...names,
        slug,
        isPublished: dto.isPublished ?? true,
        isDeleted: false,
      });
    } catch (err) {
      return this.handleDuplicate(err, AppErrorCode.SUBCATEGORY_ALREADY_EXISTS, { slug });
    }
  }

  async createSubCategory(
    storeId: string | Types.ObjectId,
    categoryId: string,
    dto: CreateSubCategoryDto,
    actorId?: string,
  ): Promise<SubCategory> {
    const id = this.toStoreId(storeId);
    const category = await this.findCategoryOrThrow(id, categoryId);
    const sub = await this.insertSubCategory(id, category._id as Types.ObjectId, dto);

    await this.auditService.record({
      action: AuditAction.SUBCATEGORY_CREATE,
      actorId: actorId ?? null,
      storeId: String(id),
      resourceType: ResourceType.SUBCATEGORY,
      resourceId: String(sub._id),
      details: { categoryId: String(category._id), slug: sub.slug },
    });

    return sub;
  }

  async updateSubCategory(
    storeId: string | Types.ObjectId,
    categoryId: string,
    subId: string,
    dto: UpdateSubCategoryDto,
    actorId?: string,
  ): Promise<SubCategory> {
    const id = this.toStoreId(storeId);
    await this.findCategoryOrThrow(id, categoryId);
    const existing = await this.findSubCategoryOrThrow(id, categoryId, subId);

    const updateData: Record<string, unknown> = {};
    if (dto.nameEn !== undefined || dto.nameAr !== undefined || dto.nameFr !== undefined) {
      const names = this.normalizeNames(dto.nameEn, dto.nameAr, dto.nameFr, existing);
      updateData.nameEn = names.nameEn;
      updateData.nameAr = names.nameAr;
      updateData.nameFr = names.nameFr;
    }
    if (dto.slug !== undefined) {
      const baseName =
        (typeof updateData.nameEn === 'string' && updateData.nameEn) ||
        existing.nameEn ||
        existing.nameFr ||
        existing.nameAr;
      updateData.slug = await this.resolveUniqueSubCategorySlug(
        id,
        existing.categoryId,
        dto.slug,
        baseName,
        existing._id as Types.ObjectId,
      );
    }
    if (dto.isPublished !== undefined) updateData.isPublished = dto.isPublished;

    let updated: SubCategoryDocument | null;
    try {
      updated = await this.subCategoryModel
        .findOneAndUpdate(
          { _id: existing._id, categoryId: existing.categoryId, storeId: id, isDeleted: false },
          updateData,
          { new: true },
        )
        .exec();
    } catch (err) {
      return this.handleDuplicate(err, AppErrorCode.SUBCATEGORY_ALREADY_EXISTS, {
        slug: updateData.slug,
      });
    }
    if (!updated) {
      throw new AppException(AppErrorCode.SUBCATEGORY_NOT_IN_STORE, { id: subId });
    }

    await this.auditService.record({
      action: AuditAction.SUBCATEGORY_UPDATE,
      actorId: actorId ?? null,
      storeId: String(id),
      resourceType: ResourceType.SUBCATEGORY,
      resourceId: String(updated._id),
      details: { changes: Object.keys(updateData) },
    });

    return updated;
  }

  async removeSubCategory(
    storeId: string | Types.ObjectId,
    categoryId: string,
    subId: string,
    actorId?: string,
  ): Promise<{ id: string; deleted: true }> {
    const id = this.toStoreId(storeId);
    const category = await this.findCategoryOrThrow(id, categoryId);
    const sub = await this.findSubCategoryOrThrow(id, categoryId, subId);

    const productCount = await this.productModel
      .countDocuments({ storeId: id, subCategory: sub._id })
      .exec();
    if (productCount > 0) {
      throw new AppException(AppErrorCode.SUBCATEGORY_HAS_PRODUCTS, {
        id: subId,
        count: productCount,
      });
    }

    const now = new Date();
    const actor = this.toActorId(actorId);
    await this.subCategoryModel
      .updateOne(
        { _id: sub._id, storeId: id, categoryId: category._id, isDeleted: false },
        { $set: { isDeleted: true, deletedAt: now, ...(actor ? { deletedBy: actor } : {}) } },
      )
      .exec();

    await this.auditService.record({
      action: AuditAction.SUBCATEGORY_DELETE,
      actorId: actorId ?? null,
      storeId: String(id),
      resourceType: ResourceType.SUBCATEGORY,
      resourceId: String(sub._id),
      details: { categoryId: String(category._id) },
    });

    return { id: String(sub._id), deleted: true };
  }

  /** Used by the data migration/verifier; not exposed over HTTP. */
  generalSlug(): string {
    return GENERAL_CATEGORY.slug;
  }
}
