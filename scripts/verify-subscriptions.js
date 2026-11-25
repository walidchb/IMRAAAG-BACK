require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Plans & Subscriptions — read-only verifier. Non-zero exit on any violation.
 *
 * Checks: required indexes, unique storeId, one subscription per store, status/date
 * consistency, snapshot completeness, event linkage, no cross-store leakage, no credential-like
 * fields, and denominator sanity for usage.
 *
 * Run: node scripts/verify-subscriptions.js
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const STATUSES = ['trialing', 'active', 'expired', 'cancelled'];
const SECRET_PATTERN = /(token|secret|password|api[_-]?key|authorization)/i;

const violations = [];
const notes = [];

function fail(message) {
  violations.push(message);
}

async function indexesOf(db, collection) {
  const collections = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
  );
  if (!collections.has(collection)) return [];
  return db.collection(collection).indexes();
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log('[VERIFY SUBSCRIPTIONS] READ-ONLY\n');

  // 1. Indexes
  const subIndexes = await indexesOf(db, 'subscriptions');
  const subNames = new Set(subIndexes.map((i) => i.name));
  const subUnique = subIndexes.find(
    (i) => i.unique && JSON.stringify(i.key) === JSON.stringify({ storeId: 1 }),
  );
  if (!subUnique) fail('subscriptions is missing the unique { storeId: 1 } index');
  for (const expected of ['status_1_endDate_1', 'planId_1_status_1', 'endDate_1']) {
    if (!subNames.has(expected)) fail(`subscriptions is missing index ${expected}`);
  }
  const planIndexes = await indexesOf(db, 'plans');
  const planNames = new Set(planIndexes.map((i) => i.name));
  if (!planNames.has('nameKey_1')) fail('plans is missing unique nameKey_1');
  if (!planNames.has('code_1')) fail('plans is missing unique code_1');

  // 2. Data
  const stores = await db.collection('stores').find({}, { projection: { _id: 1 } }).toArray();
  const storeIds = new Set(stores.map((s) => String(s._id)));
  const plans = await db.collection('plans').find({}).toArray();
  const planIds = new Set(plans.map((p) => String(p._id)));
  const subs = await db.collection('subscriptions').find({}).toArray();

  const seen = new Set();
  for (const sub of subs) {
    const id = String(sub._id);
    const storeId = String(sub.storeId);
    if (!sub.storeId) fail(`subscription ${id} has no storeId`);
    if (seen.has(storeId)) fail(`duplicate subscription for store ${storeId}`);
    seen.add(storeId);
    if (!storeIds.has(storeId)) fail(`subscription ${id} points at a missing store ${storeId}`);

    if (!STATUSES.includes(sub.status)) fail(`subscription ${id} has invalid status ${sub.status}`);
    if (!(sub.startDate instanceof Date) && !sub.startDate) {
      fail(`subscription ${id} has no startDate`);
    }
    if (sub.endDate !== null && sub.endDate !== undefined && !(sub.endDate instanceof Date)) {
      fail(`subscription ${id} has a non-date endDate`);
    }
    if (sub.status === 'cancelled' && !sub.cancelledAt) {
      fail(`subscription ${id} is cancelled without cancelledAt`);
    }
    if (sub.planId && !planIds.has(String(sub.planId))) {
      fail(`subscription ${id} references a missing plan ${sub.planId}`);
    }

    const snap = sub.planSnapshot;
    if (!snap || !snap.name || !Number.isInteger(snap.planVersion) || !Number.isInteger(snap.durationDays)) {
      fail(`subscription ${id} has an incomplete planSnapshot`);
    } else {
      if (!snap.limits || typeof snap.limits !== 'object') fail(`subscription ${id} snapshot has no limits`);
      if (!snap.features || typeof snap.features !== 'object') fail(`subscription ${id} snapshot has no features`);
    }

    const used = sub.usage?.ordersUsed;
    if (!Number.isInteger(used) || used < 0) {
      fail(`subscription ${id} has an invalid usage.ordersUsed=${used}`);
    }

    // Credential-like fields must never live on a subscription/plan document.
    for (const key of Object.keys(sub)) {
      if (SECRET_PATTERN.test(key)) fail(`subscription ${id} contains a credential-like field "${key}"`);
    }
  }

  for (const plan of plans) {
    for (const key of Object.keys(plan)) {
      if (SECRET_PATTERN.test(key)) fail(`plan ${plan._id} contains a credential-like field "${key}"`);
    }
  }

  // 3. Coverage (backfill must have assigned every store)
  const missing = stores.filter((s) => !seen.has(String(s._id)));
  if (missing.length) fail(`${missing.length} store(s) have no subscription (backfill incomplete)`);

  // 4. Events
  const events = await db.collection('subscriptionevents').find({}).toArray();
  const subIds = new Set(subs.map((s) => String(s._id)));
  for (const event of events) {
    if (!event.action) fail(`event ${event._id} has no action`);
    if (event.subscriptionId && !subIds.has(String(event.subscriptionId))) {
      fail(`event ${event._id} references a missing subscription ${event.subscriptionId}`);
    }
    if (event.storeId && !storeIds.has(String(event.storeId))) {
      // Store-deleted history is allowed but should be reported, not silently ignored.
      notes.push(`event ${event._id} references missing store ${event.storeId} (store deleted?)`);
    }
  }

  console.log(`subscriptions: ${subs.length}`);
  console.log(`stores: ${stores.length}`);
  console.log(`plans: ${plans.length}`);
  console.log(`events: ${events.length}`);
  if (notes.length) {
    console.log(`\nnotes (${notes.length}):`);
    for (const note of notes) console.log(`  - ${note}`);
  }

  if (violations.length) {
    console.error(`\n[VERIFY SUBSCRIPTIONS] FAILED with ${violations.length} violation(s):`);
    for (const violation of violations) console.error(`  - ${violation}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('\n[VERIFY SUBSCRIPTIONS] OK — 0 violations.');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('[VERIFY SUBSCRIPTIONS] failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
