/**
 * Migration: Backfill `items[].lineId` on every existing order.
 *
 * Why: inventory reservations reference an order line. `(orderId, variantId)` is
 * ambiguous when the same variant appears on two lines, so each line needs its own
 * stable identifier. `lineId` is that identifier.
 *
 * Algorithm:
 * 1. Read orders that have at least one item missing `lineId`
 * 2. For each order, generate one `lineId` per item that lacks one (existing ids kept)
 * 3. Write the whole `items` array back with `$set`
 *
 * Idempotent: a second run finds nothing to do. Orders with no items are skipped.
 * Historical documents are only ever *added to* - `lineId` is optional, so an order
 * that is never migrated still reads fine.
 *
 * Run:
 *   node scripts/backfill-order-item-line-ids.js [--dry-run]
 *
 * --dry-run   Count and report, write nothing.
 *
 * BEFORE RUNNING: take a MongoDB backup.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const { Types } = mongoose;

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI environment variable is required');
  process.exit(1);
}

const isDryRun = process.argv.includes('--dry-run');

/**
 * A line id only has to be unique and stable within its order. A random hex string
 * is enough and avoids a second round trip to allocate sequence numbers.
 */
function generateLineId() {
  return new Types.ObjectId().toHexString();
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log(`[LINE-ID BACKFILL] Connected. Dry run: ${isDryRun ? 'YES' : 'NO'}`);

  // `items.lineId: null` also matches documents where items exist but the field was
  // never written, which is exactly the set we need to repair.
  const orders = await db
    .collection('orders')
    .find({ 'items': { $exists: true, $ne: [] }, 'items.lineId': null })
    .toArray();

  console.log(`[LINE-ID BACKFILL] Orders needing at least one lineId: ${orders.length}`);

  if (orders.length === 0) {
    console.log('[LINE-ID BACKFILL] Nothing to do. Exiting.');
    await mongoose.disconnect();
    return;
  }

  const writes = [];
  let linesAssigned = 0;

  for (const order of orders) {
    if (!Array.isArray(order.items)) continue;

    const items = order.items.map((item) => {
      if (item && item.lineId) return item;
      linesAssigned += 1;
      return { ...item, lineId: generateLineId() };
    });

    writes.push({
      updateOne: {
        filter: { _id: order._id },
        update: { $set: { items } },
      },
    });
  }

  console.log(`[LINE-ID BACKFILL] Lines to assign: ${linesAssigned}`);
  console.log(`[LINE-ID BACKFILL] Orders to update: ${writes.length}`);

  if (isDryRun) {
    console.log('[LINE-ID BACKFILL] DRY RUN - nothing written.');
  } else {
    let modifiedCount = 0;
    for (let i = 0; i < writes.length; i += 500) {
      const result = await db.collection('orders').bulkWrite(writes.slice(i, i + 500));
      modifiedCount += result.modifiedCount || 0;
    }
    console.log(`[LINE-ID BACKFILL] Orders modified: ${modifiedCount}`);
  }

  // Post-check: anything still missing is either not an array or not migratable.
  const remaining = await db
    .collection('orders')
    .countDocuments({ 'items': { $exists: true, $ne: [] }, 'items.lineId': null });
  console.log(`[LINE-ID BACKFILL] Orders still missing a lineId: ${remaining}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[LINE-ID BACKFILL] FAILED:', err);
  process.exit(1);
});