/**
 * Migration: Remove the legacy product `status` field.
 *
 * Product visibility is now a single boolean, `published` (true = shown to customers,
 * false = hidden / "draft"). The old `status: 'Active' | 'Draft'` field was removed from
 * the Mongoose schema and from every query, DTO and UI. This script cleans the live data:
 *
 *   1. `$unset`s `status` on every product that still carries it (idempotent).
 *   2. Drops the now-dead indexes that were built around `status` (the schema no longer
 *      declares them; Mongoose will build the new `published`-only indexes on next boot).
 *
 * No product becomes visible or invisible as a result: visibility was already governed by
 * `published` before this change, and was never derived from `status` on the storefront.
 *
 * Run:
 *   node scripts/remove-product-status.js [--dry-run]
 *
 * BEFORE RUNNING: take a MongoDB backup.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI environment variable is required');
  process.exit(1);
}

const isDryRun = process.argv.includes('--dry-run');

const HAS_STATUS = { status: { $exists: true } };

// Indexes that referenced `status`. Keyed by their key spec so we don't depend on the
// auto-generated index name.
const STALE_INDEXES = [
  { status: 1 },
  { published: 1, status: 1, createdAt: -1, _id: -1 },
  { published: 1, status: 1, category: 1, createdAt: -1, _id: -1 },
  { published: 1, status: 1, vendorEmail: 1, createdAt: -1, _id: -1 },
  { published: 1, status: 1, storeId: 1, createdAt: -1, _id: -1 },
  { published: 1, status: 1, price: 1, createdAt: -1, _id: -1 },
];

async function statusDistribution(col) {
  const rows = await col
    .aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }, { $sort: { _id: 1 } }])
    .toArray();
  return rows.map((r) => `${r._id ?? '(unset)'}=${r.count}`).join(', ') || '(none)';
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const col = db.collection('products');

  console.log(`[REMOVE-PRODUCT-STATUS] Connected. Dry run: ${isDryRun ? 'YES' : 'NO'}`);

  const total = await col.countDocuments({});
  const withStatus = await col.countDocuments(HAS_STATUS);
  console.log(`[REMOVE-PRODUCT-STATUS] products=${total}, with status=${withStatus}`);
  console.log(`[REMOVE-PRODUCT-STATUS] current status distribution: ${await statusDistribution(col)}`);

  if (withStatus === 0) {
    console.log('[REMOVE-PRODUCT-STATUS] No product carries `status` — data already clean.');
  }

  if (isDryRun) {
    console.log(
      `[REMOVE-PRODUCT-STATUS] would unset status on ${withStatus} product(s) and drop ${STALE_INDEXES.length} stale index spec(s).`,
    );
    console.log('[REMOVE-PRODUCT-STATUS] DRY RUN COMPLETE (nothing written)');
    await mongoose.disconnect();
    return;
  }

  if (withStatus > 0) {
    const res = await col.updateMany(HAS_STATUS, { $unset: { status: '' } });
    console.log(`[REMOVE-PRODUCT-STATUS] unset status on ${res.modifiedCount} product(s)`);
  }

  for (const spec of STALE_INDEXES) {
    try {
      await col.dropIndex(spec);
      console.log(`[REMOVE-PRODUCT-STATUS] dropped index ${JSON.stringify(spec)}`);
    } catch (err) {
      if (err && err.codeName === 'IndexNotFound') {
        console.log(`[REMOVE-PRODUCT-STATUS] index absent (ok): ${JSON.stringify(spec)}`);
      } else {
        throw err;
      }
    }
  }

  const remaining = await col.countDocuments(HAS_STATUS);
  if (remaining > 0) {
    console.error(`[REMOVE-PRODUCT-STATUS] FAILED: ${remaining} product(s) still carry status`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`[REMOVE-PRODUCT-STATUS] COMPLETE. Distribution: ${await statusDistribution(col)}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
