require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Store-owned category indexes.
 *
 * Creates the per-store unique/partial indexes first; only when they exist with the
 * expected options does it drop the legacy global `slug_1` unique indexes (every store
 * needs a `general` slug, so the global index must go). Dry-run by default.
 *
 * Run: node scripts/migrate-store-category-indexes.js [--apply]
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

const TARGETS = {
  categories: [
    {
      key: { storeId: 1, slug: 1 },
      options: { unique: true, partialFilterExpression: { isDeleted: false } },
      name: 'storeId_1_slug_1',
      mustBeUnique: true,
      mustBePartial: true,
    },
    { key: { storeId: 1, isDeleted: 1, isPublished: 1 }, options: {}, name: 'storeId_1_isDeleted_1_isPublished_1' },
    { key: { storeId: 1, legacyId: 1 }, options: { sparse: true }, name: 'storeId_1_legacyId_1' },
  ],
  subcategories: [
    {
      key: { storeId: 1, categoryId: 1, slug: 1 },
      options: { unique: true, partialFilterExpression: { isDeleted: false } },
      name: 'storeId_1_categoryId_1_slug_1',
      mustBeUnique: true,
      mustBePartial: true,
    },
    {
      key: { storeId: 1, categoryId: 1, isDeleted: 1, isPublished: 1 },
      options: {},
      name: 'storeId_1_categoryId_1_isDeleted_1_isPublished_1',
    },
    { key: { storeId: 1, legacyId: 1 }, options: { sparse: true }, name: 'storeId_1_legacyId_1' },
  ],
  products: [
    {
      key: { storeId: 1, category: 1, subCategory: 1 },
      options: {},
      name: 'storeId_1_category_1_subCategory_1',
    },
  ],
};

const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const samePartial = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});

async function ensureTarget(collection, target, log) {
  const indexes = await collection.indexes();
  const existing = indexes.find((index) => sameKey(index.key, target.key));

  const ok =
    existing &&
    (!target.mustBeUnique || existing.unique === true) &&
    (!target.mustBePartial || samePartial(existing.partialFilterExpression, target.options.partialFilterExpression));

  if (ok) {
    log(`  ok ${target.name} ${JSON.stringify(target.key)}`);
    return true;
  }

  if (existing && !ok) {
    log(`  ${target.name} exists with unexpected options: ${JSON.stringify(existing)}`);
    if (!APPLY) {
      log(`  would drop and recreate ${target.name}`);
      return true;
    }
    await collection.dropIndex(existing.name);
    log(`  dropped malformed ${existing.name}`);
  }

  if (!APPLY) {
    log(`  would create ${target.name} ${JSON.stringify(target.key)} ${JSON.stringify(target.options)}`);
    return true;
  }
  await collection.createIndex(target.key, { ...target.options, name: target.name });
  log(`  created ${target.name}`);
  return true;
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log(`[MIGRATE STORE CATEGORY INDEXES] ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const names = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name),
  );
  for (const name of Object.keys(TARGETS)) {
    if (!names.has(name)) {
      console.log(`  ${name} does not exist yet; the schema creates its indexes on first write.`);
    }
  }

  // 1. Targets first. If a unique/partial target cannot be created (for example because
  //    duplicate slugs already exist), abort before touching the legacy index.
  let targetsReady = true;
  for (const [name, targets] of Object.entries(TARGETS)) {
    if (!names.has(name)) continue;
    console.log(`${name}:`);
    const collection = db.collection(name);
    for (const target of targets) {
      const ready = await ensureTarget(collection, target, console.log);
      if (target.mustBeUnique && !ready) targetsReady = false;
    }
  }

  if (!targetsReady) {
    console.error('\n  unique/partial targets are not ready; refusing to drop the legacy slug indexes.');
    await mongoose.disconnect();
    process.exit(1);
  }

  // 2. Legacy global slug index. It makes a second store's `general` slug impossible.
  for (const name of ['categories', 'subcategories']) {
    if (!names.has(name)) continue;
    const collection = db.collection(name);
    const indexes = await collection.indexes();
    const legacySlug = indexes.find((index) => sameKey(index.key, { slug: 1 }));
    if (legacySlug) {
      console.log(`${name}: legacy ${legacySlug.name} ${JSON.stringify(legacySlug.key)}${legacySlug.unique ? ' (unique)' : ''}`);
      if (APPLY) {
        await collection.dropIndex(legacySlug.name);
        console.log(`  dropped ${legacySlug.name}`);
      } else {
        console.log(`  would drop ${legacySlug.name}`);
      }
    } else {
      console.log(`${name}: no legacy {slug:1} index.`);
    }

    if (name === 'subcategories') {
      const legacyCategory = indexes.find((index) => sameKey(index.key, { categoryId: 1 }));
      if (legacyCategory) {
        console.log(`subcategories: redundant ${legacyCategory.name} ${JSON.stringify(legacyCategory.key)}`);
        if (APPLY) {
          await collection.dropIndex(legacyCategory.name);
          console.log(`  dropped ${legacyCategory.name}`);
        } else {
          console.log(`  would drop ${legacyCategory.name}`);
        }
      }
    }
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
