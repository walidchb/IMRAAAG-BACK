require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');
const { inventoryCollectionNames } = require('./lib/inventory-collections');

/**
 * Product image ↔ option value association — index migration.
 *
 * The write endpoint links a product-gallery image to an option value. The database must refuse
 * two values on the same product claiming the same image, so the schema declares a **partial
 * unique** index on `{ productId, image }` (values with no image keep `image: null` and are
 * excluded by the partial filter). This script:
 *
 *   1. normalises empty/whitespace image strings to `null` (and trims stored URLs);
 *   2. refuses to create the index while duplicate `{productId, image}` groups exist;
 *   3. creates the index (dry-run by default).
 *
 * `--verify` checks the index without changing anything. `--drop-index` rolls it back.
 * `--clear-links --yes` clears every option-value image link (rare, destructive, rollback aid).
 *
 * Requires `npm run build` first (collection names resolve from the compiled schemas).
 *
 * Run: node scripts/migrate-option-value-image-index.js [--apply|--verify|--drop-index]
 *      node scripts/migrate-option-value-image-index.js --clear-links [--yes]
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const VERIFY = args.has('--verify');
const DROP_INDEX = args.has('--drop-index');
const CLEAR_LINKS = args.has('--clear-links');
const CONFIRMED = args.has('--yes');

const INDEX_KEY = { productId: 1, image: 1 };
const INDEX_NAME = 'productId_1_image_1_unique';
const INDEX_OPTIONS = {
  unique: true,
  partialFilterExpression: { image: { $type: 'string' } },
  name: INDEX_NAME,
};

async function normalizeImages(collection) {
  const malformed = await collection
    .find({ image: { $type: 'string' } }, { projection: { _id: 1, image: 1 } })
    .toArray();

  const toNull = [];
  const toTrim = [];
  for (const row of malformed) {
    const raw = row.image;
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) toNull.push(row._id);
    else if (trimmed !== raw) toTrim.push({ _id: row._id, image: trimmed });
  }

  console.log(`  empty/whitespace image values: ${toNull.length}`);
  console.log(`  untrimmed image values:        ${toTrim.length}`);

  if (!APPLY) {
    if (toNull.length) console.log('  would set empty image values to null');
    if (toTrim.length) console.log('  would trim untrimmed image values');
    return;
  }

  if (toNull.length) {
    await collection.updateMany({ _id: { $in: toNull } }, { $set: { image: null } });
    console.log(`  normalised ${toNull.length} empty image value(s) to null`);
  }
  for (const row of toTrim) {
    await collection.updateOne({ _id: row._id }, { $set: { image: row.image } });
  }
  if (toTrim.length) console.log(`  trimmed ${toTrim.length} image value(s)`);
}

async function duplicateGroups(collection) {
  return collection
    .aggregate([
      { $match: { image: { $type: 'string' } } },
      {
        $group: {
          _id: { productId: '$productId', image: '$image' },
          count: { $sum: 1 },
          valueIds: { $push: '$_id' },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const { optionValues } = inventoryCollectionNames();
  const collection = db.collection(optionValues);

  const mode = VERIFY
    ? 'VERIFY'
    : DROP_INDEX
      ? 'DROP INDEX'
      : CLEAR_LINKS
        ? 'CLEAR LINKS'
        : APPLY
          ? 'APPLY'
          : 'DRY RUN';
  console.log(`[MIGRATE OPTION VALUE IMAGES] ${mode}\n  collection: ${optionValues}\n`);

  let indexes = [];
  try {
    indexes = await collection.indexes();
  } catch {
    // A missing collection simply has no indexes yet; nothing to inspect.
    indexes = [];
  }
  const matchingKey = indexes.find(
    (index) => JSON.stringify(index.key) === JSON.stringify(INDEX_KEY),
  );

  if (VERIFY) {
    if (!matchingKey) {
      console.error(`  FAIL  index {productId, image} is missing`);
      process.exitCode = 1;
    } else if (!matchingKey.unique) {
      console.error(`  FAIL  index "${matchingKey.name}" exists but is NOT unique`);
      process.exitCode = 1;
    } else if (!matchingKey.partialFilterExpression) {
      console.error(`  FAIL  index "${matchingKey.name}" exists but has no partial filter`);
      process.exitCode = 1;
    } else {
      console.log(
        `  ok    ${matchingKey.name} is unique + partial (${JSON.stringify(
          matchingKey.partialFilterExpression,
        )})`,
      );
    }

    const groups = await duplicateGroups(collection);
    if (groups.length) {
      console.error(`  FAIL  ${groups.length} duplicate {productId, image} group(s) exist`);
      process.exitCode = 1;
    } else {
      console.log('  ok    no duplicate {productId, image} groups');
    }
    await mongoose.disconnect();
    return;
  }

  if (DROP_INDEX) {
    if (!matchingKey) {
      console.log('  index is absent — nothing to drop.');
    } else {
      await collection.dropIndex(matchingKey.name);
      console.log(`  dropped ${matchingKey.name}`);
    }
    await mongoose.disconnect();
    return;
  }

  if (CLEAR_LINKS) {
    const linked = await collection.countDocuments({ image: { $type: 'string' } });
    console.log(`  values with a linked image: ${linked}`);
    if (!CONFIRMED) {
      console.log('  dry run — pass --yes with --clear-links to clear every link');
    } else {
      const result = await collection.updateMany(
        { image: { $type: 'string' } },
        { $set: { image: null } },
      );
      console.log(`  cleared ${result.modifiedCount} link(s)`);
    }
    await mongoose.disconnect();
    return;
  }

  await normalizeImages(collection);

  if (matchingKey) {
    console.log(
      `  index already present: ${matchingKey.name}${matchingKey.unique ? ' (unique)' : ' (NOT unique)'}`,
    );
    await mongoose.disconnect();
    return;
  }

  const groups = await duplicateGroups(collection);
  if (groups.length) {
    console.error(
      `  FAIL  ${groups.length} duplicate {productId, image} group(s) block the unique index:`,
    );
    for (const group of groups.slice(0, 20)) {
      console.error(
        `    product ${group._id.productId} image "${group._id.image}" → ${group.count} values`,
      );
    }
    console.error('  clear the duplicates (the service moves/clears links) and re-run.');
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  if (APPLY) {
    await collection.createIndex(INDEX_KEY, INDEX_OPTIONS);
    console.log(`  created ${INDEX_NAME} (unique, partial)`);
  } else {
    console.log(`  would create ${INDEX_NAME} (unique, partial)`);
  }

  await mongoose.disconnect();
  console.log('\n[MIGRATE OPTION VALUE IMAGES] Done.');
}

main().catch(async (error) => {
  console.error('[MIGRATE OPTION VALUE IMAGES] FAILED');
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
