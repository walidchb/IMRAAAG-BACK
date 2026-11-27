require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Repair subscriptions hit by the single-nested spread bug in `PlansService.buildSnapshot`.
 *
 * Symptom: a monthly plan purchased for N months stored
 *   planSnapshot.entitlements = { monthlyOrders: null, ordersAllowance: null, ... durationMonths: N }
 * even though `planSnapshot.limits.maxOrders` is finite, so enforcement fell back to 1× and the
 * store was blocked after `limits.maxOrders` orders (e.g. 1/1 with "1 orders/month x 3 months").
 *
 * The fix recomputes the immutable totals from the snapshot itself (no plan lookup), mirroring
 * `buildSnapshot` after the fix:
 *   monthlyOrders   = limits.maxOrders
 *   ordersAllowance = limits.maxOrders x billing.durationMonths
 *   maxProducts     = limits.maxProducts
 *   maxTeamMembers  = limits.maxTeamMembers
 *   features        = { pos: planSnapshot.features.pos }
 *
 * Only the exact buggy signature is touched:
 *   - billing exists and `priceSource !== 'legacy'`
 *   - integer `billing.durationMonths >= 1`
 *   - finite integer `limits.maxOrders >= 0`
 *   - `entitlements.monthlyOrders === null` AND `entitlements.ordersAllowance === null`
 * Unlimited plans (maxOrders null) and genuine legacy snapshots are never modified.
 * `usage.ordersUsed` is preserved. Idempotent (repaired rows no longer match).
 *
 * Dry-run by default. `--apply` writes and first copies the original document into
 * `subscriptionentitlementrepair_backup`.
 *
 * Run: node scripts/repair-subscription-entitlements.js [--apply]
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const COLLECTION = 'subscriptions';
const BACKUP = 'subscriptionentitlementrepair_backup';

function expectedEntitlements(sub) {
  const snap = sub.planSnapshot || {};
  const billing = snap.billing;
  const limits = snap.limits || {};
  const ent = snap.entitlements;
  if (!billing || !ent) return null;
  if (billing.priceSource === 'legacy') return null;

  const months = Number(billing.durationMonths);
  if (!Number.isInteger(months) || months < 1) return null;

  const monthly = limits.maxOrders;
  if (!Number.isInteger(monthly) || monthly < 0) return null;

  // Only the buggy shape: a finite monthly allowance whose totals were lost to null.
  if (ent.monthlyOrders !== null || ent.ordersAllowance !== null) return null;

  return {
    monthlyOrders: monthly,
    ordersAllowance: monthly * months,
    maxProducts: limits.maxProducts ?? null,
    maxTeamMembers: limits.maxTeamMembers ?? null,
    features: { pos: Boolean(snap.features && snap.features.pos) },
    durationMonths: months,
  };
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const collection = db.collection(COLLECTION);

  console.log(`[REPAIR SUBSCRIPTION ENTITLEMENTS] ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const subs = await collection
    .find({ 'planSnapshot.billing': { $exists: true } })
    .toArray();
  console.log(`subscriptions with billing: ${subs.length}\n`);

  let candidates = 0;
  let written = 0;

  for (const sub of subs) {
    const expected = expectedEntitlements(sub);
    if (!expected) continue;
    candidates += 1;

    const before = sub.planSnapshot.entitlements;
    console.log(`subscription ${sub._id}  store=${sub.storeId}`);
    console.log(
      `  ordersAllowance ${before.ordersAllowance ?? 'null'} -> ${expected.ordersAllowance}` +
        `  (${expected.monthlyOrders}/month x ${expected.durationMonths} months, usage preserved)`,
    );
    console.log(
      `  maxProducts ${before.maxProducts ?? 'null'} -> ${expected.maxProducts}` +
        `  maxTeamMembers ${before.maxTeamMembers ?? 'null'} -> ${expected.maxTeamMembers}`,
    );

    if (!APPLY) continue;

    await db.collection(BACKUP).insertOne({
      subscriptionId: sub._id,
      storeId: sub.storeId,
      planSnapshot: sub.planSnapshot,
      repairedAt: new Date(),
    });

    const result = await collection.updateOne(
      {
        _id: sub._id,
        'planSnapshot.entitlements.monthlyOrders': null,
        'planSnapshot.entitlements.ordersAllowance': null,
      },
      { $set: { 'planSnapshot.entitlements': expected } },
    );
    if (result.modifiedCount === 1) written += 1;
  }

  if (APPLY) {
    console.log(`\nrepaired ${written}/${candidates} subscription(s); originals in ${BACKUP}.`);
  } else {
    console.log(`\n(no writes) would repair ${candidates} subscription(s).`);
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('[REPAIR SUBSCRIPTION ENTITLEMENTS] failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
