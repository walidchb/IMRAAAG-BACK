require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Product & Box view analytics — index migration.
 *
 * Creates the two `itemviewdaily` indexes the read/write paths depend on:
 *   1. `{storeId, itemType, itemId, dayStart, visitorHash}` UNIQUE — dedupe key + concurrency guard.
 *   2. `{storeId, dayStart, itemType, itemId, visitorHash}`       — all-items range/summary scans.
 *
 * It never touches a document and is idempotent. Dry-run by default; `--apply` changes the DB.
 *
 * Run: node scripts/migrate-item-view-indexes.js [--apply]
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const COLLECTION = 'itemviewdaily';

const INDEXES = [
  {
    keys: { storeId: 1, itemType: 1, itemId: 1, dayStart: 1, visitorHash: 1 },
    options: {
      unique: true,
      name: 'storeId_1_itemType_1_itemId_1_dayStart_1_visitorHash_1',
    },
  },
  {
    keys: { storeId: 1, dayStart: 1, itemType: 1, itemId: 1, visitorHash: 1 },
    options: { name: 'storeId_1_dayStart_1_itemType_1_itemId_1_visitorHash_1' },
  },
];

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log(`[MIGRATE ITEM VIEW INDEXES] ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const existingCollections = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name),
  );

  if (!existingCollections.has(COLLECTION)) {
    if (APPLY) {
      await db.createCollection(COLLECTION);
      console.log(`created collection ${COLLECTION}`);
    } else {
      console.log(`collection ${COLLECTION} does not exist (would be created)`);
    }
  }

  const collection = db.collection(COLLECTION);
  const current = existingCollections.has(COLLECTION)
    ? await collection.indexes()
    : [];
  const currentNames = new Set(current.map((index) => index.name));

  for (const { keys, options } of INDEXES) {
    if (currentNames.has(options.name)) {
      console.log(`index ${options.name} already present`);
      continue;
    }
    if (APPLY) {
      await collection.createIndex(keys, options);
      console.log(`created index ${options.name}`);
    } else {
      console.log(`would create index ${options.name}`);
    }
  }

  if (APPLY) {
    const applied = await collection.indexes();
    console.log('\nindexes now:');
    for (const index of applied) {
      console.log(`  ${index.name} ${JSON.stringify(index.key)}${index.unique ? ' UNIQUE' : ''}`);
    }
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('[MIGRATE ITEM VIEW INDEXES] failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
