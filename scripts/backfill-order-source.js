/**
 * Migration: Backfill `source` on the `orders` collection.
 *
 * POS Phase 0 adds `source` (ONLINE | POS | MANUAL) to orders. New orders get it from the
 * server; existing documents have none. This script assigns a value to the pre-POS rows:
 *
 *   - `MANUAL` — the vendor dashboard's order form always writes `createdBy` (the vendor's
 *                email, or the literal 'Vendor'); the storefront never sets it.
 *   - `ONLINE` — everything else (guest and signed-in storefront checkouts).
 *
 * No row is ever labelled `POS`: no POS sale existed before this migration.
 *
 * Algorithm (idempotent — only touches rows missing `source`):
 *   1. Count orders missing `source`.
 *   2. Assign MANUAL where `createdBy` is a non-empty string, ONLINE otherwise.
 *   3. Reprint the final distribution.
 *
 * Run:
 *   node scripts/backfill-order-source.js [--dry-run]
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

const MISSING = { $or: [{ source: { $exists: false } }, { source: null }] };
const HAS_CREATED_BY = { createdBy: { $type: 'string', $ne: '' } };
const NO_CREATED_BY = {
  $or: [
    { createdBy: { $exists: false } },
    { createdBy: null },
    { createdBy: '' },
  ],
};

async function distribution(col) {
  const rows = await col
    .aggregate([{ $group: { _id: '$source', count: { $sum: 1 } } }, { $sort: { _id: 1 } }])
    .toArray();
  return rows.map((r) => `${r._id ?? '(unset)'}=${r.count}`).join(', ') || '(none)';
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const col = db.collection('orders');

  console.log(`[ORDER-SOURCE BACKFILL] Connected. Dry run: ${isDryRun ? 'YES' : 'NO'}`);

  const total = await col.countDocuments({});
  const missing = await col.countDocuments(MISSING);
  console.log(`[ORDER-SOURCE BACKFILL] orders=${total}, missing source=${missing}`);

  if (missing === 0) {
    console.log(`[ORDER-SOURCE BACKFILL] Nothing to do. Distribution: ${await distribution(col)}`);
    await mongoose.disconnect();
    return;
  }

  const manual = await col.countDocuments({ $and: [MISSING, HAS_CREATED_BY] });
  const online = await col.countDocuments({ $and: [MISSING, NO_CREATED_BY] });
  console.log(`[ORDER-SOURCE BACKFILL] plan: MANUAL=${manual}, ONLINE=${online}`);

  if (isDryRun) {
    console.log('[ORDER-SOURCE BACKFILL] DRY RUN COMPLETE (nothing written)');
    await mongoose.disconnect();
    return;
  }

  const manualRes = await col.updateMany(
    { $and: [MISSING, HAS_CREATED_BY] },
    { $set: { source: 'MANUAL' } },
  );
  const onlineRes = await col.updateMany(
    { $and: [MISSING, NO_CREATED_BY] },
    { $set: { source: 'ONLINE' } },
  );

  console.log(
    `[ORDER-SOURCE BACKFILL] updated: MANUAL=${manualRes.modifiedCount}, ONLINE=${onlineRes.modifiedCount}`,
  );

  const remaining = await col.countDocuments(MISSING);
  if (remaining > 0) {
    console.error(`[ORDER-SOURCE BACKFILL] FAILED: ${remaining} order(s) still missing source`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`[ORDER-SOURCE BACKFILL] COMPLETE. Distribution: ${await distribution(col)}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
