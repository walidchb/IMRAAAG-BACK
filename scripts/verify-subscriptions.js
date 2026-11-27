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

  // 2a. Signup-default invariant. `isDefaultForSignup` implies `isActive` (the partial unique
  // index covers active defaults only), and exactly one active default is required whenever
  // subscription feature enforcement is on.
  const truthy = (value) => String(value ?? '').toLowerCase() === 'true';
  const subscriptionsEnabled = truthy(process.env.SUBSCRIPTIONS_ENABLED);
  const broadEnforcement = truthy(process.env.SUBSCRIPTIONS_ENFORCEMENT_ENABLED);
  const featureFlag =
    process.env.SUBSCRIPTIONS_FEATURE_ENFORCEMENT_ENABLED === undefined
      ? subscriptionsEnabled
      : truthy(process.env.SUBSCRIPTIONS_FEATURE_ENFORCEMENT_ENABLED);
  const featureEnforcement = broadEnforcement || featureFlag;

  const activeDefaults = plans.filter((p) => p.isActive === true && p.isDefaultForSignup === true);
  const inactiveDefaults = plans.filter((p) => p.isActive !== true && p.isDefaultForSignup === true);
  if (inactiveDefaults.length > 0) {
    fail(
      `${inactiveDefaults.length} inactive plan(s) are marked as the signup default: ` +
        inactiveDefaults.map((p) => String(p._id)).join(', '),
    );
  }
  if (activeDefaults.length > 1) {
    fail(
      `${activeDefaults.length} active plans are marked as the signup default: ` +
        activeDefaults.map((p) => String(p._id)).join(', '),
    );
  }
  if (featureEnforcement && activeDefaults.length === 0) {
    fail('subscription feature enforcement is on but there is no active signup default plan');
  }
  if (!featureEnforcement && activeDefaults.length === 0) {
    notes.push('no active signup default plan (feature enforcement is off)');
  }

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

      const ent = snap.entitlements;
      const nullableInt = (v) => v === null || (Number.isInteger(v) && v >= 0);
      if (ent != null) {
        if (
          !nullableInt(ent.monthlyOrders) ||
          !nullableInt(ent.ordersAllowance) ||
          !nullableInt(ent.maxProducts) ||
          !nullableInt(ent.maxTeamMembers) ||
          !ent.features ||
          typeof ent.features !== 'object'
        ) {
          fail(`subscription ${id} has a malformed entitlements block`);
        }
        const billing = snap.billing;
        if (billing && billing.priceSource !== 'legacy') {
          // Cumulative allowance must equal monthly base × duration when both are finite.
          if (
            ent.ordersAllowance !== null &&
            ent.monthlyOrders !== null &&
            Number.isInteger(ent.durationMonths)
          ) {
            if (ent.ordersAllowance !== ent.monthlyOrders * ent.durationMonths) {
              fail(
                `subscription ${id} allowance ${ent.ordersAllowance} != ${ent.monthlyOrders} × ${ent.durationMonths}`,
              );
            }
          }
          // Concurrent limits are never multiplied by duration.
          if (snap.limits) {
            if (ent.maxProducts !== (snap.limits.maxProducts ?? null)) {
              fail(`subscription ${id} entitlements.maxProducts differs from plan limits`);
            }
            if (ent.maxTeamMembers !== (snap.limits.maxTeamMembers ?? null)) {
              fail(`subscription ${id} entitlements.maxTeamMembers differs from plan limits`);
            }
          }
          if (Number.isInteger(billing.durationMonths)) {
            const expectedList = billing.monthlyBasePrice * billing.durationMonths;
            if (billing.listPrice !== expectedList) {
              fail(`subscription ${id} billing.listPrice ${billing.listPrice} != ${expectedList}`);
            }
            if (billing.priceSource === 'calculated') {
              const expectedFinal = Math.round(
                (billing.listPrice * (100 - billing.discountPercent)) / 100,
              );
              if (billing.finalPrice !== expectedFinal) {
                fail(
                  `subscription ${id} billing.finalPrice ${billing.finalPrice} != ${expectedFinal}`,
                );
              }
            } else if (billing.priceSource === 'override') {
              if (billing.finalPrice !== billing.priceOverride) {
                fail(`subscription ${id} override finalPrice != priceOverride`);
              }
              if (billing.priceOverride < 0 || billing.priceOverride > billing.listPrice) {
                fail(`subscription ${id} priceOverride ${billing.priceOverride} out of range`);
              }
            }
          }
        }
      }
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

    const mode = plan.billingMode || 'legacy';
    if (!['legacy', 'monthly'].includes(mode)) {
      fail(`plan ${plan._id} has invalid billingMode ${mode}`);
    }
    const options = Array.isArray(plan.billingOptions) ? plan.billingOptions : [];
    if (mode === 'monthly') {
      const durations = new Set();
      for (const option of options) {
        const duration = Number(option.durationMonths);
        if (![1, 3, 6, 12].includes(duration)) {
          fail(`plan ${plan._id} has unsupported billing duration ${option.durationMonths}`);
        }
        if (durations.has(duration)) {
          fail(`plan ${plan._id} has duplicate option duration ${duration}`);
        }
        durations.add(duration);
        const discount = Number(option.discountPercent);
        if (!Number.isInteger(discount) || discount < 0 || discount > 100) {
          fail(`plan ${plan._id} has invalid discountPercent ${option.discountPercent}`);
        }
      }
      if (!durations.has(1)) {
        fail(`plan ${plan._id} is monthly but missing the mandatory 1-month duration`);
      }
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
