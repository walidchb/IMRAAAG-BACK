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
import { ProductQueryDto, VendorProductQueryDto, CursorDto } from './dto/product-query.dto';
import { CacheService } from '../../common/cache.service';
import { StoresService } from '../stores/stores.service';
import { UploadService } from '../upload/upload.service';

function firstNonEmpty(...values: (string | undefined | null)[]): string {
  return values.find((v) => typeof v === 'string' && v.trim().length > 0) || '';
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

  async create(createProductDto: CreateProductDto, vendorEmail: string): Promise<Product> {
    const filled = fillLanguages(createProductDto.nameEn, createProductDto.nameAr, createProductDto.nameFr);

    const baseName = firstNonEmpty(createProductDto.nameEn, createProductDto.nameAr, createProductDto.nameFr);
    let slug = this.slugify(baseName);

    const existing = await this.productModel.findOne({ slug }).exec();
    if (existing) {
      slug = `${slug}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    }

    const created = new this.productModel({
      ...createProductDto,
      vendorEmail,
      ...filled,
      price: createProductDto.price ?? createProductDto.originalPrice,
      slug,
    });

    this.cacheService.clear('categories:');
    const saved = await created.save();
    await this.storesService.incrementProductCount(vendorEmail, 1);
    return saved;
  }

  async findAll(query: ProductQueryDto): Promise<CursorPaginatedResult<Product>> {
    const filter: Record<string, any> = { published: true, status: 'Active' };

    if (query.vendorEmail) filter.vendorEmail = query.vendorEmail;
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

      const matchingCategories = await this.categoryModel.find({
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
      .sort(sortOption)
      .limit(limit + 1)
      .populate('category', 'nameEn nameAr nameFr slug')
      .populate('subCategory', 'nameEn nameAr nameFr slug')
      .exec();

    const hasMore = items.length > limit;
    if (hasMore) items.pop();

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

  async findVendorProducts(vendorEmail: string, query: VendorProductQueryDto): Promise<CursorPaginatedResult<Product>> {
    const filter: Record<string, any> = { vendorEmail };

    if (query.category) filter.category = query.category;
    if (query.subCategory) filter.subCategory = query.subCategory;
    if (query.published !== undefined) filter.published = query.published === 'true';
    if (query.status) filter.status = query.status;
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      filter.price = {};
      if (query.minPrice !== undefined) filter.price.$gte = query.minPrice;
      if (query.maxPrice !== undefined) filter.price.$lte = query.maxPrice;
    }

    const limit = query.limit || 20;
    let sortOption: Record<string, any>;
    let searchFilter: Record<string, any>;

    let cursorObj: CursorDto | null = null;
    if (query.cursor) {
      try { cursorObj = JSON.parse(query.cursor); } catch { console.warn('Invalid cursor JSON:', query.cursor); }
    }

    if (query.search) {
      const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = { $regex: escaped, $options: 'i' };

      const orConditions: Record<string, any>[] = [
        { nameEn: regex },
        { nameAr: regex },
        { nameFr: regex },
        { storyEn: regex },
        { storyAr: regex },
        { storyFr: regex },
        { slug: regex },
        { 'variants.nameEn': regex },
        { 'variants.nameAr': regex },
        { 'variants.nameFr': regex },
        { 'variants.options.nameEn': regex },
        { 'variants.options.nameAr': regex },
        { 'variants.options.nameFr': regex },
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

      if (cursorObj && cursorObj.createdAt && cursorObj._id) {
        searchFilter.$or = [
          { createdAt: { $lt: new Date(cursorObj.createdAt) } },
          { createdAt: new Date(cursorObj.createdAt), _id: { $lt: new Types.ObjectId(cursorObj._id) } },
        ];
      }
    }

    const items = await this.productModel
      .find(searchFilter)
      .sort(sortOption)
      .limit(limit + 1)
      .populate('category', 'nameEn nameAr nameFr slug')
      .populate('subCategory', 'nameEn nameAr nameFr slug')
      .exec();

    const hasMore = items.length > limit;
    if (hasMore) items.pop();

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

  async findOne(id: string): Promise<Product> {
    const product = await this.productModel
      .findById(id)
      .populate('category', 'nameEn nameAr nameFr slug')
      .populate('subCategory', 'nameEn nameAr nameFr slug')
      .exec();
    if (!product) throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { id });
    return product;
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
      .populate('category', 'nameEn nameAr nameFr slug')
      .populate('subCategory', 'nameEn nameAr nameFr slug')
      .exec();

    if (!product) throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { slug });

    const productId = String(product._id);
    if (!productId.endsWith(idSuffix)) {
      throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { slugId });
    }

    return product;
  }

  async update(id: string, updateProductDto: UpdateProductDto, userEmail: string): Promise<Product> {
    const existing = await this.productModel.findById(id).exec();
    if (!existing) throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { id });
    if (existing.vendorEmail !== userEmail) {
      throw new AppException(AppErrorCode.PRODUCT_ACCESS_DENIED, { action: 'update' });
    }

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

    const updated = await this.productModel
      .findByIdAndUpdate(id, updateData, { new: true })
      .populate('category', 'nameEn nameAr nameFr slug')
      .populate('subCategory', 'nameEn nameAr nameFr slug')
      .exec();

    if (!updated) throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { id });
    this.cacheService.clear('categories:');

    // Clean up old images from R2 when replaced
    const oldImageKey = this.uploadService.extractKeyFromUrl(existing.image);
    const newImageKey = updateProductDto.image ? this.uploadService.extractKeyFromUrl(updateProductDto.image) : null;
    if (oldImageKey && newImageKey && oldImageKey !== newImageKey) {
      await this.uploadService.deleteProductImages(oldImageKey).catch((err) => {
        this.logger.warn(`Failed to delete old image ${oldImageKey}: ${err.message}`);
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
      .findOne({ published: true, status: 'Active' })
      .sort({ price: -1 })
      .select('price')
      .exec();
    return result?.price ?? 4500;
  }

  async findAllRaw(filter: Record<string, any>, sort?: Record<string, any>): Promise<Product[]> {
    const safeFilter: Record<string, any> = { published: true, status: 'Active', ...filter };
    return this.productModel
      .find(safeFilter)
      .populate('category', 'nameEn nameAr nameFr slug')
      .populate('subCategory', 'nameEn nameAr nameFr slug')
      .sort(sort || { createdAt: -1 })
      .limit(50)
      .exec();
  }

  async remove(id: string, userEmail: string): Promise<{ id: string; deleted: true }> {
    const orderCount = await this.orderModel.countDocuments({ 'items.productId': id }).exec();
    if (orderCount > 0) {
      throw new AppException(AppErrorCode.PRODUCT_CANNOT_DELETE_HAS_ORDERS, { id, count: orderCount });
    }

    const result = await this.productModel.findOneAndDelete({ _id: id, vendorEmail: userEmail }).exec();
    if (!result) {
      const exists = await this.productModel.findById(id).select('_id').exec();
      if (!exists) throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { id });
      throw new AppException(AppErrorCode.PRODUCT_ACCESS_DENIED, { action: 'delete' });
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

  async duplicate(id: string, userEmail: string): Promise<Product> {
    const original = await this.productModel.findById(id).exec();
    if (!original) throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { id });
    if (original.vendorEmail !== userEmail) {
      throw new AppException(AppErrorCode.PRODUCT_ACCESS_DENIED, { action: 'duplicate' });
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
      stock: original.stock,
      weight: original.weight,
      image: original.image,
      images: original.images,
      status: 'Draft',
      published: false,
      variants: original.variants,
    });

    this.cacheService.clear('categories:');
    return duplicateDoc.save();
  }
}
