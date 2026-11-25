require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Plans & Subscriptions — grandfather every existing store onto Legacy Unlimited.
 *
 * Only stores with no subscription document are touched; rerunning is a no-op. Historical
 * orders/products/team are never modified. Dry-run by default; `--apply` writes.
 *
 * Run: node scripts/backfill-store-subscriptions.js [--apply]
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const LEGACY_CODE = process.env.SUBSCRIPTIONS_LEGACY_PLAN_CODE || 'legacy-unlimited';

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log(`[BACKFILL STORE SUBSCRIPTIONS] ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const plan = await db.collection('plans').findOne({ code: LEGACY_CODE });
  if (!plan) {
    console.error(
      `Legacy plan "${LEGACY_CODE}" not found. Run seed-subscription-plans.js --apply first.`,
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  const snapshot = {
    planVersion: plan.version,
    name: plan.name,
    description: plan.description,
    price: plan.price,
    currency: plan.currency,
    durationDays: plan.durationDays,
    limits: plan.limits,
    features: plan.features,
    trial: plan.trial,
  };

  const stores = await db
    .collection('stores')
    .find({}, { projection: { _id: 1, storeName: 1 } })
    .toArray();

  const existing = await db
    .collection('subscriptions')
    .distinct('storeId');
  const existingKeys = new Set(existing.map((id) => String(id)));

  const missing = stores.filter((store) => !existingKeys.has(String(store._id)));
  console.log(`stores: ${stores.length}, already subscribed: ${stores.length - missing.length}, missing: ${missing.length}`);

  if (missing.length === 0) {
    console.log('\nNothing to backfill.');
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    for (const store of missing.slice(0, 20)) {
      console.log(`  would assign ${LEGACY_CODE} to ${store.storeName} (${store._id})`);
    }
    if (missing.length > 20) console.log(`  … and ${missing.length - 20} more`);
    console.log('\nDry run complete. Re-run with --apply to write.');
    await mongoose.disconnect();
    return;
  }

  const now = new Date();
  let written = 0;
  for (const store of missing) {
    try {
      const inserted = await db.collection('subscriptions').insertOne({
        storeId: store._id,
        planId: plan._id,
        planSnapshot: snapshot,
        status: 'active',
        isTrial: false,
        startDate: now,
        endDate: null,
        trialStartedAt: null,
        trialEndsAt: null,
        trialUsedAt: null,
        cancelledAt: null,
        cancelledByAdminId: null,
        cancelledByAdminEmail: null,
        cancelReason: null,
        usage: { ordersUsed: 0 },
        source: 'legacy_backfill',
        createdByAdminId: null,
        createdByAdminEmail: null,
        lastUpdatedByAdminId: null,
        lastUpdatedByAdminEmail: null,
        createdAt: now,
        updatedAt: now,
      });
      await db.collection('subscriptionevents').insertOne({
        storeId: store._id,
        subscriptionId: inserted.insertedId,
        action: 'assigned',
        from: null,
        to: {
          status: 'active',
          startDate: now,
          endDate: null,
          planVersion: snapshot.planVersion,
          snapshotName: snapshot.name,
        },
        reason: null,
        actorType: 'system',
        adminId: null,
        adminEmail: null,
        details: { source: 'legacy_backfill' },
        createdAt: now,
        updatedAt: now,
      });
      written += 1;
    } catch (err) {
      if (err && err.code === 11000) {
        console.log(`  skip ${store.storeName}: subscription already exists (race)`);
        continue;
      }
      throw err;
    }
  }

  console.log(`\nbackfilled ${written} store subscription(s).`);
  const remaining = await db
    .collection('stores')
    .countDocuments({ _id: { $nin: await db.collection('subscriptions').distinct('storeId') } });
  console.log(`stores still without a subscription: ${remaining}`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('[BACKFILL STORE SUBSCRIPTIONS] failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
