require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Delivery status sync — index migration for the provider-neutral record key.
 *
 * Phase E1 changed the parcel-status identity from `(storeId, parcelId)` to
 * `(storeId, companyId, parcelId)`, so a store can follow the same carrier parcel id across
 * two providers. Existing databases still carry the old **unique** index, which would reject
 * the second provider's record even though the code no longer queries it.
 *
 * This script:
 *   1. verifies the new unique index exists (creates it if it does not);
 *   2. drops the legacy unique `{storeId, parcelId}` index;
 *   3. never touches a record.
 *
 * Dry-run by default. Run with `--apply` to change the live database.
 *
 * Run: node scripts/migrate-delivery-status-indexes.js [--apply]
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

const COLLECTION = 'deliveryparcelstatuses';
const TARGET_KEY = { storeId: 1, companyId: 1, parcelId: 1 };
const TARGET_OPTIONS = { unique: true, name: 'storeId_1_companyId_1_parcelId_1' };

const LEGACY_KEYS = new Set([
  JSON.stringify({ storeId: 1, parcelId: 1 }),
  JSON.stringify({ storeId: 1, parcelId: -1 }),
]);

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const collection = db.collection(COLLECTION);

  console.log(`[MIGRATE DELIVERY STATUS INDEXES] ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const existingCollections = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name),
  );

  if (!existingCollections.has(COLLECTION)) {
    console.log(`  ${COLLECTION} does not exist yet — the schema will create every index on first write.`);
    await mongoose.disconnect();
    return;
  }

  const indexes = await collection.indexes();
  const target = indexes.find(
    (index) => JSON.stringify(index.key) === JSON.stringify(TARGET_KEY),
  );
  const legacy = indexes.find((index) => LEGACY_KEYS.has(JSON.stringify(index.key)));

  if (target) {
    console.log(
      `  target index exists: ${target.name} ${JSON.stringify(target.key)}${target.unique ? ' (unique)' : ' (NOT unique)'}`,
    );
    if (!target.unique) {
      console.error('  the target index is not unique — refusing to drop the legacy index.');
      process.exit(1);
    }
  } else {
    console.log(`  target index is missing: ${JSON.stringify(TARGET_KEY)}`);
    if (APPLY) {
      await collection.createIndex(TARGET_KEY, TARGET_OPTIONS);
      console.log(`  created ${TARGET_OPTIONS.name} (unique)`);
    } else {
      console.log(`  would create ${TARGET_OPTIONS.name} (unique)`);
    }
  }

  if (!legacy) {
    console.log('  legacy {storeId, parcelId} index: absent — nothing to drop.');
    await mongoose.disconnect();
    return;
  }

  console.log(`  legacy index found: ${legacy.name} ${JSON.stringify(legacy.key)}${legacy.unique ? ' (unique)' : ''}`);
  if (APPLY) {
    await collection.dropIndex(legacy.name);
    console.log(`  dropped ${legacy.name}`);
  } else {
    console.log(`  would drop ${legacy.name}`);
  }

  await mongoose.disconnect();
  console.log('\n[MIGRATE DELIVERY STATUS INDEXES] Done.');
}

main().catch(async (error) => {
  console.error('[MIGRATE DELIVERY STATUS INDEXES] FAILED');
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
