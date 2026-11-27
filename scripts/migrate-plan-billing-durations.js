require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Migrate per-plan arbitrary billing options to the **fixed global durations** model.
 *
 * Before: a monthly plan stored any number of `billingOptions` with a free-form duration,
 * label, per-plan price override, active/default flags.
 * After: every monthly plan stores exactly four rows — 1/3/6/12 months — with only a
 * discount percentage. Global enablement lives in `subscriptionbillingconfigs`.
 *
 * Safe/idempotent: keeps the existing discount for each supported duration, defaults missing
 * ones to 0 %, and preserves the old subdocument `_id` when the duration still exists.
 * Legacy (non-monthly) plans are untouched. Existing subscriptions are never modified (their
 * `planSnapshot` is immutable).
 *
 * Run: node scripts/migrate-plan-billing-durations.js [--apply]
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const SUPPORTED = [1, 3, 6, 12];
const PLANS = 'plans';
const CONFIG = 'subscriptionbillingconfigs';

function clampDiscount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const int = Math.round(parsed);
  return Math.min(100, Math.max(0, int));
}

function buildOptions(existingOptions) {
  const byDuration = new Map();
  for (const option of Array.isArray(existingOptions) ? existingOptions : []) {
    const duration = Number(option?.durationMonths);
    if (!SUPPORTED.includes(duration)) continue;
    byDuration.set(duration, option);
  }
  return SUPPORTED.map((duration) => {
    const existing = byDuration.get(duration);
    return {
      _id: existing?._id ?? new mongoose.Types.ObjectId(),
      durationMonths: duration,
      discountPercent: clampDiscount(existing?.discountPercent ?? 0),
    };
  });
}

function isMigrated(plan, nextOptions) {
  const current = Array.isArray(plan.billingOptions) ? plan.billingOptions : [];
  if (current.length !== SUPPORTED.length) return false;
  const currentDurations = new Set(current.map((option) => Number(option.durationMonths)));
  if (currentDurations.size !== SUPPORTED.length) return false;
  for (const option of current) {
    if (!SUPPORTED.includes(Number(option.durationMonths))) return false;
    if (option.label !== undefined && option.label !== null) return false;
    if (option.priceOverride !== undefined && option.priceOverride !== null) return false;
    if (option.isActive === false) return false;
    if (option.isDefault === true && Number(option.durationMonths) !== 1) return false;
    if (option.isDefault === false && Number(option.durationMonths) === 1) return false;
  }
  const currentMap = new Map(
    current.map((option) => [Number(option.durationMonths), clampDiscount(option.discountPercent)]),
  );
  return nextOptions.every(
    (option) => currentMap.get(option.durationMonths) === option.discountPercent,
  );
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const plans = db.collection(PLANS);
  const config = db.collection(CONFIG);

  console.log(`[MIGRATE BILLING DURATIONS] ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  // 1. Global config singleton (all four enabled by default).
  const existingConfig = await config.findOne({ key: 'global' });
  if (!existingConfig) {
    console.log('global billing config missing — would create with enabledDurations [1,3,6,12]');
    if (APPLY) {
      const now = new Date();
      await config.insertOne({
        key: 'global',
        enabledDurations: [...SUPPORTED],
        updatedByAdminId: null,
        updatedByAdminEmail: null,
        createdAt: now,
        updatedAt: now,
      });
      console.log('  created global billing config');
    }
  } else {
    const current = Array.isArray(existingConfig.enabledDurations)
      ? existingConfig.enabledDurations
      : [];
    const normalized = Array.from(
      new Set([1, ...current.filter((value) => SUPPORTED.includes(Number(value)))]),
    ).sort((a, b) => a - b);
    const same =
      normalized.length === current.length &&
      normalized.every((value) => current.includes(value));
    console.log(
      `global billing config present (enabled: ${(existingConfig.enabledDurations || []).join(', ')})`,
    );
    if (!same) {
      console.log(`  would normalise enabledDurations → [${normalized.join(', ')}]`);
      if (APPLY) {
        await config.updateOne(
          { key: 'global' },
          { $set: { enabledDurations: normalized, updatedAt: new Date() } },
        );
        console.log('  normalised global billing config');
      }
    }
  }

  // 2. Monthly plans → fixed four-row discounts.
  const monthlyPlans = await plans
    .find({ billingMode: 'monthly' })
    .project({ _id: 1, code: 1, name: 1, billingOptions: 1 })
    .toArray();

  console.log(`\nmonthly plans: ${monthlyPlans.length}`);
  let changed = 0;
  let skipped = 0;

  for (const plan of monthlyPlans) {
    const nextOptions = buildOptions(plan.billingOptions);
    if (isMigrated(plan, nextOptions)) {
      skipped += 1;
      continue;
    }
    changed += 1;
    const summary = nextOptions
      .map((option) => `${option.durationMonths}m=${option.discountPercent}%`)
      .join(' ');
    console.log(`  ${plan.code || plan.name || String(plan._id)} → ${summary}`);
    if (APPLY) {
      await plans.updateOne(
        { _id: plan._id },
        { $set: { billingOptions: nextOptions, updatedAt: new Date() } },
      );
    }
  }

  console.log(
    `\n${APPLY ? 'migrated' : 'would migrate'} ${changed} plan(s); ${skipped} already current.`,
  );
  console.log('\nDone.');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('[MIGRATE BILLING DURATIONS] failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
