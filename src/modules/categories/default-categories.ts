import { Model, Types } from 'mongoose';
import { Category, CategoryDocument } from './schemas/category.schema';
import { SubCategory, SubCategoryDocument } from './schemas/sub-category.schema';

/**
 * The one category and subcategory every store starts with.
 *
 * Kept in a plain module (not a Nest provider) so both `CategoriesService` and
 * `StoresService` can ensure them without `StoresModule` importing `CategoriesModule`
 * (which imports `StoresModule`, and would be a cycle).
 */
export const GENERAL_CATEGORY = {
  nameEn: 'General',
  nameFr: 'Général',
  nameAr: 'عام',
  slug: 'general',
} as const;

type CategoryModel = Model<CategoryDocument>;
type SubCategoryModel = Model<SubCategoryDocument>;

const DUPLICATE_KEY = 11000;

async function upsertCategory(
  model: CategoryModel,
  storeId: Types.ObjectId,
): Promise<CategoryDocument> {
  const existing = await model
    .findOne({ storeId, slug: GENERAL_CATEGORY.slug, isDeleted: false })
    .exec();
  if (existing) return existing;

  try {
    return await model.findOneAndUpdate(
      { storeId, slug: GENERAL_CATEGORY.slug, isDeleted: false },
      {
        $setOnInsert: {
          storeId,
          ...GENERAL_CATEGORY,
          image: null,
          isPublished: true,
          isDeleted: false,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec() as CategoryDocument;
  } catch (err: any) {
    // A concurrent store creation won the upsert race against the partial unique index.
    if (err?.code === DUPLICATE_KEY) {
      const raced = await model
        .findOne({ storeId, slug: GENERAL_CATEGORY.slug, isDeleted: false })
        .exec();
      if (raced) return raced;
    }
    throw err;
  }
}

async function upsertSubCategory(
  model: SubCategoryModel,
  storeId: Types.ObjectId,
  categoryId: Types.ObjectId,
): Promise<SubCategoryDocument> {
  const existing = await model
    .findOne({ storeId, categoryId, slug: GENERAL_CATEGORY.slug, isDeleted: false })
    .exec();
  if (existing) return existing;

  try {
    return await model.findOneAndUpdate(
      { storeId, categoryId, slug: GENERAL_CATEGORY.slug, isDeleted: false },
      {
        $setOnInsert: {
          storeId,
          categoryId,
          ...GENERAL_CATEGORY,
          isPublished: true,
          isDeleted: false,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec() as SubCategoryDocument;
  } catch (err: any) {
    if (err?.code === DUPLICATE_KEY) {
      const raced = await model
        .findOne({ storeId, categoryId, slug: GENERAL_CATEGORY.slug, isDeleted: false })
        .exec();
      if (raced) return raced;
    }
    throw err;
  }
}

/**
 * Idempotently ensures the store has a non-deleted General category and a General
 * subcategory beneath it. Each step is a single atomic upsert, so no multi-document
 * transaction (and therefore no replica-set requirement) is involved.
 */
export async function ensureDefaultCategoriesForStore(
  categoryModel: CategoryModel,
  subCategoryModel: SubCategoryModel,
  storeId: string | Types.ObjectId,
): Promise<{ category: CategoryDocument; subCategory: SubCategoryDocument }> {
  const id = typeof storeId === 'string' ? new Types.ObjectId(storeId) : storeId;
  const category = await upsertCategory(categoryModel, id);
  const subCategory = await upsertSubCategory(subCategoryModel, id, category._id as Types.ObjectId);
  return { category, subCategory };
}
