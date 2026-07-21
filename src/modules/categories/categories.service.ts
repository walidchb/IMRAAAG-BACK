import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { AppErrorCode } from '../../common/errors/error-codes.enum';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Category, CategoryDocument } from './schemas/category.schema';
import { SubCategory, SubCategoryDocument } from './schemas/sub-category.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { CreateCategoryDto } from './dto/create-category.dto';
import { CacheService } from '../../common/cache.service';

const CACHE_KEY = 'categories:all';
const CACHE_TTL = 3600000; // 1 hour

@Injectable()
export class CategoriesService {
  constructor(
    @InjectModel(Category.name) private categoryModel: Model<CategoryDocument>,
    @InjectModel(SubCategory.name) private subCategoryModel: Model<SubCategoryDocument>,
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    private readonly cacheService: CacheService,
  ) {}

  async create(createCategoryDto: CreateCategoryDto): Promise<{ category: Category; subCategories: SubCategory[] }> {
    const created = new this.categoryModel({
      nameEn: createCategoryDto.nameEn,
      nameAr: createCategoryDto.nameAr,
      nameFr: createCategoryDto.nameFr,
      slug: createCategoryDto.slug,
    });
    const category = await created.save();

    const subCategories: SubCategory[] = [];
    if (createCategoryDto.subcategories) {
      for (const sub of createCategoryDto.subcategories) {
        const subDoc = new this.subCategoryModel({
          categoryId: category._id,
          nameEn: sub.nameEn,
          nameAr: sub.nameAr,
          nameFr: sub.nameFr,
          slug: sub.slug,
        });
        subCategories.push(await subDoc.save());
      }
    }

    this.cacheService.clear('categories:');
    return { category, subCategories };
  }

  async seed(): Promise<void> {
    const count = await this.categoryModel.countDocuments();
    if (count > 0) return;

    const categoriesData = [
      {
        slug: 'womens-fashion', nameEn: "Women's Fashion", nameAr: "أزياء نسائية", nameFr: "Mode Féminine",
        subcategories: [
          { slug: 'dresses', nameEn: "Dresses", nameAr: "فساتين", nameFr: "Robes" },
          { slug: 'tops', nameEn: "Tops", nameAr: "ملابس علوية", nameFr: "Hauts" },
          { slug: 'skirts', nameEn: "Skirts", nameAr: "تنانير", nameFr: "Jupes" },
          { slug: 'pants', nameEn: "Pants", nameAr: "سراويل", nameFr: "Pantalons" },
          { slug: 'abayas', nameEn: "Abayas", nameAr: "عبايات", nameFr: "Abayas" },
          { slug: 'jilbab', nameEn: "Jilbab", nameAr: "جلباب", nameFr: "Jilbab" },
          { slug: 'coord-sets', nameEn: "Co-ord Sets", nameAr: "أطقم متناسقة", nameFr: "Ensembles Coordonnés" },
        ]
      },
      {
        slug: 'modest-wear', nameEn: "Modest Wear", nameAr: "ملابس محتشمة", nameFr: "Mode Modeste",
        subcategories: [
          { slug: 'hijabs', nameEn: "Hijabs", nameAr: "حجاب", nameFr: "Hijabs" },
          { slug: 'khimars', nameEn: "Khimars", nameAr: "خمار", nameFr: "Khimars" },
          { slug: 'modest-abayas', nameEn: "Abayas", nameAr: "عبايات", nameFr: "Abayas" },
          { slug: 'niqabs', nameEn: "Niqabs", nameAr: "نقاب", nameFr: "Niqabs" },
          { slug: 'prayer-dresses', nameEn: "Prayer Dresses", nameAr: "ملابس صلاة", nameFr: "Tenues de Prière" },
          { slug: 'modest-sets', nameEn: "Modest Sets", nameAr: "أطقم محتشمة", nameFr: "Ensembles Modestes" },
          { slug: 'underscarves', nameEn: "Underscarves", nameAr: "بندانات", nameFr: "Bonnets" },
        ]
      },
      {
        slug: 'activewear', nameEn: "Activewear", nameAr: "ملابس رياضية", nameFr: "Vêtements de Sport",
        subcategories: [
          { slug: 'sports-hijabs', nameEn: "Sports Hijabs", nameAr: "حجاب رياضي", nameFr: "Hijabs de Sport" },
          { slug: 'modest-sports-sets', nameEn: "Modest Sports Sets", nameAr: "أطقم رياضية محتشمة", nameFr: "Ensembles de Sport Modestes" },
          { slug: 'leggings', nameEn: "Leggings", nameAr: "ليجينز", nameFr: "Leggings" },
          { slug: 'sports-tops', nameEn: "Sports Tops", nameAr: "قمصان رياضية", nameFr: "Hauts de Sport" },
        ]
      },
      {
        slug: 'lingerie-intimates', nameEn: "Lingerie & Intimates", nameAr: "لانجري وملابس داخلية", nameFr: "Lingerie & Sous-vêtements",
        subcategories: [
          { slug: 'bras', nameEn: "Bras", nameAr: "حمالات صدر", nameFr: "Soutiens-gorge" },
          { slug: 'underwear', nameEn: "Underwear", nameAr: "ملابس داخلية", nameFr: "Sous-vêtements" },
          { slug: 'shapewear', nameEn: "Shapewear", nameAr: "ملابس مشدة", nameFr: "Gaines & Sculptants" },
          { slug: 'sleepwear', nameEn: "Sleepwear", nameAr: "ملابس نوم", nameFr: "Vêtements de Nuit" },
        ]
      },
      {
        slug: 'accessories', nameEn: "Accessories", nameAr: "إكسسوارات", nameFr: "Accessoires",
        subcategories: [
          { slug: 'bags', nameEn: "Bags", nameAr: "حقائب", nameFr: "Sacs" },
          { slug: 'jewelry', nameEn: "Jewelry", nameAr: "مجوهرات", nameFr: "Bijoux" },
          { slug: 'belts', nameEn: "Belts", nameAr: "أحزمة", nameFr: "Ceintures" },
          { slug: 'scarves-accessories', nameEn: "Scarves Accessories", nameAr: "إكسسوارات أوشحة", nameFr: "Accessoires Foulards" },
          { slug: 'hijab-pins', nameEn: "Hijab Pins", nameAr: "دبابيس حجاب", nameFr: "Épingles à Hijab" },
        ]
      },
      {
        slug: 'shoes', nameEn: "Shoes", nameAr: "أحذية", nameFr: "Chaussures",
        subcategories: [
          { slug: 'heels', nameEn: "Heels", nameAr: "أحذية كعب عالي", nameFr: "Talons" },
          { slug: 'sneakers', nameEn: "Sneakers", nameAr: "أحذية رياضية", nameFr: "Baskets" },
          { slug: 'flats', nameEn: "Flats", nameAr: "أحذية مسطحة", nameFr: "Ballerines & Flats" },
          { slug: 'sandals', nameEn: "Sandals", nameAr: "صنادل", nameFr: "Sandales" },
          { slug: 'boots', nameEn: "Boots", nameAr: "أحذية شتوية", nameFr: "Bottes" },
        ]
      },
      {
        slug: 'beauty-personal-care', nameEn: "Beauty & Personal Care", nameAr: "الجمال والعناية الشخصية", nameFr: "Beauté & Soins",
        subcategories: [
          { slug: 'skincare', nameEn: "Skincare", nameAr: "العناية بالبشرة", nameFr: "Soins de la Peau" },
          { slug: 'makeup', nameEn: "Makeup", nameAr: "مكياج", nameFr: "Maquillage" },
          { slug: 'hair-care', nameEn: "Hair Care", nameAr: "العناية بالشعر", nameFr: "Soins Capillaires" },
          { slug: 'fragrance', nameEn: "Fragrance", nameAr: "عطور", nameFr: "Parfums" },
        ]
      },
      {
        slug: 'handmade-artisan', nameEn: "Handmade & Artisan", nameAr: "منتجات يدوية وحرفية", nameFr: "Fait Main & Artisanal",
        subcategories: [
          { slug: 'handmade-abayas', nameEn: "Handmade Abayas", nameAr: "عبايات مصنوعة يدويًا", nameFr: "Abayas Fait Main" },
          { slug: 'embroidered-hijabs', nameEn: "Embroidered Hijabs", nameAr: "حجاب مطرز", nameFr: "Hijabs Brodés" },
          { slug: 'traditional-jewelry', nameEn: "Traditional Jewelry", nameAr: "مجوهرات تقليدية", nameFr: "Bijoux Traditionnels" },
          { slug: 'custom-pieces', nameEn: "Custom Pieces", nameAr: "قطع مخصصة", nameFr: "Pièces sur Mesure" },
        ]
      },
    ];

    for (const catData of categoriesData) {
      const category = new this.categoryModel({
        nameEn: catData.nameEn,
        nameAr: catData.nameAr,
        nameFr: catData.nameFr,
        slug: catData.slug,
      });
      const savedCat = await category.save();

      for (const subData of catData.subcategories) {
        const sub = new this.subCategoryModel({
          categoryId: savedCat._id,
          nameEn: subData.nameEn,
          nameAr: subData.nameAr,
          nameFr: subData.nameFr,
          slug: subData.slug,
        });
        await sub.save();
      }
    }

    this.cacheService.clear('categories:');
  }

  async findAll(): Promise<{ category: Category; subCategories: SubCategory[]; productCount: number }[]> {
    const cached = this.cacheService.get<{ category: Category; subCategories: SubCategory[]; productCount: number }[]>(CACHE_KEY);
    if (cached) return cached;

    const categories = await this.categoryModel.find().sort({ nameEn: 1 }).exec();
    const categoryIds = categories.map((c) => c._id);

    const [catCounts] = await Promise.all([
      this.productModel.aggregate<{ _id: Types.ObjectId; count: number }>([
        { $match: { published: true, status: 'Active', category: { $in: categoryIds } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ]).exec(),
    ]);

    const catCountMap = new Map<string, number>();
    for (const c of catCounts) {
      catCountMap.set(c._id.toString(), c.count);
    }

    const result: { category: Category; subCategories: SubCategory[]; productCount: number }[] = [];

    for (const cat of categories) {
      const subs = await this.subCategoryModel.find({ categoryId: cat._id }).sort({ nameEn: 1 }).exec();
      result.push({
        category: cat,
        subCategories: subs,
        productCount: catCountMap.get(cat._id.toString()) || 0,
      });
    }

    this.cacheService.set(CACHE_KEY, result, CACHE_TTL);
    return result;
  }

  async findOne(id: string): Promise<{ category: Category; subCategories: SubCategory[] }> {
    const filter = Types.ObjectId.isValid(id) ? { _id: id } : { slug: id };
    const category = await this.categoryModel.findOne(filter).exec();
    if (!category) throw new AppException(AppErrorCode.CATEGORY_NOT_FOUND, { id });
    const subCategories = await this.subCategoryModel.find({ categoryId: category._id }).exec();
    return { category, subCategories };
  }

  async remove(id: string): Promise<void> {
    const filter = Types.ObjectId.isValid(id) ? { _id: id } : { slug: id };
    const category = await this.categoryModel.findOne(filter).exec();
    if (!category) throw new AppException(AppErrorCode.CATEGORY_NOT_FOUND, { id });

    const subCategories = await this.subCategoryModel.find({ categoryId: category._id }).exec();
    const subCategoryIds = subCategories.map(s => String(s._id));

    const productCount = await this.productModel.countDocuments({
      $or: [
        { category: String(category._id) },
        { subCategory: { $in: subCategoryIds } },
      ],
    }).exec();

    if (productCount > 0) {
      throw new AppException(AppErrorCode.CATEGORY_HAS_PRODUCTS, { id, count: productCount });
    }

    await this.subCategoryModel.deleteMany({ categoryId: category._id }).exec();
    await this.categoryModel.deleteOne({ _id: category._id }).exec();
    this.cacheService.clear('categories:');
  }
}
