/**
 * Migration: Backfill `storeId` (ObjectId, ref: Store) for seller-scoped collections.
 *
 * Collections migrated:
 * - products
 * - orders
 * - deliveryfees
 * - deliveryconfigs
 * - deliveryattributions
 * - trackingconfigs
 *
 * Algorithm:
 * 1. Build maps email -> store._id and vendorId -> store._id from `stores`
 * 2. For each document missing storeId, resolve via vendorId (immutable) then vendorEmail
 * 3. Batch update with bulkWrite (500 per batch)
 *
 * Run:
 *   node scripts/migrate-store-id.js [--dry-run] [--allow-unresolved]
 *
 * --dry-run          Count and report, write nothing.
 * --allow-unresolved Skip G2 (continue when some docs have no resolvable store).
 *                    Intended for known test-data orphans; each skipped doc is logged.
 *
 * BEFORE RUNNING: take a MongoDB backup. G1-G5 in PLAN_STORE_ID_MIGRATION.md must pass.
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
const allowUnresolved = process.argv.includes('--allow-unresolved');

const COLLECTIONS = [
  { name: 'products', setStoreId: 'storeId' },
  { name: 'orders', setStoreId: 'storeId' },
  { name: 'deliveryfees', setStoreId: 'storeId' },
  { name: 'deliveryconfigs', setStoreId: 'storeId' },
  { name: 'deliveryattributions', setStoreId: 'storeId' },
  { name: 'trackingconfigs', setStoreId: 'storeId' },
];

function toObjectId(id) {
  if (id instanceof Types.ObjectId) return id;
  if (id && Types.ObjectId.isValid(String(id))) return new Types.ObjectId(String(id));
  return null;
}

function asString(val) {
  if (val === null || val === undefined) return null;
  return String(val);
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log(`[STORE-ID MIGRATION] Connected. Dry run: ${isDryRun ? 'YES' : 'NO'}`);
  const collectionNames = (await db.listCollections().toArray()).map(c => c.name);
  console.log('[STORE-ID MIGRATION] Collections:', collectionNames.join(', '));

  // Gate G1: Build maps from stores
  const stores = await db.collection('stores').find({}).toArray();
  console.log(`[STORE-ID MIGRATION] Found ${stores.length} stores`);
  const emailToStoreId = new Map();
  const vendorIdToStoreId = new Map();

  let missingEmail = 0;
  for (const s of stores) {
    const email = asString(s.vendorEmail)?.toLowerCase();
    const vId = asString(s.vendorId);
    if (!email) {
      missingEmail++;
      console.warn(`[WARN] Store ${s._id} is missing vendorEmail`);
    } else {
      emailToStoreId.set(email, s._id);
    }
    if (vId) {
      vendorIdToStoreId.set(vId, s._id);
    }
  }

  if (missingEmail > 0) {
    console.error(`[GATE G1 FAILED] ${missingEmail} stores missing vendorEmail`);
    await mongoose.disconnect();
    process.exit(1);
  }

  // Gate G1 pass
  console.log('[GATE G1] All stores have resolvable vendorEmail');

  let totalMigrated = 0;
  let totalUnresolved = 0;
  const globalUnresolved = [];

  for (const cfg of COLLECTIONS) {
    if (!collectionNames.includes(cfg.name)) {
      console.log(`[SKIP] Collection ${cfg.name} does not exist`);
      continue;
    }
    const col = db.collection(cfg.name);
    const cursor = col.find({
      $or: [
        { [cfg.setStoreId]: { $exists: false } },
        { [cfg.setStoreId]: null },
      ],
    });
    const stats = { migrated: 0, unresolved: 0 };
    const unresolvedSample = [];
    let batch = [];
    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      const vId = asString(doc.vendorId);
      const email = asString(doc.vendorEmail)?.toLowerCase();
      let storeId = null;
      if (vId && vendorIdToStoreId.has(vId)) {
        storeId = vendorIdToStoreId.get(vId);
      } else if (email && emailToStoreId.has(email)) {
        storeId = emailToStoreId.get(email);
      }

      if (!storeId) {
        stats.unresolved++;
        if (unresolvedSample.length < 50) {
          unresolvedSample.push({
            collection: cfg.name,
            _id: doc._id,
            vendorEmail: doc.vendorEmail,
            vendorId: doc.vendorId,
          });
        }
        continue;
      }

      batch.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { [cfg.setStoreId]: toObjectId(storeId) } },
        },
      });

      if (batch.length >= 500) {
        if (!isDryRun) {
          const res = await col.bulkWrite(batch);
          stats.migrated += res.modifiedCount;
        } else {
          stats.migrated += batch.length;
        }
        batch = [];
      }
    }
    if (batch.length > 0) {
      if (!isDryRun) {
        const res = await col.bulkWrite(batch);
        stats.migrated += res.modifiedCount;
      } else {
        stats.migrated += batch.length;
      }
    }
    console.log(`[${cfg.name}] Migrated: ${stats.migrated}, Unresolved: ${stats.unresolved}`);
    if (unresolvedSample.length > 0) {
      console.log(`  Unresolved sample:`, unresolvedSample);
    }
    totalMigrated += stats.migrated;
    totalUnresolved += stats.unresolved;
    globalUnresolved.push(...unresolvedSample);
  }

  console.log(`\n[STORE-ID MIGRATION] TOTAL Migrated: ${totalMigrated}, Unresolved: ${totalUnresolved}`);

  if (totalUnresolved > 0) {
    console.error(`[GATE G2] ${totalUnresolved} document(s) have no resolvable store:`);
    for (const u of globalUnresolved) {
      console.error(`  - ${u.collection || ''} _id=${u._id} vendorEmail=${u.vendorEmail} vendorId=${u.vendorId}`);
    }
    if (!allowUnresolved) {
      console.error('[GATE G2 FAILED] Re-run with --allow-unresolved to migrate the rest anyway.');
      await mongoose.disconnect();
      process.exit(1);
    }
    console.warn('[GATE G2 WAIVED] Continuing due to --allow-unresolved. These docs keep storeId=null');
    console.warn('                 and will not be served once Phase 2 authorization goes live.');
  } else {
    console.log('[GATE G2] All documents resolved to a store');
  }
  console.log(`[STORE-ID MIGRATION] ${isDryRun ? 'DRY RUN COMPLETE' : 'COMPLETE'}`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
