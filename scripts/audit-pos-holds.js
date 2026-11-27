require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Planned & Subscriptions — read-only POS-hold visibility audit.
 *
 * Lists parked POS sales whose store's current subscription no longer includes the POS
 * feature. These holds keep inventory reserved; the vendor can release them from the
 * subscription/POS blocked screen (listing and release are exempt from the POS gate).
 *
 * Nothing is written and no hold is auto-released: a hold may represent a customer deposit
 * (`noteType: 'payment'`).
 *
 * Run: node scripts/audit-pos-holds.js
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function posIncluded(sub) {
  if (!sub || !sub.planSnapshot) return false;
  const snapshot = sub.planSnapshot;
  const ent = snapshot.entitlements;
  const features = ent && typeof ent === 'object' ? ent.features : snapshot.features;
  return Boolean(features && features.pos === true);
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log('[AUDIT POS HOLDS] READ-ONLY\n');

  const [holds, subs] = await Promise.all([
    db.collection('posholds').find({}).toArray(),
    db.collection('subscriptions').find({}).toArray(),
  ]);

  const subByStore = new Map();
  for (const sub of subs) subByStore.set(String(sub.storeId), sub);

  const now = Date.now();
  const stranded = [];
  for (const hold of holds) {
    const sub = subByStore.get(String(hold.storeId)) ?? null;
    if (posIncluded(sub)) continue;
    const createdAt = hold.createdAt ? new Date(hold.createdAt).getTime() : null;
    stranded.push({
      id: String(hold._id),
      storeId: String(hold.storeId),
      orderNo: hold.orderNo ?? null,
      status: sub ? sub.status ?? null : 'none',
      ageDays: createdAt ? Math.floor((now - createdAt) / MS_PER_DAY) : null,
      noteType: hold.noteType ?? 'general',
      total: hold.total ?? null,
    });
  }

  console.log(`POS holds total: ${holds.length}`);
  console.log(`Holds whose store lacks POS: ${stranded.length}\n`);

  if (stranded.length > 0) {
    for (const row of stranded) {
      console.log(
        `  hold=${row.id} store=${row.storeId} orderNo=${row.orderNo ?? '-'} ` +
          `subscription=${row.status} ageDays=${row.ageDays ?? '?'} ` +
          `noteType=${row.noteType} total=${row.total ?? '-'}`,
      );
    }
    console.log(
      '\nEach stranded hold reserves stock until the vendor releases it (or the plan includes POS again).' +
        '\nNo automatic release is performed.',
    );
  } else {
    console.log('No stranded POS holds.');
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[AUDIT POS HOLDS] failed:', err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
