require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * One-time data remap: global categories -> per-store clones.
 *
 * Steps: optional backup, normalize store-owned defaults, backfill product storeId,
 * ensure General/General per store, clone only the legacy categories/subcategories each
 * store actually uses, remap products, then soft-archive unreferenced legacy docs.
 *
 * Idempotent: clones are keyed by `(storeId, legacyId)` and products already pointing at
 * a store-owned row are left alone. Dry-run by default.
 *
 * Run: node scripts/migrate-store-categories.js [--apply] [--store=<id>] [--backup]
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const BACKUP = process.argv.includes('--backup');
const BACKUP_ONLY = process.argv.includes('--backup-only');
const STORE_ARG = (process.argv.find((arg) => arg.startsWith('--store=')) || '').split('=')[1] || null;
const OID = mongoose.Types.ObjectId;
const S = (v) => (v == null ? '' : String(v));
const now = new Date();

const GENERAL = {
  nameEn: 'General',
  nameFr: 'Général',
  nameAr: 'عام',
  slug: 'general',
};

function baseSlug(text, fallback) {
  let slug = String(text || '')
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

function uniqueSlug(base, taken) {
  let candidate = base;
  let suffix = 1;
  while (taken.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  taken.add(candidate);
  return candidate;
}

async function backupCollections(db) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Products are copied too: the remap rewrites their category/subCategory pair, so the
  // rollback window needs the pre-migration values even though the plan's minimum is the
  // two taxonomy collections.
  for (const name of ['categories', 'subcategories', 'products']) {
    const target = `${name}_backup_${stamp}`;
    const docs = await db.collection(name).find({}).toArray();
    if (docs.length && APPLY) await db.collection(target).insertMany(docs);
    console.log(`  ${APPLY ? 'backed up' : 'would back up'} ${name} (${docs.length}) -> ${target}`);
  }
}

async function ensureDefaults(db, storeId, log) {
  const categories = db.collection('categories');
  const subs = db.collection('subcategories');
  const sid = new OID(storeId);

  let general = await categories.findOne({ storeId: sid, slug: 'general', isDeleted: false });
  if (!general) {
    general = {
      _id: new OID(),
      storeId: sid,
      ...GENERAL,
      image: null,
      isPublished: true,
      isDeleted: false,
      createdAt: now,
      updatedAt: now,
    };
    if (APPLY) await categories.insertOne(general);
    log(`  ${APPLY ? 'created' : 'would create'} General category`);
  }

  let generalSub = await subs.findOne({
    storeId: sid,
    categoryId: general._id,
    slug: 'general',
    isDeleted: false,
  });
  if (!generalSub) {
    generalSub = {
      _id: new OID(),
      storeId: sid,
      categoryId: general._id,
      ...GENERAL,
      isPublished: true,
      isDeleted: false,
      createdAt: now,
      updatedAt: now,
    };
    if (APPLY) await subs.insertOne(generalSub);
    log(`  ${APPLY ? 'created' : 'would create'} General subcategory`);
  }

  return { general, generalSub };
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log(`[MIGRATE STORE CATEGORIES] ${APPLY ? 'APPLY' : 'DRY RUN'}${STORE_ARG ? ` store=${STORE_ARG}` : ''}\n`);

  if (BACKUP) await backupCollections(db);
  if (BACKUP_ONLY) {
    console.log('\n  backup-only requested; no taxonomy or product documents were changed.');
    await mongoose.disconnect();
    return;
  }

  const storesCollection = db.collection('stores');
  const categoriesCollection = db.collection('categories');
  const subsCollection = db.collection('subcategories');
  const productsCollection = db.collection('products');

  let stores = await storesCollection.find({}).toArray();
  if (STORE_ARG) stores = stores.filter((s) => S(s._id) === STORE_ARG);
  const storeById = new Map(stores.map((s) => [S(s._id), s]));
  const allStores = await storesCollection.find({}).toArray();
  const storeByEmail = new Map(
    allStores.filter((s) => s.vendorEmail).map((s) => [String(s.vendorEmail).toLowerCase(), s]),
  );

  // 0. Normalize rows a partial rollout may have written before the defaults existed.
  if (APPLY) {
    await categoriesCollection.updateMany(
      { isDeleted: { $exists: false } },
      { $set: { isDeleted: false, isPublished: true, image: null } },
    );
    await subsCollection.updateMany(
      { isDeleted: { $exists: false } },
      { $set: { isDeleted: false, isPublished: true } },
    );
  }

  // 1. Backfill product.storeId from vendorEmail where it is missing and resolvable.
  let products = await productsCollection.find({}).toArray();
  const backfillOps = [];
  for (const product of products) {
    if (product.storeId) continue;
    const store = product.vendorEmail ? storeByEmail.get(String(product.vendorEmail).toLowerCase()) : null;
    if (!store) continue;
    if (!STORE_ARG || S(store._id) === STORE_ARG) {
      backfillOps.push({
        updateOne: {
          filter: { _id: product._id, storeId: { $exists: false } },
          update: { $set: { storeId: store._id, updatedAt: now } },
        },
      });
      product.storeId = store._id;
    }
  }
  for (let i = 0; i < backfillOps.length; i += 500) {
    if (APPLY) await productsCollection.bulkWrite(backfillOps.slice(i, i + 500));
  }
  console.log(`Products missing storeId backfilled from vendorEmail: ${backfillOps.length}${APPLY ? '' : ' (dry run)'}\n`);

  products = await productsCollection.find({}).toArray();
  const allCategories = await categoriesCollection.find({}).toArray();
  const allSubs = await subsCollection.find({}).toArray();
  const categoryById = new Map(allCategories.map((c) => [S(c._id), c]));
  const subById = new Map(allSubs.map((s) => [S(s._id), s]));

  let totalClonedCategories = 0;
  let totalClonedSubs = 0;
  let totalRemapped = 0;
  let totalOrphans = 0;

  const usedCategoryIds = new Set();
  const usedSubIds = new Set();

  for (const store of stores) {
    const storeId = S(store._id);
    const sid = new OID(storeId);
    console.log(`Store ${storeId} (${store.vendorEmail || 'no email'}):`);

    const log = (line) => console.log(line);
    const { general, generalSub } = await ensureDefaults(db, storeId, log);

    // Track active store-owned rows so generates never collide with an existing slug.
    const storeCats = await categoriesCollection
      .find({ storeId: sid, isDeleted: false })
      .toArray();
    const storeSubs = await subsCollection
      .find({ storeId: sid, isDeleted: false })
      .toArray();
    const categorySlugs = new Set(storeCats.map((c) => c.slug));
    const subSlugsByParent = new Map();
    for (const sub of storeSubs) {
      const key = S(sub.categoryId);
      if (!subSlugsByParent.has(key)) subSlugsByParent.set(key, new Set());
      subSlugsByParent.get(key).add(sub.slug);
    }
    const categoryMap = new Map(); // legacy id -> target category document
    const subMap = new Map(); // legacy id -> target subcategory document
    const subsByCategory = new Map(); // target category id -> active subs
    for (const sub of storeSubs) {
      const key = S(sub.categoryId);
      if (!subsByCategory.has(key)) subsByCategory.set(key, []);
      subsByCategory.get(key).push(sub);
    }
    const addSub = (sub) => {
      const key = S(sub.categoryId);
      if (!subsByCategory.has(key)) subsByCategory.set(key, []);
      subsByCategory.get(key).push(sub);
    };

    const storeProducts = products.filter((p) => S(p.storeId) === storeId);
    if (storeProducts.length === 0) {
      console.log('  no products; General only.');
      continue;
    }

    // Legacy ids reachable from products, plus the parent category of each used subcategory.
    const legacyCatIds = new Set();
    const legacySubIds = new Set();
    for (const product of storeProducts) {
      if (product.category) legacyCatIds.add(S(product.category));
      if (product.subCategory) {
        legacySubIds.add(S(product.subCategory));
        const legacySub = subById.get(S(product.subCategory));
        if (legacySub && legacySub.categoryId && !legacySub.storeId) {
          legacyCatIds.add(S(legacySub.categoryId));
        }
      }
    }

    // 2. Resolve every reachable legacy category to a store-owned row.
    const resolveCategory = async (legacyId) => {
      if (categoryMap.has(legacyId)) return categoryMap.get(legacyId);
      if (legacyId === S(general._id)) {
        categoryMap.set(legacyId, general);
        usedCategoryIds.add(S(general._id));
        return general;
      }

      const doc = categoryById.get(legacyId);
      if (doc && !doc.isDeleted && doc.storeId && S(doc.storeId) === storeId) {
        categoryMap.set(legacyId, doc);
        usedCategoryIds.add(S(doc._id));
        return doc;
      }

      const existingClone = await categoriesCollection.findOne({
        storeId: sid,
        legacyId: new OID(legacyId),
        isDeleted: false,
      });
      if (existingClone) {
        categoryMap.set(legacyId, existingClone);
        usedCategoryIds.add(S(existingClone._id));
        categorySlugs.add(existingClone.slug);
        return existingClone;
      }

      if (!doc) {
        categoryMap.set(legacyId, general);
        usedCategoryIds.add(S(general._id));
        totalOrphans += 1;
        console.log(`  orphan category reference ${legacyId} -> General`);
        return general;
      }

      const slug = uniqueSlug(baseSlug(doc.slug || doc.nameEn, 'category'), categorySlugs);
      const clone = {
        _id: new OID(),
        storeId: sid,
        legacyId: new OID(legacyId),
        nameEn: doc.nameEn,
        nameAr: doc.nameAr,
        nameFr: doc.nameFr,
        slug,
        image: doc.image || null,
        isPublished: true,
        isDeleted: false,
        createdAt: now,
        updatedAt: now,
      };
      if (APPLY) await categoriesCollection.insertOne(clone);
      totalClonedCategories += 1;
      categoryById.set(S(clone._id), clone);
      categoryMap.set(legacyId, clone);
      usedCategoryIds.add(S(clone._id));
      console.log(`  ${APPLY ? 'cloned' : 'would clone'} category ${legacyId} -> ${slug}`);
      return clone;
    };

    for (const legacyId of legacyCatIds) await resolveCategory(legacyId);

    // 3. Resolve every used legacy subcategory, creating it under its target parent.
    const resolveSub = async (legacyId, productTargetCategory) => {
      if (subMap.has(legacyId)) return subMap.get(legacyId);

      const doc = subById.get(legacyId);
      if (
        doc &&
        !doc.isDeleted &&
        doc.storeId &&
        S(doc.storeId) === storeId &&
        categoryById.get(S(doc.categoryId)) &&
        !categoryById.get(S(doc.categoryId)).isDeleted &&
        S(categoryById.get(S(doc.categoryId)).storeId) === storeId
      ) {
        subMap.set(legacyId, doc);
        usedSubIds.add(S(doc._id));
        return doc;
      }

      const existingClone = await subsCollection.findOne({
        storeId: sid,
        legacyId: new OID(legacyId),
        isDeleted: false,
      });
      if (existingClone) {
        subMap.set(legacyId, existingClone);
        usedSubIds.add(S(existingClone._id));
        return existingClone;
      }

      if (!doc) {
        return null;
      }

      const parentTarget =
        categoryMap.get(S(doc.categoryId)) ||
        productTargetCategory ||
        general;
      const parentId = S(parentTarget._id);
      if (!subSlugsByParent.has(parentId)) subSlugsByParent.set(parentId, new Set());
      const slug = uniqueSlug(
        baseSlug(doc.slug || doc.nameEn, 'subcategory'),
        subSlugsByParent.get(parentId),
      );
      const clone = {
        _id: new OID(),
        storeId: sid,
        categoryId: parentTarget._id,
        legacyId: new OID(legacyId),
        nameEn: doc.nameEn,
        nameAr: doc.nameAr,
        nameFr: doc.nameFr,
        slug,
        isPublished: true,
        isDeleted: false,
        createdAt: now,
        updatedAt: now,
      };
      if (APPLY) await subsCollection.insertOne(clone);
      totalClonedSubs += 1;
      subById.set(S(clone._id), clone);
      subMap.set(legacyId, clone);
      usedSubIds.add(S(clone._id));
      addSub(clone);
      console.log(`  ${APPLY ? 'cloned' : 'would clone'} subcategory ${legacyId} -> ${slug}`);
      return clone;
    };

    const pickSubUnder = async (category, product) => {
      const active = (subsByCategory.get(S(category._id)) || []).filter(
        (sub) => !sub.isDeleted && sub.isPublished !== false,
      );
      if (active.length > 0) return active[0];

      const parentId = S(category._id);
      if (!subSlugsByParent.has(parentId)) subSlugsByParent.set(parentId, new Set());
      const slug = uniqueSlug('general', subSlugsByParent.get(parentId));
      const created = {
        _id: new OID(),
        storeId: sid,
        categoryId: category._id,
        nameEn: 'General',
        nameFr: 'Général',
        nameAr: 'عام',
        slug,
        isPublished: true,
        isDeleted: false,
        createdAt: now,
        updatedAt: now,
      };
      if (APPLY) await subsCollection.insertOne(created);
      addSub(created);
      usedSubIds.add(S(created._id));
      console.log(`  ${APPLY ? 'created' : 'would create'} fallback subcategory ${slug} under ${S(category._id)}`);
      return created;
    };

    // 4. Remap products.
    const ops = [];
    for (const product of storeProducts) {
      let targetCategory = await resolveCategory(S(product.category));
      let targetSub = null;

      if (product.subCategory) {
        targetSub = await resolveSub(S(product.subCategory), targetCategory);
      }

      if (targetSub) {
        // The subcategory's real parent wins, so the product pair always matches.
        const parent = categoryById.get(S(targetSub.categoryId));
        if (parent) targetCategory = parent;
      } else {
        targetSub = await pickSubUnder(targetCategory, product);
      }

      if (!targetSub) {
        targetCategory = general;
        targetSub = generalSub;
      }

      const nextCategory = targetCategory._id;
      const nextSub = targetSub._id;
      const needs = {
        category: S(product.category) !== S(nextCategory),
        subCategory: S(product.subCategory) !== S(nextSub),
        storeId: S(product.storeId) !== storeId,
      };
      if (needs.category || needs.subCategory || needs.storeId) {
        ops.push({
          updateOne: {
            filter: { _id: product._id },
            update: {
              $set: {
                category: nextCategory,
                subCategory: nextSub,
                storeId: sid,
                updatedAt: now,
              },
            },
          },
        });
        totalRemapped += 1;
      }
      usedCategoryIds.add(S(nextCategory));
      usedSubIds.add(S(nextSub));
      product.category = nextCategory;
      product.subCategory = nextSub;
      product.storeId = sid;
    }

    for (let i = 0; i < ops.length; i += 500) {
      if (APPLY) await productsCollection.bulkWrite(ops.slice(i, i + 500));
    }
    console.log(`  products remapped: ${ops.length}${APPLY ? '' : ' (dry run)'}`);
  }

  // 5. Soft-archive legacy global rows no product points at any more. Never hard-delete.
  if (!STORE_ARG) {
    const archived = [];
    for (const doc of allCategories) {
      if (doc.storeId) continue;
      if (usedCategoryIds.has(S(doc._id))) continue;
      archived.push(doc._id);
    }
    const archivedSubs = [];
    for (const doc of allSubs) {
      if (doc.storeId) continue;
      if (usedSubIds.has(S(doc._id))) continue;
      archivedSubs.push(doc._id);
    }

    if (APPLY) {
      if (archived.length) {
        await categoriesCollection.updateMany(
          { _id: { $in: archived } },
          { $set: { isDeleted: true, deletedAt: now, legacy: true, updatedAt: now } },
        );
      }
      if (archivedSubs.length) {
        await subsCollection.updateMany(
          { _id: { $in: archivedSubs } },
          { $set: { isDeleted: true, deletedAt: now, legacy: true, updatedAt: now } },
        );
      }
    }
    console.log(
      `Legacy docs archived: categories=${archived.length} subcategories=${archivedSubs.length}${APPLY ? '' : ' (dry run)'}`,
    );
  }

  console.log('');
  console.log('Summary:');
  console.log(`  cloned categories: ${totalClonedCategories}`);
  console.log(`  cloned subcategories: ${totalClonedSubs}`);
  console.log(`  remapped products: ${totalRemapped}`);
  console.log(`  orphan references sent to General: ${totalOrphans}`);
  console.log(`  ${APPLY ? 'Apply complete.' : 'Dry run only. Re-run with --apply to write.'}`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
