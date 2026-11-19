import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { Box, BoxDocument } from './schemas/box.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { StoresService } from '../stores/stores.service';
import { VariantsService } from '../inventory/services/variants.service';
import { ReservationsService } from '../inventory/services/reservations.service';
import { UploadService } from '../upload/upload.service';
import { CreateBoxDto } from './dto/create-box.dto';
import { UpdateBoxDto } from './dto/update-box.dto';
import { BoxQueryDto, VendorBoxQueryDto } from './dto/box-query.dto';
import { BoxSelectionDto } from './dto/box-selection.dto';
import {
  availableBoxes,
  bestReferenceTotal,
  BoxPricingEligibilityEntry,
  BoxUnitAvailability,
  selectionAvailableBoxes,
  selectionIssues,
  selectionReferenceTotal,
  selectionSavings,
  worstReferenceTotal,
} from './box-pricing';
import {
  BoxCartIssueCode,
  BoxCartLineQuote,
  BoxCartSelectionQuote,
  BoxListItem,
  BoxPublishIssue,
  BoxPublicDetail,
  BoxSelectionValidation,
  BoxSummary,
  BoxVendorDetail,
  BoxVendorEligibleItem,
  BoxVendorVariant,
  ResolvedCartBundles,
} from './box.types';

function firstNonEmpty(...values: (string | undefined | null)[]): string {
  return values.find((v) => typeof v === 'string' && v.trim().length > 0) || '';
}

/** Replicates `ProductsService.fillLanguages` (missing language ← en ← fr ← ar). */
function fillLanguages(
  en: string | undefined | null,
  ar: string | undefined | null,
  fr: string | undefined | null,
): [string, string, string] {
  const first = firstNonEmpty(en, ar, fr);
  return [en || first, ar || first, fr || first];
}

/** Module-local copy: `escapeRegex` is private to `ProductsService`. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface ResolvedVariant {
  variantId: string;
  productId: string;
  storeId: string;
  label: string;
  optionValueIds: string[];
  sku: string | null;
  unitPrice: number;
  compareAtPrice: number | null;
  image: string | null;
  available: number;
  isActive: boolean;
  isDeleted: boolean;
  isAvailable: boolean;
}

interface ResolvedProduct {
  productId: string;
  productSlug: string;
  productNameEn: string;
  productNameAr: string;
  productNameFr: string;
  productImage?: string;
  productPublished: boolean;
  productArchived: boolean;
  variants: ResolvedVariant[];
}

interface ResolvedEligibility {
  products: ResolvedProduct[];
  eligibility: Map<string, BoxPricingEligibilityEntry>;
  units: BoxUnitAvailability[];
  variantCount: number;
  publishableVariantCount: number;
  publishIssues: BoxPublishIssue[];
}

interface BoxComposition {
  snapshots: Map<string, any>;
  productById: Map<string, any>;
  availability: Map<string, number>;
}

@Injectable()
export class BoxesService {
  private readonly logger = new Logger(BoxesService.name);

  constructor(
    @InjectModel(Box.name) private readonly boxModel: Model<BoxDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly storesService: StoresService,
    private readonly variantsService: VariantsService,
    private readonly reservationsService: ReservationsService,
    private readonly uploadService: UploadService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // Vendor CRUD
  // ─────────────────────────────────────────────────────────────────────────────

  async create(
    dto: CreateBoxDto,
    store: { _id: any; vendorEmail: string },
  ): Promise<BoxDocument> {
    const storeId = String(store._id);
    const [nameEn, nameAr, nameFr] = fillLanguages(dto.nameEn, dto.nameAr, dto.nameFr);
    if (!firstNonEmpty(nameEn, nameAr, nameFr)) {
      throw new AppException(AppErrorCode.VALIDATION_AT_LEAST_ONE_LANGUAGE);
    }
    const [descriptionEn, descriptionAr, descriptionFr] = fillLanguages(
      dto.descriptionEn,
      dto.descriptionAr,
      dto.descriptionFr,
    );
    if (!firstNonEmpty(descriptionEn, descriptionAr, descriptionFr)) {
      throw new AppException(AppErrorCode.VALIDATION_AT_LEAST_ONE_LANGUAGE);
    }
    const images = dto.images ?? [];
    if (!dto.image && images.length === 0) {
      throw new AppException(AppErrorCode.VALIDATION_AT_LEAST_ONE_IMAGE);
    }

    const allowDuplicates = dto.allowDuplicates ?? true;
    const resolved = await this.loadEligibility(storeId, dto.eligibleItems, {
      strict: true,
    });
    const boxLike = {
      image: dto.image,
      images,
      nameEn,
      eligibleItems: dto.eligibleItems,
      price: dto.price,
      requiredQuantity: dto.requiredQuantity,
      allowDuplicates,
    };
    if (dto.published === true) {
      this.assertPublishable(boxLike, resolved);
    }

    const slug = await this.uniqueSlug(firstNonEmpty(nameEn, nameAr, nameFr));
    const created = new this.boxModel({
      storeId: new Types.ObjectId(storeId),
      vendorEmail: store.vendorEmail,
      slug,
      nameEn,
      nameAr,
      nameFr,
      descriptionEn,
      descriptionAr,
      descriptionFr,
      image: dto.image,
      images,
      price: dto.price,
      requiredQuantity: dto.requiredQuantity,
      allowDuplicates,
      published: dto.published === true,
      isArchived: false,
      archivedAt: null,
      archivedBy: null,
      eligibleItems: this.toEligibleDocs(dto.eligibleItems),
    });
    return created.save();
  }

  async update(
    id: string,
    dto: UpdateBoxDto,
    store: { _id: any; vendorEmail: string },
  ): Promise<BoxDocument> {
    const storeId = String(store._id);
    const existing = await this.boxModel.findById(id).exec();
    this.assertOwnership(existing, storeId);
    if (existing!.isArchived === true) {
      throw new AppException(AppErrorCode.BOX_ARCHIVED, { id });
    }

    const existingUpdatedAt = (existing as any).updatedAt;
    if (dto.expectedUpdatedAt && existingUpdatedAt) {
      const expected = new Date(dto.expectedUpdatedAt).getTime();
      const actual = new Date(existingUpdatedAt).getTime();
      if (Number.isFinite(expected) && Math.abs(expected - actual) > 1000) {
        throw new AppException(AppErrorCode.BOX_CONFLICT, {
          id,
          expectedUpdatedAt: dto.expectedUpdatedAt,
          actualUpdatedAt: existingUpdatedAt,
        });
      }
    }

    const updateData: Record<string, any> = {};

    if (
      dto.nameEn !== undefined ||
      dto.nameAr !== undefined ||
      dto.nameFr !== undefined
    ) {
      const [nameEn, nameAr, nameFr] = fillLanguages(
        dto.nameEn ?? existing!.nameEn,
        dto.nameAr ?? existing!.nameAr,
        dto.nameFr ?? existing!.nameFr,
      );
      if (!firstNonEmpty(nameEn, nameAr, nameFr)) {
        throw new AppException(AppErrorCode.VALIDATION_AT_LEAST_ONE_LANGUAGE);
      }
      updateData.nameEn = nameEn;
      updateData.nameAr = nameAr;
      updateData.nameFr = nameFr;
    }

    if (
      dto.descriptionEn !== undefined ||
      dto.descriptionAr !== undefined ||
      dto.descriptionFr !== undefined
    ) {
      const [descriptionEn, descriptionAr, descriptionFr] = fillLanguages(
        dto.descriptionEn ?? existing!.descriptionEn,
        dto.descriptionAr ?? existing!.descriptionAr,
        dto.descriptionFr ?? existing!.descriptionFr,
      );
      updateData.descriptionEn = descriptionEn;
      updateData.descriptionAr = descriptionAr;
      updateData.descriptionFr = descriptionFr;
    }

    if (dto.image !== undefined || dto.images !== undefined) {
      const nextImage = dto.image !== undefined ? dto.image : existing!.image;
      const nextImages =
        dto.images !== undefined ? dto.images : existing!.images ?? [];
      if (!nextImage && nextImages.length === 0) {
        throw new AppException(AppErrorCode.VALIDATION_AT_LEAST_ONE_IMAGE);
      }
      if (dto.image !== undefined) updateData.image = dto.image;
      if (dto.images !== undefined) updateData.images = dto.images;
    }

    if (dto.price !== undefined) updateData.price = dto.price;
    if (dto.requiredQuantity !== undefined) {
      updateData.requiredQuantity = dto.requiredQuantity;
    }
    if (dto.allowDuplicates !== undefined) {
      updateData.allowDuplicates = dto.allowDuplicates;
    }
    if (dto.published !== undefined) updateData.published = dto.published;
    if (dto.eligibleItems !== undefined) {
      updateData.eligibleItems = this.toEligibleDocs(dto.eligibleItems);
    }

    const nextPublished =
      dto.published !== undefined ? dto.published : existing!.published;
    // Name/description/image edits on an already-published Box must stay safe even if an
    // eligible product drifted to archived afterwards (plan §4.4). Publish validation runs
    // only when the Box is (re)published or when a sellability field changes.
    const publishRelevantChange =
      dto.published === true ||
      dto.eligibleItems !== undefined ||
      dto.requiredQuantity !== undefined ||
      dto.allowDuplicates !== undefined;
    let resolvedForUpdate: ResolvedEligibility | null = null;
    const effectiveEligibilitySource: Array<{ productId: string; variantIds: string[] }> =
      (dto.eligibleItems ?? existing!.eligibleItems ?? []).map((item: any) => ({
        productId: String(item.productId),
        variantIds: (item.variantIds ?? []).map(String),
      }));
    if (
      dto.eligibleItems !== undefined ||
      (nextPublished === true && publishRelevantChange)
    ) {
      // A draft edit still validates the ids it stores; a published edit additionally has to
      // remain publishable.
      resolvedForUpdate = await this.loadEligibility(
        storeId,
        effectiveEligibilitySource,
        { strict: true },
      );
    }
    if (nextPublished === true && publishRelevantChange && resolvedForUpdate) {
      this.assertPublishable(
        {
          image: dto.image !== undefined ? dto.image : existing!.image,
          images: dto.images !== undefined ? dto.images : existing!.images,
          nameEn: updateData.nameEn ?? existing!.nameEn,
          eligibleItems: effectiveEligibilitySource,
          price: dto.price ?? existing!.price,
          requiredQuantity: dto.requiredQuantity ?? existing!.requiredQuantity,
          allowDuplicates:
            dto.allowDuplicates !== undefined
              ? dto.allowDuplicates
              : existing!.allowDuplicates,
        },
        resolvedForUpdate,
      );
    }

    const updated = await this.boxModel
      .findOneAndUpdate(
        { _id: id, storeId: existing!.storeId },
        { $set: updateData },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new AppException(AppErrorCode.BOX_CONFLICT, { id });
    }

    // Delete replaced/removed uploads only after the database write has committed. The
    // helper checks every remaining Box and Product reference first, so a duplicated Box
    // that still points at the same URL keeps its image.
    await this.releaseRemovedImages(storeId, existing!, updated, id);
    return updated;
  }

  async findVendorPage(
    storeId: string,
    query: VendorBoxQueryDto,
  ): Promise<{
    boxes: BoxListItem[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    const filter: Record<string, any> = {
      storeId: new Types.ObjectId(storeId),
    };
    let sort: Record<string, 1 | -1> = { createdAt: -1, _id: -1 };

    if (query.status === 'archived') {
      filter.isArchived = true;
      sort = { archivedAt: -1, _id: -1 };
    } else {
      filter.isArchived = { $ne: true };
      if (query.status === 'active') filter.published = true;
      if (query.status === 'draft') filter.published = false;
    }

    if (query.search && query.search.trim()) {
      const regex = { $regex: escapeRegex(query.search.trim()), $options: 'i' };
      filter.$or = [{ nameEn: regex }, { nameAr: regex }, { nameFr: regex }];
    }

    const skip = (page - 1) * limit;
    const [total, docs] = await Promise.all([
      this.boxModel.countDocuments(filter).exec(),
      this.boxModel
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
    ]);

    const composition = await this.loadComposition(docs as any[]);
    return {
      boxes: (docs as any[]).map((doc) => this.toListItem(doc, composition)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOneForVendor(id: string, storeId: string): Promise<BoxVendorDetail> {
    const doc: any = await this.boxModel.findById(id).lean().exec();
    this.assertOwnership(doc, storeId);

    const resolved = await this.loadEligibility(
      String(storeId),
      doc.eligibleItems ?? [],
      { strict: false },
    );
    const boxes = availableBoxes(
      resolved.units.map((u) => u.available),
      doc.requiredQuantity,
      doc.allowDuplicates,
    );
    const publishIssues = [...resolved.publishIssues];
    if (
      doc.allowDuplicates === false &&
      resolved.publishableVariantCount < doc.requiredQuantity
    ) {
      publishIssues.push({ code: AppErrorCode.BOX_REQUIRED_QUANTITY_UNREACHABLE });
    }

    const eligibleItems: BoxVendorEligibleItem[] = resolved.products.map((p) => ({
      productId: p.productId,
      productNameEn: p.productNameEn,
      productNameAr: p.productNameAr,
      productNameFr: p.productNameFr,
      productImage: p.productImage,
      productPublished: p.productPublished,
      productArchived: p.productArchived,
      variants: p.variants.map<BoxVendorVariant>((v) => ({
        variantId: v.variantId,
        label: v.label,
        sku: v.sku,
        unitPrice: v.unitPrice,
        compareAtPrice: v.compareAtPrice,
        available: v.available,
        isActive: v.isActive,
        isDeleted: v.isDeleted,
        isAvailable: v.isAvailable,
      })),
    }));

    return {
      _id: String(doc._id),
      slug: doc.slug,
      nameEn: doc.nameEn,
      nameAr: doc.nameAr,
      nameFr: doc.nameFr,
      descriptionEn: doc.descriptionEn,
      descriptionAr: doc.descriptionAr,
      descriptionFr: doc.descriptionFr,
      image: doc.image,
      images: doc.images ?? [],
      price: doc.price,
      requiredQuantity: doc.requiredQuantity,
      allowDuplicates: doc.allowDuplicates !== false,
      published: doc.published === true,
      isArchived: doc.isArchived === true,
      eligibleProductCount: resolved.products.length,
      eligibleVariantCount: resolved.variantCount,
      availableBoxes: boxes,
      bestReferenceTotal: bestReferenceTotal(
        resolved.units,
        doc.requiredQuantity,
        doc.allowDuplicates,
      ),
      worstReferenceTotal: worstReferenceTotal(
        resolved.units,
        doc.requiredQuantity,
        doc.allowDuplicates,
      ),
      eligibleItems,
      publishIssues,
      updatedAt: this.toIso(doc.updatedAt),
      createdAt: this.toIso(doc.createdAt),
    };
  }

  async duplicate(
    id: string,
    store: { _id: any; vendorEmail: string },
  ): Promise<BoxDocument> {
    const storeId = String(store._id);
    const original: any = await this.boxModel.findById(id).lean().exec();
    this.assertOwnership(original, storeId);
    if (original.isArchived === true) {
      throw new AppException(AppErrorCode.BOX_ARCHIVED, { id });
    }

    const baseName = firstNonEmpty(
      original.nameEn,
      original.nameAr,
      original.nameFr,
    );
    const slug = await this.uniqueSlug(`${baseName}-copy`);

    const duplicate = new this.boxModel({
      storeId: new Types.ObjectId(storeId),
      vendorEmail: original.vendorEmail ?? store.vendorEmail,
      slug,
      nameEn: original.nameEn,
      nameAr: original.nameAr,
      nameFr: original.nameFr,
      descriptionEn: original.descriptionEn,
      descriptionAr: original.descriptionAr,
      descriptionFr: original.descriptionFr,
      image: original.image,
      images: original.images ?? [],
      price: original.price,
      requiredQuantity: original.requiredQuantity,
      allowDuplicates: original.allowDuplicates !== false,
      published: false,
      isArchived: false,
      archivedAt: null,
      archivedBy: null,
      eligibleItems: (original.eligibleItems ?? []).map((item: any) => ({
        productId: new Types.ObjectId(String(item.productId)),
        variantIds: (item.variantIds ?? []).map(
          (variantId: any) => new Types.ObjectId(String(variantId)),
        ),
      })),
    });
    return duplicate.save();
  }

  async archive(
    id: string,
    store: { _id: any; vendorEmail: string },
    actorEmail: string,
  ): Promise<{ id: string; archived: true; archivedAt: Date }> {
    const storeId = String(store._id);
    const existing: any = await this.boxModel.findById(id).exec();
    this.assertOwnership(existing, storeId);

    if (existing.isArchived === true) {
      return {
        id: String(existing._id),
        archived: true,
        archivedAt: existing.archivedAt ?? new Date(),
      };
    }

    const archivedAt = new Date();
    const claimed = await this.boxModel
      .findOneAndUpdate(
        {
          _id: id,
          storeId: existing.storeId,
          isArchived: { $ne: true },
        },
        { $set: { isArchived: true, archivedAt, archivedBy: actorEmail } },
        { new: true },
      )
      .exec();

    if (!claimed) {
      const current: any = await this.boxModel.findById(id).exec();
      if (!current) throw new AppException(AppErrorCode.BOX_NOT_FOUND, { id });
      if (current.isArchived === true) {
        return {
          id: String(current._id),
          archived: true,
          archivedAt: current.archivedAt ?? archivedAt,
        };
      }
      throw new AppException(AppErrorCode.BOX_CONFLICT, { id });
    }

    return { id: String(claimed._id), archived: true, archivedAt };
  }

  async restore(
    id: string,
    store: { _id: any; vendorEmail: string },
  ): Promise<{ id: string; archived: false }> {
    const storeId = String(store._id);
    const existing: any = await this.boxModel.findById(id).exec();
    this.assertOwnership(existing, storeId);

    if (existing.isArchived !== true) {
      return { id: String(existing._id), archived: false };
    }

    const restored = await this.boxModel
      .findOneAndUpdate(
        { _id: id, storeId: existing.storeId, isArchived: true },
        { $set: { isArchived: false, archivedAt: null, archivedBy: null } },
        { new: true },
      )
      .exec();

    if (!restored) {
      const current: any = await this.boxModel.findById(id).exec();
      if (!current) throw new AppException(AppErrorCode.BOX_NOT_FOUND, { id });
      if (current.isArchived !== true) {
        return { id: String(current._id), archived: false };
      }
      throw new AppException(AppErrorCode.BOX_CONFLICT, { id });
    }

    return { id: String(restored._id), archived: false };
  }

  async remove(
    id: string,
    store: { _id: any; vendorEmail: string },
  ): Promise<{ id: string; deleted: true }> {
    const storeId = String(store._id);
    const existing: any = await this.boxModel.findById(id).exec();
    this.assertOwnership(existing, storeId);

    // Archive is allowed with orders; a hard delete is not, because the Box would vanish from
    // a live order's snapshot back-reference. Archived/deleted orders never block.
    const activeOrders = await this.orderModel
      .countDocuments({
        'bundles.bundleId': String(id),
        isDeleted: { $ne: true },
        isArchived: { $ne: true },
      })
      .exec();
    if (activeOrders > 0) {
      throw new AppException(AppErrorCode.BOX_CANNOT_DELETE_HAS_ORDERS, {
        id,
        count: activeOrders,
      });
    }

    const deleted = await this.boxModel
      .findOneAndDelete({ _id: id, storeId: existing.storeId })
      .exec();
    if (!deleted) {
      throw new AppException(AppErrorCode.BOX_NOT_FOUND, { id });
    }

    // The Box row is gone; remove its uploads only after the delete succeeded, and only when
    // no other Box/Product still references them.
    await this.releaseImages(
      storeId,
      [existing?.image, ...(existing?.images ?? [])].filter(Boolean) as string[],
    );
    return { id: String((deleted as any)._id), deleted: true };
  }

  /**
   * Best-effort R2 cleanup after a successful update. Only URLs that disappeared from the
   * Box are considered. Deletes happen after the database write so a failed save can never
   * leave the Box pointing at a deleted object.
   */
  private async releaseRemovedImages(
    storeId: string,
    before: { image?: string | null; images?: string[] | null },
    after: { image?: string | null; images?: string[] | null },
    boxId: string,
  ): Promise<void> {
    const oldUrls = new Set(
      [before.image, ...(before.images ?? [])].filter(Boolean) as string[],
    );
    const newUrls = new Set(
      [after.image, ...(after.images ?? [])].filter(Boolean) as string[],
    );
    const removed = [...oldUrls].filter((url) => !newUrls.has(url));
    if (removed.length === 0) return;

    await this.releaseImages(storeId, removed, boxId);
  }

  /**
   * Delete upload keys only when no Box or Product still references the URL. `extractKeyFromUrl`
   * ignores external URLs (e.g. a pasted CDN link), so only objects in this R2 namespace are
   * ever touched. Every failure is logged and swallowed: cleanup must not fail the write.
   */
  private async releaseImages(
    storeId: string,
    urls: string[],
    excludeBoxId?: string,
  ): Promise<void> {
    if (!Types.ObjectId.isValid(storeId)) {
      this.logger.warn(`Skipping Box image cleanup: invalid store id ${storeId}`);
      return;
    }
    const storeKey = new Types.ObjectId(storeId);
    for (const url of urls) {
      try {
        const [boxReference, productReference] = await Promise.all([
          this.boxModel.exists({
            storeId: storeKey,
            ...(excludeBoxId ? { _id: { $ne: excludeBoxId } } : {}),
            $or: [{ image: url }, { images: url }],
          }),
          // Product.storeId is a Mixed path in this Mongoose build, so query with the
          // ObjectId shape the dual-write stores (a raw string would not match).
          this.productModel.exists({
            storeId: storeKey,
            $or: [{ image: url }, { images: url }],
          }),
        ]);
        if (boxReference || productReference) continue;

        const key = this.uploadService.extractKeyFromUrl(url);
        if (!key) continue;
        await this.uploadService.deleteFiles([key]);
      } catch (error) {
        this.logger.warn(
          `Failed to clean up Box image ${url}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public catalog
  // ─────────────────────────────────────────────────────────────────────────────

  async publicList(query: BoxQueryDto): Promise<{
    boxes: BoxSummary[];
    nextCursor: { createdAt: string; _id: string } | null;
    hasMore: boolean;
  }> {
    await this.storesService.findOne(query.storeId);

    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const conditions: Record<string, any>[] = [
      {
        storeId: new Types.ObjectId(query.storeId),
        published: true,
        isArchived: { $ne: true },
      },
    ];

    if (query.search && query.search.trim()) {
      const regex = { $regex: escapeRegex(query.search.trim()), $options: 'i' };
      conditions.push({
        $or: [{ nameEn: regex }, { nameAr: regex }, { nameFr: regex }],
      });
    }

    let cursor: { createdAt: Date; _id: Types.ObjectId } | null = null;
    if (query.cursor) {
      try {
        const parsed = JSON.parse(query.cursor);
        if (parsed?.createdAt && parsed?._id) {
          cursor = {
            createdAt: new Date(parsed.createdAt),
            _id: new Types.ObjectId(String(parsed._id)),
          };
        }
      } catch {
        // An unparseable cursor is ignored (first page) rather than a 500.
      }
    }
    if (cursor) {
      conditions.push({
        $or: [
          { createdAt: { $lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, _id: { $lt: cursor._id } },
        ],
      });
    }

    const docs = (await this.boxModel
      .find({ $and: conditions })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean()
      .exec()) as any[];

    const hasMore = docs.length > limit;
    const pageDocs = hasMore ? docs.slice(0, limit) : docs;

    // Exclude boxes whose eligibility is empty: there is nothing a customer can pick.
    const eligibleDocs = pageDocs.filter(
      (doc) =>
        Array.isArray(doc.eligibleItems) &&
        doc.eligibleItems.some(
          (item: any) =>
            Array.isArray(item.variantIds) && item.variantIds.length > 0,
        ),
    );

    const composition = await this.loadComposition(eligibleDocs);
    const boxes = eligibleDocs.map((doc) =>
      this.toSummary(doc, composition),
    ) as BoxSummary[];

    const last = pageDocs[pageDocs.length - 1];
    const nextCursor =
      hasMore && last
        ? { createdAt: this.toIso(last.createdAt), _id: String(last._id) }
        : null;

    return { boxes, nextCursor, hasMore };
  }

  async publicDetail(slugId: string): Promise<BoxPublicDetail> {
    const doc: any = await this.findPublicBox(slugId);
    if (!doc) throw new AppException(AppErrorCode.BOX_NOT_FOUND, { slugId });

    const store: any = await this.storesService.findOne(String(doc.storeId));
    const resolved = await this.loadEligibility(
      String(doc.storeId),
      doc.eligibleItems ?? [],
      { strict: false },
    );

    const eligibleItems: BoxPublicDetail['eligibleItems'] = [];
    const units: BoxUnitAvailability[] = [];

    for (const product of resolved.products) {
      if (!product.productPublished || product.productArchived) continue;
      for (const variant of product.variants) {
        if (!variant.isActive || variant.isDeleted) continue;
        units.push({
          unitPrice: variant.unitPrice,
          available: variant.available,
        });
        eligibleItems.push({
          productId: product.productId,
          productSlug: product.productSlug,
          productNameEn: product.productNameEn,
          productNameAr: product.productNameAr,
          productNameFr: product.productNameFr,
          productImage: product.productImage,
          variantId: variant.variantId,
          variantLabel: variant.label,
          optionValueIds: variant.optionValueIds,
          sku: variant.sku,
          unitPrice: variant.unitPrice,
          compareAtPrice: variant.compareAtPrice,
          available: variant.available,
          isAvailable: variant.available > 0,
        });
      }
    }

    const best = bestReferenceTotal(
      units,
      doc.requiredQuantity,
      doc.allowDuplicates,
    );
    const worst = worstReferenceTotal(
      units,
      doc.requiredQuantity,
      doc.allowDuplicates,
    );
    const boxes = availableBoxes(
      units.map((u) => u.available),
      doc.requiredQuantity,
      doc.allowDuplicates,
    );

    return {
      _id: String(doc._id),
      storeId: String(doc.storeId),
      slug: doc.slug,
      nameEn: doc.nameEn,
      nameAr: doc.nameAr,
      nameFr: doc.nameFr,
      image: doc.image,
      price: doc.price,
      requiredQuantity: doc.requiredQuantity,
      bestReferenceTotal: best,
      worstReferenceTotal: worst,
      availableBoxes: boxes,
      isAvailable: boxes > 0,
      eligibleVariantCount: eligibleItems.length,
      allowDuplicates: doc.allowDuplicates !== false,
      storeName: store?.storeName ?? '',
      storeSlug: store?.storeSlug ?? '',
      descriptionEn: doc.descriptionEn,
      descriptionAr: doc.descriptionAr,
      descriptionFr: doc.descriptionFr,
      images: doc.images ?? [],
      eligibleItems,
    };
  }

  /**
   * Read-only selection validator. Loads the Box, computes availability and returns
   * structured issues — it never writes (plan §9.2).
   */
  async validateSelection(
    boxOrSlugId: string,
    selections: BoxSelectionDto[],
  ): Promise<BoxSelectionValidation> {
    const doc: any = await this.findPublicBox(boxOrSlugId);
    if (!doc) throw new AppException(AppErrorCode.BOX_NOT_FOUND, { slugId: boxOrSlugId });

    const storeId = String(doc.storeId);
    const resolved = await this.loadEligibility(
      storeId,
      doc.eligibleItems ?? [],
      { strict: false },
    );

    const availability = new Map<string, number>();
    const unitPriceByVariant = new Map<string, number>();
    for (const product of resolved.products) {
      for (const variant of product.variants) {
        availability.set(variant.variantId, variant.available);
        unitPriceByVariant.set(variant.variantId, variant.unitPrice);
      }
    }

    const issues = selectionIssues({
      box: {
        price: doc.price,
        requiredQuantity: doc.requiredQuantity,
        allowDuplicates: doc.allowDuplicates !== false,
        storeId,
        published: doc.published === true,
        isArchived: doc.isArchived === true,
      },
      selections,
      eligibility: resolved.eligibility,
      availability,
      storeId,
      mode: 'public',
    });

    const selectedQuantity = selections.reduce(
      (sum, s) => sum + (Number(s.quantity) || 0),
      0,
    );
    const referenceTotal = selectionReferenceTotal(
      selections,
      unitPriceByVariant,
    );

    return {
      valid: issues.length === 0,
      requiredQuantity: doc.requiredQuantity,
      selectedQuantity,
      boxPrice: doc.price,
      referenceTotal,
      savings: selectionSavings(referenceTotal, doc.price),
      availableBoxes: selectionAvailableBoxes(selections, availability),
      issues,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Cart resolution
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Resolves cart bundle inputs into quote lines + flat order lines + snapshots.
   *
   * Never throws for a bad line: the quote must be able to show what is wrong. The strict
   * create path converts non-stock issues into `CART_ITEMS_INVALID` and lets
   * `assertCartAvailability` cover short stock on the flattened line list.
   */
  async resolveForCart(
    storeId: string | Types.ObjectId,
    bundleInputs: Array<{
      bundleId: string;
      quantity: number;
      selections: Array<{ variantId: string; quantity: number }>;
    }>,
    locale: 'en' | 'ar' | 'fr' = 'en',
  ): Promise<ResolvedCartBundles> {
    const storeKey = String(storeId);
    const inputs = Array.isArray(bundleInputs) ? bundleInputs : [];
    if (inputs.length === 0) {
      return {
        bundleLines: [],
        componentLines: [],
        bundleSnapshots: [],
        bundlesTotal: 0,
      };
    }

    const boxIds = [
      ...new Set(
        inputs
          .map((input) => String(input.bundleId ?? ''))
          .filter((id) => /^[a-fA-F0-9]{24}$/.test(id)),
      ),
    ];
    const docs = boxIds.length
      ? ((await this.boxModel
          .find({ _id: { $in: boxIds } })
          .lean()
          .exec()) as any[])
      : [];
    const boxById = new Map<string, any>(docs.map((doc) => [String(doc._id), doc]));

    const resolvedByBox = new Map<string, ResolvedEligibility>();
    for (const [id, doc] of boxById) {
      resolvedByBox.set(
        id,
        await this.loadEligibility(storeKey, doc.eligibleItems ?? [], {
          strict: false,
        }),
      );
    }

    const localized = (
      en: string | undefined,
      ar: string | undefined,
      fr: string | undefined,
    ): string => {
      if (locale === 'ar') return ar || en || fr || '';
      if (locale === 'fr') return fr || en || ar || '';
      return en || fr || ar || '';
    };

    const bundleLines: BoxCartLineQuote[] = [];
    const componentLines: Array<Record<string, any>> = [];
    const bundleSnapshots: Array<Record<string, any>> = [];
    let bundlesTotal = 0;

    for (const input of inputs) {
      const bundleId = String(input.bundleId ?? '');
      const doc = boxById.get(bundleId);
      const selections = Array.isArray(input.selections)
        ? input.selections
        : [];
      const quantity = Number(input.quantity);

      const lineKey = `bundle:${bundleId}:${this.bundleConfigHash(selections)}`;
      const issues = new Set<BoxCartIssueCode>();

      if (!doc) issues.add('BOX_NOT_FOUND');
      else {
        if (String(doc.storeId) !== storeKey) issues.add('BOX_STORE_MISMATCH');
        if (doc.isArchived === true) issues.add('BOX_ARCHIVED');
        else if (doc.published !== true) issues.add('BOX_INACTIVE');
      }

      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
        issues.add('BOX_SELECTION_INVALID');
      }
      if (
        selections.length === 0 ||
        selections.length > 50 ||
        !selections.every(
          (s) =>
            typeof s.variantId === 'string' &&
            s.variantId.length > 0 &&
            Number.isInteger(s.quantity) &&
            s.quantity >= 1 &&
            s.quantity <= 50,
        )
      ) {
        issues.add('BOX_SELECTION_INVALID');
      }

      const byVariant = new Map<string, number>();
      for (const selection of selections) {
        byVariant.set(
          selection.variantId,
          (byVariant.get(selection.variantId) ?? 0) + (selection.quantity || 0),
        );
      }
      if (byVariant.size !== selections.length) {
        issues.add('BOX_SELECTION_INVALID');
      }

      const resolved = resolvedByBox.get(bundleId);
      const variantById = new Map<string, ResolvedVariant>();
      for (const product of resolved?.products ?? []) {
        for (const variant of product.variants) {
          variantById.set(variant.variantId, variant);
        }
      }

      const selectionQuotes: BoxCartSelectionQuote[] = [];
      const availability = new Map<string, number>();
      for (const [variantId, variant] of variantById) {
        availability.set(variantId, variant.available);
      }

      for (const selection of selections) {
        const variant = variantById.get(selection.variantId);
        const entry = resolved?.eligibility.get(selection.variantId);
        if (!variant || !entry || entry.isDeleted || !entry.isActive) {
          issues.add('BOX_SELECTION_INVALID');
        } else if (entry.productArchived) {
          issues.add('BOX_SELECTION_INVALID');
        } else if (!entry.productPublished) {
          issues.add('BOX_SELECTION_INVALID');
        }
        selectionQuotes.push({
          productId: variant?.productId ?? entry?.productId ?? '',
          variantId: selection.variantId,
          productName: variant
            ? this.localizedProductName(
                resolved?.products.find((p) => p.productId === variant.productId),
                locale,
              )
            : '',
          variantLabel: variant?.label ?? '',
          image: variant?.image ?? null,
          quantity: selection.quantity,
          referenceUnitPrice: variant?.unitPrice ?? 0,
          available: variant?.available ?? 0,
        });
      }

      if (doc) {
        if (byVariant.size === selections.length) {
          const selectedQuantity = [...byVariant.values()].reduce(
            (sum, value) => sum + value,
            0,
          );
          if (
            selectedQuantity !== doc.requiredQuantity ||
            (doc.allowDuplicates === false &&
              [...byVariant.values()].some((value) => value > 1))
          ) {
            issues.add('BOX_SELECTION_INVALID');
          }
        } else {
          issues.add('BOX_SELECTION_INVALID');
        }
      }

      const exactCompositionBoxes = doc
        ? selectionAvailableBoxes(selections, availability)
        : 0;
      if (
        doc &&
        Number.isInteger(quantity) &&
        quantity >= 1 &&
        exactCompositionBoxes < quantity
      ) {
        issues.add('BOX_SELECTION_UNAVAILABLE');
      }

      const referenceTotal = selectionReferenceTotal(
        selections,
        new Map(
          [...variantById].map(([id, v]) => [id, v.unitPrice]),
        ),
      );
      const price = doc?.price ?? 0;
      const lineTotal = price * (Number.isInteger(quantity) ? quantity : 0);

      bundleLines.push({
        lineKey,
        bundleId,
        bundleSlug: doc?.slug ?? '',
        bundleName: doc
          ? localized(doc.nameEn, doc.nameAr, doc.nameFr)
          : '',
        image: doc?.image,
        price,
        requiredQuantity: doc?.requiredQuantity ?? 0,
        quantity: Number.isInteger(quantity) ? quantity : 0,
        lineTotal,
        availableBoxes: exactCompositionBoxes,
        isAvailable: issues.size === 0,
        issues: [...issues],
        selections: selectionQuotes,
        referenceTotal,
        savings: selectionSavings(referenceTotal, price),
      });

      if (!doc) continue;

      bundlesTotal += lineTotal;
      const bundleGroupId = new Types.ObjectId().toHexString();

      const contents: Array<Record<string, any>> = [];
      for (const selection of selections) {
        const variant = variantById.get(selection.variantId);
        const product = resolved?.products.find(
          (p) => p.productId === variant?.productId,
        );
        const lineId = new Types.ObjectId().toHexString();
        const componentQuantity =
          (selection.quantity || 0) * (Number.isInteger(quantity) ? quantity : 0);
        const productName = this.localizedProductName(product, locale);

        contents.push({
          lineId,
          productId: String(variant?.productId ?? ''),
          variantId: selection.variantId,
          productName,
          variantLabel: variant?.label ?? '',
          sku: variant?.sku ?? null,
          image: variant?.image ?? product?.productImage ?? null,
          quantityPerBox: selection.quantity,
          referenceUnitPrice: variant?.unitPrice ?? 0,
        });

        componentLines.push({
          lineId,
          productId: variant?.productId ?? '',
          productName,
          price: variant?.unitPrice ?? 0,
          originalPrice: variant?.compareAtPrice ?? null,
          quantity: componentQuantity,
          variantId: selection.variantId,
          variantDetails: variant?.label ?? '',
          image: variant?.image ?? product?.productImage ?? undefined,
          weight: undefined,
          bundleGroupId,
          bundleReferencePrice: variant?.unitPrice ?? 0,
        });
      }

      bundleSnapshots.push({
        bundleId,
        bundleGroupId,
        slug: doc.slug,
        nameEn: doc.nameEn,
        nameAr: doc.nameAr,
        nameFr: doc.nameFr,
        image: doc.image,
        price: doc.price,
        requiredQuantity: doc.requiredQuantity,
        quantity,
        lineTotal,
        referenceTotal: referenceTotal * quantity,
        savings: selectionSavings(referenceTotal, doc.price) * quantity,
        contents,
      });
    }

    return { bundleLines, componentLines, bundleSnapshots, bundlesTotal };
  }

  private bundleConfigHash(
    selections: Array<{ variantId: string; quantity: number }>,
  ): string {
    return selections
      .map((s) => `${s.variantId}:${s.quantity}`)
      .sort()
      .join(',');
  }

  private localizedProductName(
    product: ResolvedProduct | undefined,
    locale: 'en' | 'ar' | 'fr',
  ): string {
    if (!product) return '';
    if (locale === 'ar') return product.productNameAr || product.productNameEn || '';
    if (locale === 'fr') return product.productNameFr || product.productNameEn || '';
    return product.productNameEn || '';
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Eligibility resolution
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * One resolver for save, read and publish (plan §3.3.3). Strict throws on any broken
   * eligibility; tolerant keeps resolvable rows and reports `publishIssues` so the vendor
   * detail can show drift after a product/variant was archived.
   */
  private async loadEligibility(
    storeId: string,
    eligibleItems: Array<{ productId: string; variantIds: string[] }>,
    opts: { strict: boolean },
  ): Promise<ResolvedEligibility> {
    const empty: ResolvedEligibility = {
      products: [],
      eligibility: new Map(),
      units: [],
      variantCount: 0,
      publishableVariantCount: 0,
      publishIssues: [],
    };

    if (!Array.isArray(eligibleItems) || eligibleItems.length === 0) {
      if (opts.strict) throw new AppException(AppErrorCode.BOX_ELIGIBLE_EMPTY);
      return empty;
    }

    const variantIdsByProduct = new Map<string, string[]>();
    const seenVariantIds = new Set<string>();
    for (const item of eligibleItems) {
      const productId = String(item?.productId ?? '');
      const variantIds = Array.isArray(item?.variantIds)
        ? item.variantIds.map(String)
        : [];
      if (!productId || variantIds.length === 0) {
        if (opts.strict) {
          throw new AppException(AppErrorCode.BOX_ELIGIBLE_VARIANT_INVALID, {
            productId,
            reason: 'empty_variant_ids',
          });
        }
        continue;
      }
      const existing = variantIdsByProduct.get(productId) ?? [];
      for (const variantId of variantIds) {
        if (seenVariantIds.has(variantId)) {
          if (opts.strict) {
            throw new AppException(AppErrorCode.BOX_ELIGIBLE_VARIANT_INVALID, {
              variantId,
              reason: 'duplicate_variant',
            });
          }
          continue;
        }
        seenVariantIds.add(variantId);
        existing.push(variantId);
      }
      variantIdsByProduct.set(productId, existing);
    }

    const productIds = [...variantIdsByProduct.keys()];
    const allVariantIds = [...seenVariantIds];

    const products = productIds.length
      ? await this.productModel
          .find({ _id: { $in: productIds } })
          .select(
            'nameEn nameAr nameFr slug image images price originalPrice published isArchived storeId',
          )
          .lean()
          .exec()
      : [];
    const productById = new Map<string, any>(
      (products as any[]).map((p) => [String(p._id), p]),
    );

    const [snapshots, availability] = await Promise.all([
      this.variantsService.snapshotsForVariants(allVariantIds),
      this.reservationsService.getAvailabilityForVariants(allVariantIds),
    ]);

    const resolvedProducts: ResolvedProduct[] = [];
    const eligibility = new Map<string, BoxPricingEligibilityEntry>();
    const units: BoxUnitAvailability[] = [];
    const publishIssues: BoxPublishIssue[] = [];

    for (const [productId, variantIds] of variantIdsByProduct) {
      const product = productById.get(productId);
      if (!product) {
        if (opts.strict) {
          throw new AppException(AppErrorCode.BOX_ELIGIBLE_PRODUCT_INVALID, {
            productId,
            reason: 'not_found',
          });
        }
        publishIssues.push({
          code: AppErrorCode.BOX_ELIGIBLE_PRODUCT_INVALID,
          productId,
        });
        continue;
      }
      if (String(product.storeId) !== String(storeId)) {
        if (opts.strict) {
          throw new AppException(AppErrorCode.BOX_ELIGIBLE_PRODUCT_INVALID, {
            productId,
            reason: 'foreign_store',
          });
        }
        publishIssues.push({
          code: AppErrorCode.BOX_ELIGIBLE_PRODUCT_INVALID,
          productId,
        });
        continue;
      }
      if (product.isArchived === true) {
        if (opts.strict) {
          throw new AppException(AppErrorCode.BOX_ELIGIBLE_PRODUCT_INVALID, {
            productId,
            reason: 'archived',
          });
        }
        publishIssues.push({
          code: AppErrorCode.BOX_ELIGIBLE_PRODUCT_INVALID,
          productId,
        });
      }

      const productPublished = product.published === true;
      const productArchived = product.isArchived === true;
      if (!productPublished) {
        publishIssues.push({
          code: AppErrorCode.BOX_ELIGIBLE_PRODUCT_INVALID,
          productId,
        });
      }

      const resolvedProduct: ResolvedProduct = {
        productId,
        productSlug: product.slug ?? '',
        productNameEn: product.nameEn ?? '',
        productNameAr: product.nameAr ?? '',
        productNameFr: product.nameFr ?? '',
        productImage: product.image ?? product.images?.[0] ?? undefined,
        productPublished,
        productArchived,
        variants: [],
      };

      for (const variantId of variantIds) {
        const snap = snapshots.get(variantId);
        if (!snap) {
          if (opts.strict) {
            throw new AppException(AppErrorCode.BOX_ELIGIBLE_VARIANT_INVALID, {
              variantId,
              productId,
              reason: 'not_found',
            });
          }
          publishIssues.push({
            code: AppErrorCode.BOX_ELIGIBLE_VARIANT_INVALID,
            productId,
            variantId,
          });
          continue;
        }
        if (String(snap.productId) !== productId) {
          if (opts.strict) {
            throw new AppException(AppErrorCode.BOX_ELIGIBLE_VARIANT_INVALID, {
              variantId,
              productId,
              reason: 'variant_belongs_to_another_product',
            });
          }
          publishIssues.push({
            code: AppErrorCode.BOX_ELIGIBLE_VARIANT_INVALID,
            productId,
            variantId,
          });
          continue;
        }
        if (snap.storeId && String(snap.storeId) !== String(storeId)) {
          if (opts.strict) {
            throw new AppException(AppErrorCode.BOX_ELIGIBLE_VARIANT_INVALID, {
              variantId,
              productId,
              reason: 'variant_belongs_to_another_store',
            });
          }
          publishIssues.push({
            code: AppErrorCode.BOX_ELIGIBLE_VARIANT_INVALID,
            productId,
            variantId,
          });
          continue;
        }
        if (snap.isDeleted) {
          if (opts.strict) {
            throw new AppException(AppErrorCode.BOX_ELIGIBLE_VARIANT_INVALID, {
              variantId,
              productId,
              reason: 'variant_deleted',
            });
          }
          publishIssues.push({
            code: AppErrorCode.BOX_ELIGIBLE_VARIANT_INVALID,
            productId,
            variantId,
          });
        }
        if (!snap.isActive) {
          if (opts.strict) {
            throw new AppException(AppErrorCode.BOX_ELIGIBLE_VARIANT_INVALID, {
              variantId,
              productId,
              reason: 'variant_inactive',
            });
          }
          publishIssues.push({
            code: AppErrorCode.BOX_ELIGIBLE_VARIANT_INVALID,
            productId,
            variantId,
          });
        }

        const isActive = snap.isActive === true;
        const isDeleted = snap.isDeleted === true;
        const unitPrice = snap.priceOverride ?? product.price ?? 0;
        const compareAtPrice =
          snap.compareAtPrice ?? product.originalPrice ?? null;
        const available = availability.get(variantId) ?? 0;

        resolvedProduct.variants.push({
          variantId,
          productId,
          storeId: String(snap.storeId ?? storeId),
          label: snap.snapshot?.label ?? '',
          optionValueIds: snap.optionValueIds ?? [],
          sku: snap.sku ?? null,
          unitPrice,
          compareAtPrice,
          image:
            snap.image ??
            product.image ??
            product.images?.[0] ??
            null,
          available,
          isActive,
          isDeleted,
          isAvailable:
            isActive &&
            !isDeleted &&
            productPublished &&
            !productArchived &&
            available > 0,
        });

        eligibility.set(variantId, {
          productId,
          storeId: String(snap.storeId ?? storeId),
          isActive,
          isDeleted,
          productPublished,
          productArchived,
        });

        if (isActive && !isDeleted) {
          units.push({ unitPrice, available });
        }
      }

      if (resolvedProduct.variants.length > 0) {
        resolvedProducts.push(resolvedProduct);
      }
    }

    const variantCount = resolvedProducts.reduce(
      (sum, p) => sum + p.variants.length,
      0,
    );
    const publishableVariantCount = resolvedProducts.reduce(
      (sum, p) =>
        sum +
        (p.productPublished && !p.productArchived
          ? p.variants.filter((v) => v.isActive && !v.isDeleted).length
          : 0),
      0,
    );

    return {
      products: resolvedProducts,
      eligibility,
      units,
      variantCount,
      publishableVariantCount,
      publishIssues: [...new Map(publishIssues.map((i) => [JSON.stringify(i), i])).values()],
    };
  }

  private assertPublishable(
    box: {
      image?: string;
      images?: string[];
      nameEn?: string;
      eligibleItems?: Array<{ productId: string; variantIds: string[] }>;
      price: number;
      requiredQuantity: number;
      allowDuplicates: boolean;
    },
    resolved: ResolvedEligibility,
  ): void {
    if (!box.image && !(box.images?.length)) {
      throw new AppException(AppErrorCode.VALIDATION_AT_LEAST_ONE_IMAGE);
    }
    if (!firstNonEmpty(box.nameEn)) {
      throw new AppException(AppErrorCode.VALIDATION_AT_LEAST_ONE_LANGUAGE);
    }
    if (
      !Array.isArray(box.eligibleItems) ||
      box.eligibleItems.length === 0 ||
      resolved.variantCount === 0
    ) {
      throw new AppException(AppErrorCode.BOX_ELIGIBLE_EMPTY);
    }
    const issue = resolved.publishIssues[0];
    if (issue) {
      throw new AppException(issue.code as any, {
        productId: issue.productId,
        variantId: issue.variantId,
      });
    }
    if (
      box.allowDuplicates === false &&
      resolved.publishableVariantCount < box.requiredQuantity
    ) {
      throw new AppException(AppErrorCode.BOX_REQUIRED_QUANTITY_UNREACHABLE, {
        requiredQuantity: box.requiredQuantity,
        variantCount: resolved.publishableVariantCount,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Presentation helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private async loadComposition(boxes: any[]): Promise<BoxComposition> {
    const variantIds = [
      ...new Set(
        boxes.flatMap((doc) =>
          (doc.eligibleItems ?? []).flatMap((item: any) =>
            (item.variantIds ?? []).map(String),
          ),
        ),
      ),
    ];

    const [snapshots, availability] = await Promise.all([
      variantIds.length
        ? this.variantsService.snapshotsForVariants(variantIds)
        : Promise.resolve(new Map()),
      variantIds.length
        ? this.reservationsService.getAvailabilityForVariants(variantIds)
        : Promise.resolve(new Map()),
    ]);

    const productIds = [
      ...new Set(
        [...snapshots.values()]
          .map((snap: any) => String(snap.productId))
          .filter((id) => /^[a-fA-F0-9]{24}$/.test(id)),
      ),
    ];
    const products = productIds.length
      ? await this.productModel
          .find({ _id: { $in: productIds } })
          .select('price originalPrice')
          .lean()
          .exec()
      : [];

    return {
      snapshots,
      productById: new Map((products as any[]).map((p) => [String(p._id), p])),
      availability,
    };
  }

  private unitsForBox(doc: any, composition: BoxComposition): BoxUnitAvailability[] {
    const units: BoxUnitAvailability[] = [];
    for (const item of doc.eligibleItems ?? []) {
      for (const variantId of item.variantIds ?? []) {
        const id = String(variantId);
        const snap = composition.snapshots.get(id);
        const product = snap
          ? composition.productById.get(String(snap.productId))
          : undefined;
        units.push({
          unitPrice: snap?.priceOverride ?? product?.price ?? 0,
          available: composition.availability.get(id) ?? 0,
        });
      }
    }
    return units;
  }

  private toListItem(doc: any, composition: BoxComposition): BoxListItem {
    const units = this.unitsForBox(doc, composition);
    return {
      _id: String(doc._id),
      slug: doc.slug,
      nameEn: doc.nameEn,
      nameAr: doc.nameAr,
      nameFr: doc.nameFr,
      descriptionEn: doc.descriptionEn,
      descriptionAr: doc.descriptionAr,
      descriptionFr: doc.descriptionFr,
      image: doc.image,
      price: doc.price,
      requiredQuantity: doc.requiredQuantity,
      allowDuplicates: doc.allowDuplicates !== false,
      published: doc.published === true,
      isArchived: doc.isArchived === true,
      eligibleProductCount: (doc.eligibleItems ?? []).length,
      eligibleVariantCount: (doc.eligibleItems ?? []).reduce(
        (sum: number, item: any) => sum + (item.variantIds?.length ?? 0),
        0,
      ),
      availableBoxes: availableBoxes(
        units.map((u) => u.available),
        doc.requiredQuantity,
        doc.allowDuplicates,
      ),
      updatedAt: this.toIso(doc.updatedAt),
      createdAt: this.toIso(doc.createdAt),
    };
  }

  private toSummary(
    doc: any,
    composition: BoxComposition,
  ): BoxSummary {
    const units = this.unitsForBox(doc, composition);
    const boxes = availableBoxes(
      units.map((u) => u.available),
      doc.requiredQuantity,
      doc.allowDuplicates,
    );
    return {
      _id: String(doc._id),
      storeId: String(doc.storeId),
      slug: doc.slug,
      nameEn: doc.nameEn,
      nameAr: doc.nameAr,
      nameFr: doc.nameFr,
      image: doc.image,
      price: doc.price,
      requiredQuantity: doc.requiredQuantity,
      bestReferenceTotal: bestReferenceTotal(
        units,
        doc.requiredQuantity,
        doc.allowDuplicates,
      ),
      availableBoxes: boxes,
      isAvailable: boxes > 0,
      eligibleVariantCount: (doc.eligibleItems ?? []).reduce(
        (sum: number, item: any) => sum + (item.variantIds?.length ?? 0),
        0,
      ),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Small utilities
  // ─────────────────────────────────────────────────────────────────────────────

  private assertOwnership(box: any, storeId: string): void {
    if (!box || String(box.storeId) !== String(storeId)) {
      throw new AppException(AppErrorCode.BOX_NOT_FOUND, {
        id: box?._id ? String(box._id) : undefined,
      });
    }
  }

  private toEligibleDocs(
    eligibleItems: Array<{ productId: string; variantIds: string[] }>,
  ): Array<{ productId: Types.ObjectId; variantIds: Types.ObjectId[] }> {
    return eligibleItems.map((item) => ({
      productId: new Types.ObjectId(String(item.productId)),
      variantIds: item.variantIds.map(
        (variantId) => new Types.ObjectId(String(variantId)),
      ),
    }));
  }

  private async uniqueSlug(baseName: string): Promise<string> {
    let slug = this.slugify(baseName);
    const existing = await this.boxModel.findOne({ slug }).exec();
    if (existing) {
      slug = `${slug}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    }
    return slug;
  }

  private slugify(name: string): string {
    let slug = (name || '')
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!slug) {
      slug = `box-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    }
    return slug;
  }

  private async findPublicBox(boxOrSlugId: string): Promise<any | null> {
    if (/^[a-fA-F0-9]{24}$/.test(boxOrSlugId)) {
      return this.boxModel
        .findOne({
          _id: boxOrSlugId,
          published: true,
          isArchived: { $ne: true },
        })
        .lean()
        .exec();
    }

    const separatorIndex = boxOrSlugId.lastIndexOf('--');
    if (separatorIndex === -1) return null;
    const slug = boxOrSlugId.slice(0, separatorIndex);
    const suffix = boxOrSlugId.slice(separatorIndex + 2);
    if (!/^[0-9a-f]{8}$/i.test(suffix)) return null;

    const doc: any = await this.boxModel
      .findOne({ slug, published: true, isArchived: { $ne: true } })
      .lean()
      .exec();
    if (!doc) return null;
    if (!String(doc._id).endsWith(suffix)) return null;
    return doc;
  }

  private toIso(value: any): string {
    if (!value) return '';
    if (value instanceof Date) return value.toISOString();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
  }
}
