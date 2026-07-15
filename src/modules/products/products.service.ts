import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Product, ProductDocument } from './schemas/product.schema';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

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

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
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

  async create(createProductDto: CreateProductDto): Promise<Product> {
    const filled = fillLanguages(createProductDto.nameEn, createProductDto.nameAr, createProductDto.nameFr);

    const baseName = firstNonEmpty(createProductDto.nameEn, createProductDto.nameAr, createProductDto.nameFr);
    let slug = this.slugify(baseName);

    const existing = await this.productModel.findOne({ slug }).exec();
    if (existing) {
      slug = `${slug}-${Date.now()}`;
    }

    const created = new this.productModel({
      ...createProductDto,
      ...filled,
      price: createProductDto.price ?? createProductDto.originalPrice,
      slug,
    });

    return created.save();
  }

  async findAll(query: {
    vendorEmail?: string;
    category?: string;
    status?: string;
    search?: string;
    published?: string;
  }): Promise<Product[]> {
    const filter: Record<string, any> = {};

    if (query.vendorEmail) filter.vendorEmail = query.vendorEmail;
    if (query.category) filter.category = query.category;
    if (query.status) filter.status = query.status;
    if (query.published !== undefined) filter.published = query.published === 'true';

    let queryBuilder = this.productModel.find(filter);

    if (query.search) {
      queryBuilder = this.productModel.find(
        { ...filter, $text: { $search: query.search } },
        { score: { $meta: 'textScore' } },
      ).sort({ score: { $meta: 'textScore' } });
    } else {
      queryBuilder = queryBuilder.sort({ createdAt: -1 });
    }

    return queryBuilder
      .populate('category', 'nameEn nameAr nameFr slug')
      .populate('subCategory', 'nameEn nameAr nameFr slug')
      .exec();
  }

  async findOne(id: string): Promise<Product> {
    const product = await this.productModel
      .findById(id)
      .populate('category', 'nameEn nameAr nameFr slug')
      .populate('subCategory', 'nameEn nameAr nameFr slug')
      .exec();
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    return product;
  }

  async update(id: string, updateProductDto: UpdateProductDto): Promise<Product> {
    const existing = await this.productModel.findById(id).exec();
    if (!existing) throw new NotFoundException(`Product ${id} not found`);

    const updateData: Record<string, any> = {};

    // Fill language fields: if any name is provided, fill empty ones
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

    // Copy remaining fields
    for (const key of Object.keys(updateProductDto) as (keyof UpdateProductDto)[]) {
      if (key === 'nameEn' || key === 'nameAr' || key === 'nameFr') continue;
      if (updateProductDto[key] !== undefined) {
        (updateData as Record<string, unknown>)[key] = updateProductDto[key] as unknown;
      }
    }

    // Default price to originalPrice if price not provided but originalPrice is updated
    if (updateData.originalPrice !== undefined && updateData.price === undefined) {
      updateData.price = updateData.originalPrice;
    }

    const updated = await this.productModel
      .findByIdAndUpdate(id, updateData, { new: true })
      .populate('category', 'nameEn nameAr nameFr slug')
      .populate('subCategory', 'nameEn nameAr nameFr slug')
      .exec();

    if (!updated) throw new NotFoundException(`Product ${id} not found`);
    return updated;
  }

  async remove(id: string): Promise<{ id: string; deleted: true }> {
    const result = await this.productModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Product ${id} not found`);
    return { id: String(result._id), deleted: true };
  }
}
