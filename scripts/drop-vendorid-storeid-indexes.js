require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Drop the bogus unique `{vendorId, storeId}` indexes from `products` and `orders`.
 *
 * The index allows only one document per store, but both collections hold many documents
 * per store. Neither collection populates `vendorId` on create, so every document indexes
 * under the same key `{vendorId: null, storeId}` and the second insert fails with E11000
 * (the product-creation 500).
 *
 * Mongoose only creates indexes declared on a schema; it never drops an index that is no
 * longer declared. Removing the schema line therefore needs this one-off cleanup too.
 *
 * Dry-run by default. Run with `--apply` to change the live database.
 *
 * Run: node scripts/drop-vendorid-storeid-indexes.js [--apply]
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const COLLECTIONS = ['products', 'orders'];
const TARGET_KEY = JSON.stringify({ vendorId: 1, storeId: 1 });

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log(`[DROP VENDORID+STOREID INDEXES] ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name),
  );

  let dropped = 0;

  for (const name of COLLECTIONS) {
    if (!existing.has(name)) {
      console.log(`  ${name}: collection does not exist - skip`);
      continue;
    }

    const collection = db.collection(name);
    const indexes = await collection.indexes();
    const targets = indexes.filter(
      (index) => JSON.stringify(index.key) === TARGET_KEY,
    );

    if (targets.length === 0) {
      console.log(`  ${name}: no {vendorId, storeId} index - nothing to drop`);
      continue;
    }

    for (const index of targets) {
      if (APPLY) {
        await collection.dropIndex(index.name);
        console.log(`  ${name}: dropped ${index.name}${index.unique ? ' (unique)' : ''}`);
        dropped += 1;
      } else {
        console.log(
          `  ${name}: would drop ${index.name}${index.unique ? ' (unique)' : ''}`,
        );
      }
    }
  }

  await mongoose.disconnect();

  if (APPLY) {
    console.log(`\n[DROP VENDORID+STOREID INDEXES] Done. Dropped ${dropped} index(es).`);
  } else {
    console.log(
      '\n[DROP VENDORID+STOREID INDEXES] Dry run complete. Re-run with --apply to drop.',
    );
  }
}

main().catch(async (error) => {
  console.error('[DROP VENDORID+STOREID INDEXES] FAILED');
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
