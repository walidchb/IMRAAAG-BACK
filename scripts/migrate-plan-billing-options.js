require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Optional plan conversion for the billing-durations feature.
 *
 * Plans with `durationDays === 30` and a positive `price` are converted to
 * `billingMode: 'monthly'` with the four fixed durations (1/3/6/12) at 0 % discount,
 * preserving the current monthly price. Use `migrate-plan-billing-durations.js` to convert
 * existing monthly plans' discounts to the same fixed-duration shape. Every other plan stays
 * `legacy` until an admin edits it.
 *
 * Additive only: no plan is deleted, no subscription is touched, and existing subscriptions
 * keep enforcing their snapshot. Idempotent — plans already monthly are skipped.
 *
 * Run: node scripts/migrate-plan-billing-options.js [--apply]
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const COLLECTION = 'plans';

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const collection = db.collection(COLLECTION);

  console.log(`[MIGRATE PLAN BILLING OPTIONS] ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const plans = await collection.find({}).toArray();
  let candidates = 0;
  let converted = 0;

  for (const plan of plans) {
    const mode = plan.billingMode || 'legacy';
    if (mode === 'monthly') continue;

    const eligible =
      Number(plan.durationDays) === 30 && Number.isInteger(plan.price) && plan.price > 0;
    if (!eligible) {
      console.log(
        `plan "${plan.name}" stays legacy (durationDays=${plan.durationDays}, price=${plan.price})`,
      );
      continue;
    }

    candidates += 1;
    if (!APPLY) {
      console.log(`would convert plan "${plan.name}" to monthly with a 1-month option`);
      continue;
    }

    const now = new Date();
    await collection.updateOne(
      { _id: plan._id, billingMode: { $ne: 'monthly' } },
      {
        $set: {
          billingMode: 'monthly',
          billingOptions: [1, 3, 6, 12].map((durationMonths) => ({
            _id: new mongoose.Types.ObjectId(),
            durationMonths,
            discountPercent: 0,
          })),
          updatedAt: now,
        },
      },
    );
    converted += 1;
    console.log(`converted plan "${plan.name}" to monthly (1-month option preserving price)`);
  }

  console.log(
    `\n${APPLY ? `Converted ${converted}` : `Would convert ${candidates}`} plan(s); subscriptions untouched.`,
  );
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('[MIGRATE PLAN BILLING OPTIONS] failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
