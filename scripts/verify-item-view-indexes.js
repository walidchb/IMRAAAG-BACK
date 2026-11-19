require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Product & Box view analytics — read-only index/consistency verifier.
 *
 * The write path depends on the unique `(storeId, itemType, itemId, dayStart, visitorHash)`
 * index as both the dedupe key and the first-insert concurrency guard. The read path depends
 * on the store-prefixed range index. Without them the upsert race can create duplicate rows
 * (inflating totals/uniques) and aggregations scan more documents than necessary.
 *
 * This script never writes and exits 1 on any violation, so it can gate a deployment.
 *
 * Run: node scripts/verify-item-view-indexes.js
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const COLLECTION = 'itemviewdaily';
const UNIQUE_KEYS = {
  storeId: 1,
  itemType: 1,
  itemId: 1,
  dayStart: 1,
  visitorHash: 1,
};
const RANGE_KEYS = {
  storeId: 1,
  dayStart: 1,
  itemType: 1,
  itemId: 1,
  visitorHash: 1,
};

const violations = [];
function fail(rule, detail) {
  violations.push({ rule, detail });
  console.log(`  FAIL  [${rule}] ${detail}`);
}
function ok(rule, message) {
  console.log(`  ok    [${rule}] ${message}`);
}

function keyShape(index) {
  return Object.fromEntries(
    Object.entries(index.key || {}).filter(([name]) => name !== '_id'),
  );
}

function sameKeys(actual, expected) {
  const a = keyShape({ key: actual });
  const b = expected;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return bKeys.every((key) => a[key] === b[key]);
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log('[VERIFY ITEM VIEW INDEXES]\n');

  const exists = (
    await db.listCollections({ name: COLLECTION }, { nameOnly: true }).toArray()
  ).length > 0;

  if (!exists) {
    fail(
      'collection',
      `${COLLECTION} does not exist; run scripts/migrate-item-view-indexes.js --apply`,
    );
  } else {
    ok('collection', `${COLLECTION} exists`);
    const collection = db.collection(COLLECTION);
    const indexes = await collection.indexes();

    const unique = indexes.find(
      (index) => index.unique === true && sameKeys(index.key, UNIQUE_KEYS),
    );
    if (!unique) {
      fail(
        'unique-index',
        `missing UNIQUE index ${JSON.stringify(UNIQUE_KEYS)}; run scripts/migrate-item-view-indexes.js --apply`,
      );
    } else {
      ok('unique-index', `${unique.name} UNIQUE`);
    }

    const range = indexes.find((index) => sameKeys(index.key, RANGE_KEYS));
    if (!range) {
      fail(
        'range-index',
        `missing range index ${JSON.stringify(RANGE_KEYS)}; run scripts/migrate-item-view-indexes.js --apply`,
      );
    } else {
      ok('range-index', range.name);
    }

    if (unique) {
      const [duplicates] = await collection
        .aggregate(
          [
            {
              $group: {
                _id: {
                  storeId: '$storeId',
                  itemType: '$itemType',
                  itemId: '$itemId',
                  dayStart: '$dayStart',
                  visitorHash: '$visitorHash',
                },
                count: { $sum: 1 },
              },
            },
            { $match: { count: { $gt: 1 } } },
            { $limit: 1 },
          ],
          { allowDiskUse: true },
        )
        .toArray();

      if (duplicates) {
        fail(
          'duplicate-keys',
          'at least one duplicate dedupe key exists; inspect before enabling analytics',
        );
      } else {
        ok('duplicate-keys', 'no duplicate dedupe keys');
      }
    }
  }

  console.log('');
  if (violations.length > 0) {
    console.log(`Result: FAILED (${violations.length} violation(s))`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('Result: OK');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('[VERIFY ITEM VIEW INDEXES] failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
