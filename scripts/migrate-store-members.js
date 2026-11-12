/**
 * Migration: backfill the Owner membership row for every store.
 *
 * For every store with a valid `vendorId`, upsert:
 *   { storeId, userId: vendorId, role: 'OWNER', status: 'active', joinedAt: store.createdAt }
 *
 * Idempotent. Stores with no/invalid `vendorId` are reported as explained skips; nothing is
 * invented and no existing data is deleted.
 *
 * Run:
 *   node scripts/migrate-store-members.js            (dry run, default)
 *   node scripts/migrate-store-members.js --apply    (write)
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const { Types } = mongoose;

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI environment variable is required');
  process.exit(1);
}

const apply = process.argv.includes('--apply');

function asObjectId(value) {
  if (value instanceof Types.ObjectId) return value;
  if (value && Types.ObjectId.isValid(String(value))) return new Types.ObjectId(String(value));
  return null;
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log(`[STORE MEMBERS] Connected. Apply: ${apply ? 'YES' : 'NO (dry run)'}`);

  const stores = await db.collection('stores').find({}).toArray();
  console.log(`[STORE MEMBERS] ${stores.length} stores found`);

  let planned = 0;
  let existing = 0;
  let skipped = 0;

  for (const store of stores) {
    const vendorId = asObjectId(store.vendorId);
    if (!vendorId) {
      skipped++;
      console.warn(
        `[STORE MEMBERS] SKIP store ${store._id}: ${store.vendorId ? 'invalid vendorId' : 'missing vendorId'}`,
      );
      continue;
    }

    const filter = { storeId: store._id, userId: vendorId };
    const current = await db.collection('storemembers').findOne(filter);
    if (current) {
      let changed = false;
      const patch = {};
      if (current.role !== 'OWNER') {
        patch.role = 'OWNER';
        changed = true;
      }
      if (current.status !== 'active') {
        patch.status = 'active';
        changed = true;
      }
      if (!current.joinedAt) {
        patch.joinedAt = store.createdAt ?? new Date();
        changed = true;
      }
      if (!changed) {
        existing++;
        continue;
      }
      if (apply) {
        await db.collection('storemembers').updateOne(filter, { $set: patch });
      }
      planned++;
      console.log(`[STORE MEMBERS] ${apply ? 'repaired' : 'would repair'} owner row for store ${store._id}`);
      continue;
    }

    planned++;
    if (!apply) {
      console.log(`[STORE MEMBERS] would create owner row for store ${store._id} (user ${vendorId})`);
      continue;
    }
    await db.collection('storemembers').insertOne({
      storeId: store._id,
      userId: vendorId,
      role: 'OWNER',
      permissionOverrides: [],
      status: 'active',
      joinedAt: store.createdAt ?? new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log(`[STORE MEMBERS] created owner row for store ${store._id} (user ${vendorId})`);
  }

  console.log(
    `[STORE MEMBERS] Done. ${apply ? 'created/repaired' : 'would create/repair'}: ${planned}, already present: ${existing}, skipped: ${skipped}`,
  );
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[STORE MEMBERS] FAILED:', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
