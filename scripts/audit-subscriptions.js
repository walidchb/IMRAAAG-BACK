require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Plans & Subscriptions — read-only audit.
 *
 * Reports: stores without a subscription, orphan subscriptions, inactive plans still assigned,
 * stored-active subscriptions past their end date, snapshot drift versus the live plan, POS
 * mismatch, and order-usage drift for the current period.
 *
 * Dry-run by default. `--reconcile --apply` repairs ONLY the `usage.ordersUsed` counter from
 * the live order count (never touches orders, dates, snapshots or store status). Any other
 * repair is deliberately out of scope and needs an explicit operational decision.
 *
 * Run: node scripts/audit-subscriptions.js [--reconcile] [--apply]
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const RECONCILE = process.argv.includes('--reconcile');
const APPLY = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log(`[AUDIT SUBSCRIPTIONS] ${APPLY && RECONCILE ? 'RECONCILE-APPLY' : 'READ-ONLY'}\n`);

  const stores = await db.collection('stores').find({}, { projection: { _id: 1, storeName: 1 } }).toArray();
  const storeById = new Map(stores.map((s) => [String(s._id), s]));
  const subs = await db.collection('subscriptions').find({}).toArray();
  const plans = await db.collection('plans').find({}).toArray();
  const planById = new Map(plans.map((p) => [String(p._id), p]));
  const subStoreIds = new Set(subs.map((s) => String(s.storeId)));

  const findings = [];
  const missing = stores.filter((s) => !subStoreIds.has(String(s._id)));
  if (missing.length) findings.push(`${missing.length} store(s) without a subscription`);

  const now = new Date();
  let expiredStoredActive = 0;
  let snapshotDrift = 0;
  let posMismatch = 0;
  let orphan = 0;
  let inactivePlanAssigned = 0;
  let usageDrift = 0;
  let legacySnapshots = 0;
  let allowanceDrift = 0;
  let priceFormulaMismatch = 0;
  let duplicateDurations = 0;
  let unsupportedDurations = 0;
  let invalidDiscounts = 0;
  let missingOneMonth = 0;
  const reconcileOps = [];

  for (const sub of subs) {
    const storeId = String(sub.storeId);
    if (!storeById.has(storeId)) {
      orphan += 1;
      continue;
    }
    if (sub.status !== 'cancelled' && sub.endDate && new Date(sub.endDate) <= now) {
      if (sub.status !== 'expired') expiredStoredActive += 1;
    }
    const plan = sub.planId ? planById.get(String(sub.planId)) : null;
    if (!plan) {
      findings.push(`subscription ${sub._id} references a missing plan ${sub.planId}`);
    } else {
      if (!plan.isActive) inactivePlanAssigned += 1;
      if (plan.version !== sub.planSnapshot?.planVersion) snapshotDrift += 1;
      if (Boolean(plan.features?.pos) !== Boolean(sub.planSnapshot?.features?.pos)) posMismatch += 1;
    }

    // Billing/entitlement integrity (read-only reporting; never auto-fixed here).
    const snap = sub.planSnapshot || {};
    const ent = snap.entitlements;
    const billing = snap.billing;
    if (!ent) {
      legacySnapshots += 1;
    } else {
      if (
        ent.ordersAllowance !== null &&
        ent.monthlyOrders !== null &&
        Number.isInteger(ent.durationMonths) &&
        billing?.priceSource !== 'legacy' &&
        ent.ordersAllowance !== ent.monthlyOrders * ent.durationMonths
      ) {
        allowanceDrift += 1;
      }
      if (billing && Number.isInteger(billing.durationMonths)) {
        if (billing.listPrice !== billing.monthlyBasePrice * billing.durationMonths) {
          priceFormulaMismatch += 1;
        } else {
          const expectedFinal =
            billing.priceSource === 'override'
              ? billing.priceOverride
              : Math.round((billing.listPrice * (100 - billing.discountPercent)) / 100);
          if (billing.priceSource !== 'legacy' && billing.finalPrice !== expectedFinal) {
            priceFormulaMismatch += 1;
          }
        }
      }
    }

    // Usage drift: orders created since this period started.
    const start = sub.startDate ? new Date(sub.startDate) : null;
    const orderFilter = { storeId: sub.storeId };
    if (start) orderFilter.createdAt = { $gte: start };
    const liveCount = await db.collection('orders').countDocuments(orderFilter);
    const stored = sub.usage?.ordersUsed ?? 0;
    if (liveCount !== stored) {
      usageDrift += 1;
      console.log(
        `  usage drift: store ${storeId} stored=${stored} live=${liveCount}`,
      );
      if (RECONCILE) {
        reconcileOps.push({ subId: sub._id, liveCount, stored });
      }
    }
  }

  for (const plan of plans) {
    if ((plan.billingMode || 'legacy') !== 'monthly') continue;
    const options = Array.isArray(plan.billingOptions) ? plan.billingOptions : [];
    const durations = options.map((o) => Number(o.durationMonths));
    if (new Set(durations).size !== durations.length) duplicateDurations += 1;
    if (durations.some((duration) => ![1, 3, 6, 12].includes(duration))) unsupportedDurations += 1;
    if (!durations.includes(1)) missingOneMonth += 1;
    if (
      options.some(
        (o) => !Number.isInteger(Number(o.discountPercent)) || Number(o.discountPercent) < 0 || Number(o.discountPercent) > 100,
      )
    ) {
      invalidDiscounts += 1;
    }
  }

  if (missing.length) {
    for (const store of missing.slice(0, 20)) {
      console.log(`  missing subscription: ${store.storeName} (${store._id})`);
    }
  }
  console.log('');
  console.log(`stores: ${stores.length}`);
  console.log(`subscriptions: ${subs.length}`);
  console.log(`plans: ${plans.length}`);
  console.log(`stores without subscription: ${missing.length}`);
  console.log(`orphan subscriptions (store missing): ${orphan}`);
  console.log(`stored active/trialing past endDate: ${expiredStoredActive}`);
  console.log(`snapshot drift (plan version differs): ${snapshotDrift}`);
  console.log(`POS mismatch (snapshot vs live plan): ${posMismatch}`);
  console.log(`inactive plans still assigned: ${inactivePlanAssigned}`);
  console.log(`order-usage drift: ${usageDrift}`);
  console.log(`legacy snapshots without billing/entitlements: ${legacySnapshots}`);
  console.log(`allowance drift (total != monthly × months): ${allowanceDrift}`);
  console.log(`billing price formula mismatch: ${priceFormulaMismatch}`);
  console.log(`plans with duplicate option durations: ${duplicateDurations}`);
  console.log(`plans with unsupported billing durations: ${unsupportedDurations}`);
  console.log(`plans missing the mandatory 1-month duration: ${missingOneMonth}`);
  console.log(`plans with invalid discount values: ${invalidDiscounts}`);

  if (RECONCILE) {
    console.log('');
    if (!APPLY) {
      console.log(`reconcile plan: ${reconcileOps.length} counter update(s) would be applied.`);
      console.log('Re-run with --reconcile --apply to write them (owner approval required).');
    } else {
      let written = 0;
      for (const op of reconcileOps) {
        await db.collection('subscriptions').updateOne(
          { _id: op.subId },
          { $set: { 'usage.ordersUsed': op.liveCount, updatedAt: new Date() } },
        );
        await db.collection('subscriptionevents').insertOne({
          subscriptionId: op.subId,
          action: 'usage_reconciled',
          from: { ordersUsed: op.stored },
          to: { ordersUsed: op.liveCount },
          actorType: 'system',
          details: { source: 'audit-subscriptions' },
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        written += 1;
      }
      console.log(`reconciled ${written} subscription counter(s).`);
    }
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('[AUDIT SUBSCRIPTIONS] failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
