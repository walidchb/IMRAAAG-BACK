require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Plans & Subscriptions — index migration.
 *
 * Creates the indexes the subscription read/write paths depend on. Never touches a document and
 * is idempotent. Dry-run by default; `--apply` changes the DB.
 *
 * Run: node scripts/migrate-subscription-indexes.js [--apply]
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

const COLLECTIONS = {
  plans: [
    { keys: { nameKey: 1 }, options: { unique: true, name: 'nameKey_1' } },
    {
      keys: { code: 1 },
      options: {
        unique: true,
        name: 'code_1',
        partialFilterExpression: { code: { $type: 'string' } },
      },
    },
    { keys: { isActive: 1, createdAt: -1 }, options: { name: 'isActive_1_createdAt_-1' } },
    {
      keys: { isDefaultForSignup: 1 },
      options: {
        unique: true,
        name: 'isDefaultForSignup_1',
        partialFilterExpression: { isDefaultForSignup: true, isActive: true },
      },
    },
  ],
  subscriptions: [
    { keys: { storeId: 1 }, options: { unique: true, name: 'storeId_1' } },
    { keys: { status: 1, endDate: 1 }, options: { name: 'status_1_endDate_1' } },
    { keys: { planId: 1, status: 1 }, options: { name: 'planId_1_status_1' } },
    { keys: { endDate: 1 }, options: { name: 'endDate_1' } },
  ],
  subscriptionevents: [
    { keys: { storeId: 1, createdAt: -1 }, options: { name: 'storeId_1_createdAt_-1' } },
    {
      keys: { subscriptionId: 1, createdAt: -1 },
      options: { name: 'subscriptionId_1_createdAt_-1' },
    },
    { keys: { planId: 1, createdAt: -1 }, options: { name: 'planId_1_createdAt_-1' } },
  ],
};

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log(`[MIGRATE SUBSCRIPTION INDEXES] ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const existingCollections = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name),
  );

  for (const [name, indexes] of Object.entries(COLLECTIONS)) {
    console.log(`collection ${name}`);
    if (!existingCollections.has(name)) {
      if (APPLY) {
        await db.createCollection(name);
        console.log('  created collection');
      } else {
        console.log('  (would be created)');
      }
    }
    const collection = db.collection(name);
    const current = existingCollections.has(name) ? await collection.indexes() : [];
    const currentNames = new Set(current.map((index) => index.name));
    for (const { keys, options } of indexes) {
      if (currentNames.has(options.name)) {
        console.log(`  index ${options.name} already present`);
        continue;
      }
      if (APPLY) {
        await collection.createIndex(keys, options);
        console.log(`  created index ${options.name}`);
      } else {
        console.log(`  would create index ${options.name}`);
      }
    }
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('[MIGRATE SUBSCRIPTION INDEXES] failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
