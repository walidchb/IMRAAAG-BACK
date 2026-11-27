require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Plans & Subscriptions — signup-default audit / repair.
 *
 * Read-only by default. Reports:
 *  - inactive plans marked `isDefaultForSignup` (invalid: default implies active);
 *  - more than one active default;
 *  - zero active defaults.
 *
 * `--repair` clears the invalid default flags (inactive plans, and all but one active default).
 * It never picks a plan when zero active defaults exist; seed/activate one explicitly.
 *
 * Run: node scripts/audit-plan-defaults.js [--repair]
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const REPAIR = process.argv.includes('--repair');

function truthy(value) {
  return String(value ?? '').toLowerCase() === 'true';
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log(`[AUDIT PLAN DEFAULTS] ${REPAIR ? 'REPAIR' : 'READ-ONLY'}\n`);

  const plans = await db.collection('plans').find({}).toArray();
  const activeDefaults = plans.filter((p) => p.isActive === true && p.isDefaultForSignup === true);
  const inactiveDefaults = plans.filter((p) => p.isActive !== true && p.isDefaultForSignup === true);
  const broad = truthy(process.env.SUBSCRIPTIONS_ENFORCEMENT_ENABLED);
  const enabled = truthy(process.env.SUBSCRIPTIONS_ENABLED);
  const featureFlag =
    process.env.SUBSCRIPTIONS_FEATURE_ENFORCEMENT_ENABLED === undefined
      ? enabled
      : truthy(process.env.SUBSCRIPTIONS_FEATURE_ENFORCEMENT_ENABLED);
  const featureEnforcement = broad || featureFlag;

  console.log(`plans total: ${plans.length}`);
  console.log(`active defaults: ${activeDefaults.length}`);
  console.log(`inactive defaults: ${inactiveDefaults.length}`);
  console.log(`subscription feature enforcement: ${featureEnforcement}`);

  for (const plan of plans) {
    if (!plan.isDefaultForSignup) continue;
    console.log(
      `  default plan=${String(plan._id)} name=${plan.name ?? '-'} isActive=${plan.isActive === true}`,
    );
  }

  if (REPAIR) {
    if (inactiveDefaults.length > 0) {
      await db
        .collection('plans')
        .updateMany(
          { _id: { $in: inactiveDefaults.map((p) => p._id) } },
          { $set: { isDefaultForSignup: false } },
        );
      console.log(`\ncleared ${inactiveDefaults.length} inactive default flag(s)`);
    }
    if (activeDefaults.length > 1) {
      const keep = activeDefaults[0];
      const clear = activeDefaults.slice(1);
      await db
        .collection('plans')
        .updateMany(
          { _id: { $in: clear.map((p) => p._id) } },
          { $set: { isDefaultForSignup: false } },
        );
      console.log(
        `kept ${String(keep._id)} and cleared ${clear.length} extra active default(s)`,
      );
    }
  }

  if (activeDefaults.length === 0) {
    console.log(
      '\nNo active signup default. Seed or activate a plan before enabling subscription enforcement.',
    );
    if (featureEnforcement) process.exitCode = 1;
  }
  if (inactiveDefaults.length > 0) process.exitCode = 1;
  if (activeDefaults.length > 1) process.exitCode = 1;

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[AUDIT PLAN DEFAULTS] failed:', err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
