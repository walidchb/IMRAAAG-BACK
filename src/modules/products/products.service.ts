import { Injectable } from '@nestjs/common';
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
  constructor(
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    @InjectModel(Category.name) private categoryModel: Model<CategoryDocument>,
    @InjectModel(SubCategory.name) private subCategoryModel: Model<SubCategoryDocument>,
    @InjectModel(Order.name) private orderModel: Model<OrderDocument>,
    private readonly cacheService: CacheService,
  ) {}

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  async create(createProductDto: CreateProductDto, vendorEmail: string): Promise<Product> {
    const filled = fillLanguages(createProductDto.nameEn, createProductDto.nameAr, createProductDto.nameFr);

    const baseName = firstNonEmpty(createProductDto.nameEn, createProductDto.nameAr, createProductDto.nameFr);
    let slug = this.slugify(baseName);

    const existing = await this.productModel.findOne({ slug }).exec();
    if (existing) {
      slug = `${slug}-${Date.now()}`;
    }

    const created = new this.productModel({
      ...createProductDto,
      vendorEmail,
      ...filled,
      price: createProductDto.price ?? createProductDto.originalPrice,
      slug,
    });

    this.cacheService.clear('categories:');
    return created.save();
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
      try { cursorObj = JSON.parse(query.cursor); } catch {}
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
        { vendorEmail: regex },
        { 'variants.nameEn': regex },
        { 'variants.nameAr': regex },
        { 'variants.nameFr': regex },
        { 'variants.options.nameEn': regex },
        { 'variants.options.nameAr': regex },
        { 'variants.options.nameFr': regex },
      ];

      // Also search by category/subcategory name
      const matchingCategories = await this.categoryModel.find({
        $or: [
          { nameEn: regex },
          { nameAr: regex },
          { nameFr: regex },
          { slug: regex },
        ],
      }).select('_id').lean().exec();
      if (matchingCategories.length > 0) {
        orConditions.push({ category: { $in: matchingCategories.map(c => c._id) } });
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
        orConditions.push({ subCategory: { $in: matchingSubCategories.map(s => s._id) } });
      }

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
      try { cursorObj = JSON.parse(query.cursor); } catch {}
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
          slug = `${slug}-${Date.now()}`;
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
    return this.productModel
      .find(filter)
      .populate('category', 'nameEn nameAr nameFr slug')
      .populate('subCategory', 'nameEn nameAr nameFr slug')
      .sort(sort || { createdAt: -1 })
      .limit(50)
      .exec();
  }

  async remove(id: string, userEmail: string): Promise<{ id: string; deleted: true }> {
    const existing = await this.productModel.findById(id).exec();
    if (!existing) throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { id });
    if (existing.vendorEmail !== userEmail) {
      throw new AppException(AppErrorCode.PRODUCT_ACCESS_DENIED, { action: 'delete' });
    }
    const orderCount = await this.orderModel.countDocuments({ 'items.productId': id }).exec();
    if (orderCount > 0) {
      throw new AppException(AppErrorCode.PRODUCT_CANNOT_DELETE_HAS_ORDERS, { id, count: orderCount });
    }
    const result = await this.productModel.findByIdAndDelete(id).exec();
    if (!result) throw new AppException(AppErrorCode.PRODUCT_NOT_FOUND, { id });
    this.cacheService.clear('categories:');
    return { id: String(result._id), deleted: true };
  }
}
