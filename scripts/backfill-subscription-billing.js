require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Additive backfill for the billing-durations feature.
 *
 * For every subscription that has **no** `planSnapshot.entitlements`, write a legacy billing +
 * entitlement snapshot. The legacy order allowance is **never multiplied** — it equals the
 * existing `planSnapshot.limits.maxOrders` (1×). Existing subscriptions therefore keep
 * exactly the terms they had before this feature.
 *
 * Idempotent: rows that already have `entitlements` are skipped. Dry-run by default;
 * `--apply` writes. Take a Mongo dump before applying.
 *
 * Run: node scripts/backfill-subscription-billing.js [--apply]
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const COLLECTION = 'subscriptions';

function legacySnapshot(snapshot) {
  const limits = snapshot.limits || { maxOrders: null, maxProducts: null, maxTeamMembers: null };
  const features = snapshot.features || { pos: false };
  const durationDays = Number.isInteger(snapshot.durationDays) ? snapshot.durationDays : null;
  const durationMonths =
    durationDays !== null && durationDays % 30 === 0 ? durationDays / 30 : null;
  const price = Number.isFinite(snapshot.price) ? snapshot.price : 0;

  return {
    billing: {
      optionId: null,
      durationMonths,
      durationDays,
      monthlyBasePrice: price,
      listPrice: price,
      discountPercent: 0,
      priceOverride: null,
      finalPrice: price,
      savings: 0,
      priceSource: 'legacy',
      currency: 'DZD',
    },
    entitlements: {
      monthlyOrders: limits.maxOrders ?? null,
      // Legacy 1× — never multiply historical allowances.
      ordersAllowance: limits.maxOrders ?? null,
      maxProducts: limits.maxProducts ?? null,
      maxTeamMembers: limits.maxTeamMembers ?? null,
      features,
      durationMonths,
    },
  };
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const collection = db.collection(COLLECTION);

  console.log(`[BACKFILL SUBSCRIPTION BILLING] ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const filter = { 'planSnapshot.entitlements': { $exists: false } };
  const total = await collection.countDocuments({});
  const pending = await collection.find(filter).toArray();

  console.log(`subscriptions total: ${total}; missing entitlements: ${pending.length}\n`);

  let written = 0;
  for (const sub of pending) {
    const snapshot = sub.planSnapshot || {};
    const { billing, entitlements } = legacySnapshot(snapshot);
    if (!APPLY) {
      console.log(
        `would backfill ${sub._id}  orders=${entitlements.ordersAllowance ?? 'unlimited'}  (legacy 1×)`,
      );
      continue;
    }
    const result = await collection.updateOne(
      { _id: sub._id, 'planSnapshot.entitlements': { $exists: false } },
      { $set: { 'planSnapshot.billing': billing, 'planSnapshot.entitlements': entitlements } },
    );
    if (result.modifiedCount === 1) written += 1;
  }

  if (APPLY) {
    const remaining = await collection.countDocuments(filter);
    console.log(`\nbackfilled ${written} subscription(s); ${remaining} still missing.`);
  } else {
    console.log(`\n(no writes) would backfill ${pending.length} subscription(s).`);
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('[BACKFILL SUBSCRIPTION BILLING] failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
