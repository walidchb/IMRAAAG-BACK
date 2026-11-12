require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Read-only verification for the store-owned category taxonomy.
 *
 * Fails (exit 1) when a store lacks General/General, an active row has no valid store or
 * parent, a product references a foreign/deleted row or a mismatched pair, slugs collide,
 * or a required index is missing/wrong. Also asserts the public visibility flags exist.
 *
 * Run: node scripts/verify-store-categories.js
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const S = (v) => (v == null ? '' : String(v));
const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const samePartial = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});

const violations = [];
const fail = (message) => violations.push(message);

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const [stores, categories, subCategories, products] = await Promise.all([
    db.collection('stores').find({}).toArray(),
    db.collection('categories').find({}).toArray(),
    db.collection('subcategories').find({}).toArray(),
    db.collection('products').find({}).toArray(),
  ]);

  const storeIds = new Set(stores.map((s) => S(s._id)));
  const categoryById = new Map(categories.map((c) => [S(c._id), c]));
  const subById = new Map(subCategories.map((s) => [S(s._id), s]));
  const activeCategories = categories.filter((c) => c.isDeleted !== true);
  const activeSubs = subCategories.filter((s) => s.isDeleted !== true);

  // 1. Defaults per store.
  for (const store of stores) {
    const general = activeCategories.find(
      (c) => S(c.storeId) === S(store._id) && c.slug === 'general',
    );
    if (!general) {
      fail(`store ${S(store._id)} has no non-deleted General category`);
      continue;
    }
    const generalSub = activeSubs.find(
      (sub) => S(sub.categoryId) === S(general._id) && sub.slug === 'general',
    );
    if (!generalSub) {
      fail(`store ${S(store._id)} has no General subcategory under ${S(general._id)}`);
    }
  }

  // 2. Store ownership + visibility flags.
  for (const category of activeCategories) {
    if (!category.storeId) fail(`active category ${S(category._id)} has no storeId`);
    else if (!storeIds.has(S(category.storeId))) {
      fail(`active category ${S(category._id)} points at missing store ${S(category.storeId)}`);
    }
    if (typeof category.isPublished !== 'boolean') {
      fail(`active category ${S(category._id)} has no boolean isPublished`);
    }
  }

  for (const sub of activeSubs) {
    if (!sub.storeId) fail(`active subcategory ${S(sub._id)} has no storeId`);
    else if (!storeIds.has(S(sub.storeId))) {
      fail(`active subcategory ${S(sub._id)} points at missing store ${S(sub.storeId)}`);
    }
    if (!sub.categoryId) {
      fail(`active subcategory ${S(sub._id)} has no categoryId`);
      continue;
    }
    const parent = categoryById.get(S(sub.categoryId));
    if (!parent) {
      fail(`active subcategory ${S(sub._id)} points at missing category ${S(sub.categoryId)}`);
      continue;
    }
    if (parent.isDeleted === true) {
      fail(`active subcategory ${S(sub._id)} points at deleted category ${S(sub.categoryId)}`);
    }
    if (S(parent.storeId) !== S(sub.storeId)) {
      fail(`subcategory ${S(sub._id)} store ${S(sub.storeId)} != parent store ${S(parent.storeId)}`);
    }
    if (typeof sub.isPublished !== 'boolean') {
      fail(`active subcategory ${S(sub._id)} has no boolean isPublished`);
    }
  }

  // 3. Products.
  for (const product of products) {
    const productId = S(product._id);
    if (!product.storeId) {
      fail(`product ${productId} has no storeId`);
      continue;
    }
    if (!storeIds.has(S(product.storeId))) {
      fail(`product ${productId} points at missing store ${S(product.storeId)}`);
    }

    const category = categoryById.get(S(product.category));
    if (!category) {
      fail(`product ${productId} references missing category ${S(product.category)}`);
    } else {
      if (category.isDeleted === true) {
        fail(`product ${productId} references deleted category ${S(product.category)}`);
      }
      if (S(category.storeId) !== S(product.storeId)) {
        fail(`product ${productId} category ${S(product.category)} is not in its store`);
      }
    }

    if (product.subCategory) {
      const sub = subById.get(S(product.subCategory));
      if (!sub) {
        fail(`product ${productId} references missing subcategory ${S(product.subCategory)}`);
      } else {
        if (sub.isDeleted === true) {
          fail(`product ${productId} references deleted subcategory ${S(product.subCategory)}`);
        }
        if (S(sub.storeId) !== S(product.storeId)) {
          fail(`product ${productId} subcategory ${S(product.subCategory)} is not in its store`);
        }
        if (S(sub.categoryId) !== S(product.category)) {
          fail(
            `product ${productId} subcategory parent ${S(sub.categoryId)} != category ${S(product.category)}`,
          );
        }
      }
    }
  }

  // 4. Duplicate slugs among active rows.
  const seenCategories = new Set();
  for (const category of activeCategories) {
    if (!category.storeId) continue;
    const key = `${S(category.storeId)}::${category.slug}`;
    if (seenCategories.has(key)) fail(`duplicate category slug ${key}`);
    seenCategories.add(key);
  }
  const seenSubs = new Set();
  for (const sub of activeSubs) {
    if (!sub.storeId) continue;
    const key = `${S(sub.storeId)}::${S(sub.categoryId)}::${sub.slug}`;
    if (seenSubs.has(key)) fail(`duplicate subcategory slug ${key}`);
    seenSubs.add(key);
  }

  // 5. Indexes.
  const required = {
    categories: [
      { key: { storeId: 1, slug: 1 }, unique: true, partial: { isDeleted: false } },
      { key: { storeId: 1, isDeleted: 1, isPublished: 1 } },
      { key: { storeId: 1, legacyId: 1 }, sparse: true },
    ],
    subcategories: [
      {
        key: { storeId: 1, categoryId: 1, slug: 1 },
        unique: true,
        partial: { isDeleted: false },
      },
      { key: { storeId: 1, categoryId: 1, isDeleted: 1, isPublished: 1 } },
      { key: { storeId: 1, legacyId: 1 }, sparse: true },
    ],
    products: [{ key: { storeId: 1, category: 1, subCategory: 1 } }],
  };

  const collections = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name),
  );
  for (const [name, specs] of Object.entries(required)) {
    if (!collections.has(name)) {
      fail(`collection ${name} is missing`);
      continue;
    }
    const indexes = await db.collection(name).indexes();
    for (const spec of specs) {
      const index = indexes.find((entry) => sameKey(entry.key, spec.key));
      if (!index) {
        fail(`${name} is missing index ${JSON.stringify(spec.key)}`);
        continue;
      }
      if (spec.unique && index.unique !== true) {
        fail(`${name} index ${JSON.stringify(spec.key)} is not unique`);
      }
      if (spec.partial && !samePartial(index.partialFilterExpression, spec.partial)) {
        fail(`${name} index ${JSON.stringify(spec.key)} partial filter != ${JSON.stringify(spec.partial)}`);
      }
      if (spec.sparse && index.sparse !== true) {
        fail(`${name} index ${JSON.stringify(spec.key)} is not sparse`);
      }
    }
  }

  console.log('[VERIFY STORE CATEGORIES]');
  console.log(
    `  stores=${stores.length} categories=${categories.length} subcategories=${subCategories.length} products=${products.length}`,
  );
  if (violations.length === 0) {
    console.log('  RESULT: OK — 0 violations');
    await mongoose.disconnect();
    return;
  }

  console.log(`  RESULT: FAIL — ${violations.length} violation(s)`);
  for (const violation of violations.slice(0, 100)) {
    console.log(`    - ${violation}`);
  }
  if (violations.length > 100) console.log(`    ... ${violations.length - 100} more`);
  await mongoose.disconnect();
  process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
