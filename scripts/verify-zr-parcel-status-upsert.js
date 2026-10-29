require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * ZR Express status sync, Phase 2 — live concurrent-upsert verification.
 *
 * Task 2.5 asks for the *unique index* to be verified under a concurrent upsert (§13.4), and
 * §13.1 asks for the timeline to be idempotent by the carrier's history-entry id. Both are
 * claims about MongoDB's behaviour, not about a mock, so this script exercises them against
 * the real database.
 *
 * It writes only to a scratch namespace — a freshly generated `storeId` that no real store can
 * have — and deletes everything it created before it exits. It never touches a real parcel
 * record.
 *
 * Requires `npm run build` first: the indexes are read from the **compiled** schema, so the
 * script proves the indexes the application actually declares.
 *
 * Run: node scripts/verify-zr-parcel-status-upsert.js
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const CONCURRENCY = 20;

let DeliveryParcelStatusSchema;
try {
  ({ DeliveryParcelStatusSchema } = require('../dist/modules/delivery/schemas/delivery-parcel-status.schema'));
} catch (error) {
  console.error('Could not load the compiled schema. Run `npm run build` first.');
  console.error(error.message);
  process.exit(1);
}
const violations = [];

function report(rule, detail) {
  violations.push({ rule, detail });
  console.log(`  FAIL  [${rule}] ${detail}`);
}
function ok(rule, msg) {
  console.log(`  ok    [${rule}] ${msg}`);
}

/** The same write the application performs (§13.4). */
async function upsertStatus(collection, storeId, parcelId) {
  return collection.findOneAndUpdate(
    { storeId, parcelId },
    {
      $set: {
        companyId: 'zr-express',
        deliveryStatus: 'with_courier',
        carrierStateName: 'sortie_en_livraison',
        syncState: 'synced',
        lastPolledAt: new Date(),
        consecutiveFailures: 0,
        terminal: false,
      },
      $setOnInsert: {
        storeId,
        parcelId,
        orderId: new mongoose.Types.ObjectId(),
        timeline: [],
        timelineTruncated: false,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

/** The same guarded push the application performs (§13.1). */
async function appendTimelineEntry(collection, storeId, parcelId, providerEntryId) {
  return collection.findOneAndUpdate(
    { storeId, parcelId, 'timeline.providerEntryId': { $ne: providerEntryId } },
    {
      $push: {
        timeline: {
          providerEntryId,
          toState: 'sortie_en_livraison',
          at: new Date(),
          situations: [],
        },
      },
    },
    { new: true },
  );
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const collection = db.collection('deliveryparcelstatuses');

  console.log('[VERIFY ZR PARCEL STATUS UPSERT] Connected.\n');

  // 0. Create the collection and its indexes exactly as the application would. The app does
  //    this on boot through Mongoose's autoIndex; doing it here keeps the script independent of
  //    a running server and proves the *declared* indexes are the ones MongoDB ends up with.
  const model = mongoose.models.DeliveryParcelStatus
    ? mongoose.models.DeliveryParcelStatus
    : mongoose.model('DeliveryParcelStatus', DeliveryParcelStatusSchema);
  await model.createIndexes();

  // 1. The indexes the application declares must exist on the real collection.
  const declared = DeliveryParcelStatusSchema.indexes();
  const existing = await collection.indexes();
  const existingKeys = new Set(existing.map((index) => JSON.stringify(index.key)));

  for (const [keys, options] of declared) {
    const key = JSON.stringify(keys);
    if (!existingKeys.has(key)) {
      report('index-present', `the collection is missing the declared index ${key}`);
      continue;
    }
    const found = existing.find((index) => JSON.stringify(index.key) === key);
    if (options?.unique && !found.unique) {
      report('index-unique', `the index ${key} is not unique on the live collection`);
      continue;
    }
    ok('index-present', `${key}${options?.unique ? ' (unique)' : ''}`);
  }

  const storeId = new mongoose.Types.ObjectId();
  const parcelId = `verify-parcel-${Date.now()}`;

  try {
    // 2. A concurrent upsert must produce exactly one record.
    await Promise.all(
      Array.from({ length: CONCURRENCY }, () => upsertStatus(collection, storeId, parcelId)),
    );

    const records = await collection.find({ storeId, parcelId }).toArray();
    if (records.length !== 1) {
      report(
        'concurrent-upsert',
        `${CONCURRENCY} concurrent upserts produced ${records.length} records — expected 1`,
      );
    } else {
      ok('concurrent-upsert', `${CONCURRENCY} concurrent upserts produced exactly 1 record`);
    }

    // 3. The same timeline entry pushed concurrently must be stored once (§13.1).
    await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        appendTimelineEntry(collection, storeId, parcelId, 'entry-same'),
      ),
    );

    let record = await collection.findOne({ storeId, parcelId });
    const sameIds = record.timeline.map((entry) => entry.providerEntryId);
    if (sameIds.filter((id) => id === 'entry-same').length !== 1) {
      report(
        'timeline-idempotent',
        `the same timeline entry was stored ${sameIds.filter((id) => id === 'entry-same').length} times — expected 1`,
      );
    } else {
      ok('timeline-idempotent', 'the same timeline entry was stored exactly once');
    }

    // 4. Distinct entries pushed concurrently must all survive, exactly once each.
    const distinctIds = Array.from({ length: CONCURRENCY }, (_, index) => `entry-${index}`);
    await Promise.all(
      distinctIds.map((id) => appendTimelineEntry(collection, storeId, parcelId, id)),
    );

    record = await collection.findOne({ storeId, parcelId });
    const storedIds = record.timeline.map((entry) => entry.providerEntryId);
    const uniqueIds = new Set(storedIds);
    if (uniqueIds.size !== storedIds.length) {
      report('timeline-unique', `the timeline holds duplicate entry ids: ${storedIds.length - uniqueIds.size}`);
    } else if (!distinctIds.every((id) => uniqueIds.has(id))) {
      report('timeline-unique', 'some concurrently pushed timeline entries were lost');
    } else {
      ok(
        'timeline-unique',
        `${distinctIds.length} concurrently pushed entries were stored exactly once each`,
      );
    }

    // 5. The record must belong to the store that wrote it.
    if (String(record.storeId) !== String(storeId)) {
      report('tenancy', 'the record is not owned by the store that wrote it');
    } else {
      ok('tenancy', 'the record is owned by the store that wrote it');
    }
  } finally {
    const removed = await collection.deleteMany({ storeId, parcelId });
    console.log(`\n  cleanup: removed ${removed.deletedCount} scratch record(s)`);
    await mongoose.disconnect();
  }

  if (violations.length > 0) {
    console.log(`\n[VERIFY ZR PARCEL STATUS UPSERT] FAILED — ${violations.length} violation(s)`);
    process.exit(1);
  }

  console.log('\n[VERIFY ZR PARCEL STATUS UPSERT] OK — all checks passed');
}

main().catch((error) => {
  console.error('[VERIFY ZR PARCEL STATUS UPSERT] FAILED');
  console.error(error);
  process.exit(1);
});
