require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Plans & Subscriptions — seed the two baseline plans.
 *
 *   legacy-unlimited  perpetual, price 0, no limits, POS included (existing stores)
 *   starter           default for new signups, 30 days, 14-day trial
 *
 * Idempotent: a plan is only inserted when its `code` does not exist. An existing plan is
 * NEVER overwritten (admin edits win). Dry-run by default; `--apply` writes.
 *
 * Run: node scripts/seed-subscription-plans.js [--apply]
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const COLLECTION = 'plans';

const PLANS = [
  {
    code: 'legacy-unlimited',
    name: 'Legacy Unlimited',
    nameKey: 'legacy unlimited',
    description: 'Grandfathered plan for stores that existed before subscriptions.',
    price: 0,
    currency: 'DZD',
    durationDays: 3650,
    isActive: true,
    isDefaultForSignup: false,
    version: 1,
    limits: { maxOrders: null, maxProducts: null, maxTeamMembers: null },
    features: { pos: true },
    trial: { enabled: false, days: null },
  },
  {
    code: 'starter',
    name: 'Starter',
    nameKey: 'starter',
    description: 'Entry-level plan assigned to new stores.',
    price: 2500,
    currency: 'DZD',
    durationDays: 30,
    isActive: true,
    isDefaultForSignup: true,
    version: 1,
    limits: { maxOrders: 100, maxProducts: 50, maxTeamMembers: 2 },
    features: { pos: false },
    trial: { enabled: true, days: 14 },
  },
];

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const collection = db.collection(COLLECTION);

  console.log(`[SEED SUBSCRIPTION PLANS] ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  for (const plan of PLANS) {
    const existing = await collection.findOne({ code: plan.code });
    if (existing) {
      console.log(`plan "${plan.code}" already exists (${existing.name}) — leaving untouched`);
      continue;
    }
    if (!APPLY) {
      console.log(`would insert plan "${plan.code}" (${plan.name})`);
      continue;
    }
    const now = new Date();
    await collection.insertOne({
      ...plan,
      createdByAdminId: null,
      createdByAdminEmail: null,
      lastEditedByAdminId: null,
      lastEditedByAdminEmail: null,
      createdAt: now,
      updatedAt: now,
    });
    console.log(`inserted plan "${plan.code}" (${plan.name})`);
  }

  if (APPLY) {
    const total = await collection.countDocuments({});
    console.log(`\nplans collection now holds ${total} document(s).`);
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('[SEED SUBSCRIPTION PLANS] failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
