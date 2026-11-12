require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Read-only impact audit for the store-owned category taxonomy.
 *
 * Prints a per-store table of product/category usage and every integrity problem the
 * migration or verifier would care about. Writes nothing.
 *
 * Run: node scripts/audit-store-categories.js
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const S = (v) => (v == null ? '' : String(v));

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const [stores, categories, subCategories, products] = await Promise.all([
    db.collection('stores').find({}).toArray(),
    db.collection('categories').find({}).toArray(),
    db.collection('subcategories').find({}).toArray(),
    db.collection('products').find({}).toArray(),
  ]);

  const storeById = new Map(stores.map((s) => [S(s._id), s]));
  const storeByEmail = new Map(
    stores.filter((s) => s.vendorEmail).map((s) => [String(s.vendorEmail).toLowerCase(), s]),
  );
  const categoryById = new Map(categories.map((c) => [S(c._id), c]));
  const subById = new Map(subCategories.map((s) => [S(s._id), s]));

  const activeCategories = categories.filter((c) => c.isDeleted !== true);
  const activeSubs = subCategories.filter((s) => s.isDeleted !== true);

  const duplicates = (rows, keyFn) => {
    const seen = new Map();
    const dup = [];
    for (const row of rows) {
      const key = keyFn(row);
      if (!key) continue;
      if (seen.has(key)) dup.push(key);
      else seen.set(key, true);
    }
    return [...new Set(dup)];
  };

  console.log('[AUDIT STORE CATEGORIES]');
  console.log(`  stores=${stores.length} categories=${categories.length} subcategories=${subCategories.length} products=${products.length}`);
  console.log(`  active categories=${activeCategories.length} active subcategories=${activeSubs.length}`);
  console.log('');

  const usage = new Map();
  for (const store of stores) usage.set(S(store._id), { products: 0, missingStoreId: 0, missingCategory: 0, badParent: 0, orphan: 0 });
  const unresolved = [];
  let productsMissingStoreId = 0;
  let missingCategory = 0;
  let badParent = 0;

  for (const product of products) {
    let storeId = S(product.storeId);
    if (!storeId && product.vendorEmail) {
      const store = storeByEmail.get(String(product.vendorEmail).toLowerCase());
      if (store) storeId = S(store._id);
    }
    if (!storeId) {
      productsMissingStoreId += 1;
      unresolved.push(S(product._id));
      continue;
    }
    const stat = usage.get(storeId);
    if (!stat) {
      unresolved.push(S(product._id));
      continue;
    }
    stat.products += 1;
    if (!product.storeId) stat.missingStoreId += 1;

    const category = categoryById.get(S(product.category));
    if (!category || category.isDeleted === true) {
      stat.missingCategory += 1;
      missingCategory += 1;
    }

    if (product.subCategory) {
      const sub = subById.get(S(product.subCategory));
      if (!sub || sub.isDeleted === true) {
        stat.missingCategory += 1;
        missingCategory += 1;
      } else if (S(sub.categoryId) !== S(product.category)) {
        stat.badParent += 1;
        badParent += 1;
      }
    }
  }

  console.log('Per store:');
  console.log('  storeId                          email                              products  noStoreId  missingCat  badParent  general');
  for (const store of stores) {
    const stat = usage.get(S(store._id)) || { products: 0, missingStoreId: 0, missingCategory: 0, badParent: 0 };
    const hasGeneral = activeCategories.some(
      (c) => S(c.storeId) === S(store._id) && c.slug === 'general',
    );
    const hasGeneralSub = hasGeneral && activeSubs.some((s) => {
      const parent = categoryById.get(S(s.categoryId));
      return parent && S(s.storeId) === S(store._id) && S(s.categoryId) === S(parent._id) && s.slug === 'general';
    });
    console.log(
      `  ${S(store._id).padEnd(32)} ${String(store.vendorEmail || '').slice(0, 32).padEnd(32)} ` +
        `${String(stat.products).padEnd(8)} ${String(stat.missingStoreId).padEnd(10)} ` +
        `${String(stat.missingCategory).padEnd(11)} ${String(stat.badParent).padEnd(10)} ${hasGeneral && hasGeneralSub ? 'yes' : 'MISSING'}`,
    );
  }

  const catDup = duplicates(activeCategories, (c) => (c.storeId ? `${S(c.storeId)}::${c.slug}` : null));
  const subDup = duplicates(activeSubs, (s) => (s.storeId ? `${S(s.storeId)}::${S(s.categoryId)}::${s.slug}` : null));
  const activeWithoutStore = activeCategories.filter((c) => !c.storeId);
  const subWithoutStore = activeSubs.filter((s) => !s.storeId);
  const subBadParent = activeSubs.filter((s) => {
    const parent = categoryById.get(S(s.categoryId));
    return !parent || parent.isDeleted === true || S(parent.storeId) !== S(s.storeId);
  });

  console.log('');
  console.log('Findings:');
  console.log(`  products missing resolvable storeId: ${productsMissingStoreId}`);
  console.log(`  products with missing/deleted category or subcategory: ${missingCategory}`);
  console.log(`  products whose subcategory parent != category: ${badParent}`);
  console.log(`  unresolved product ids: ${unresolved.length ? unresolved.slice(0, 10).join(', ') : 'none'}`);
  console.log(`  active categories without storeId: ${activeWithoutStore.length}`);
  console.log(`  active subcategories without storeId: ${subWithoutStore.length}`);
  console.log(`  active subcategories with bad parent: ${subBadParent.length}`);
  console.log(`  duplicate category (storeId, slug): ${catDup.length ? catDup.join(', ') : 'none'}`);
  console.log(`  duplicate subcategory (storeId, categoryId, slug): ${subDup.length ? subDup.join(', ') : 'none'}`);
  console.log(`  stores missing General/General: ${stores.filter((s) => {
    const hasGeneral = activeCategories.some((c) => S(c.storeId) === S(s._id) && c.slug === 'general');
    const general = activeCategories.find((c) => S(c.storeId) === S(s._id) && c.slug === 'general');
    return !hasGeneral || !general || !activeSubs.some((sub) => S(sub.categoryId) === S(general._id) && sub.slug === 'general');
  }).length}`);
  console.log('');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
