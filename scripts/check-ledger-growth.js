require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');
const { inventoryCollectionNames } = require('./lib/inventory-collections');
const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) { console.error('MONGODB_URI required'); process.exit(1); }
const COLLECTIONS = inventoryCollectionNames();

// Soft ceiling per store. The ledger grows faster than any other collection (it is
// append-only), and every read is cursor-paginated on it, so the thing to watch is not a
// single query but the whole-store volume. These are advisory thresholds, not hard limits.
const ALERT_MOVEMENTS_PER_STORE = Number(process.env.LEDGER_ALERT_MOVEMENTS || 100000);
const ALERT_TOTAL_DOCS = Number(process.env.LEDGER_ALERT_TOTAL_DOCS || 1000000);
const ALERT_TOTAL_BYTES = Number(process.env.LEDGER_ALERT_TOTAL_BYTES || 1024 * 1024 * 1024); // 1 GiB

let violations = 0;

function line(s) { console.log(s); }
function issue(s) { violations++; console.log('  WARN  ' + s); }
function ok(s) { console.log('  ok    ' + s); }

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const movingColl = db.collection(COLLECTIONS.movements);

  line('[LEDGER GROWTH WATCH] Connected. Read-only verification.');
  line('  thresholds: ' + ALERT_MOVEMENTS_PER_STORE + ' movements/store, ' +
    ALERT_TOTAL_DOCS + ' total docs, ' + (ALERT_TOTAL_BYTES / 1024 / 1024).toFixed(0) + ' MiB total\n');

  const stats = await db.command({ collStats: COLLECTIONS.movements });
  line('  collection ' + COLLECTIONS.movements + ': ' + stats.count + ' docs, ' +
    (stats.size / 1024 / 1024).toFixed(1) + ' MiB (avgDocSize ' + (stats.avgObjSize || 0).toFixed(0) + ' B)');
  if (stats.count > ALERT_TOTAL_DOCS) { issue('total docs ' + stats.count + ' > ' + ALERT_TOTAL_DOCS); }
  if (stats.size > ALERT_TOTAL_BYTES) { issue('total bytes ' + stats.size + ' > ' + ALERT_TOTAL_BYTES); }

  const perStore = await movingColl.aggregate([
    { $group: { _id: '$storeId', n: { $sum: 1 }, oldest: { $min: '$createdAt' }, newest: { $max: '$createdAt' } } },
    { $sort: { n: -1 } },
  ]).toArray();

  if (perStore.length === 0) {
    line('\n  SKIP  no movement rows yet');
  } else {
    const storeCharts = await db.collection('stores').find({}).toArray();
    const storeName = new Map(storeCharts.map(function (s) {
      return [String(s._id), s.storeName || s.storeSlug || String(s._id)];
    }));

    line('  per-store ledger (movements, oldest -> newest):');
    for (const r of perStore) {
      const name = storeName.get(String(r._id)) || String(r._id);
      const oldest = r.oldest ? r.oldest.toISOString().slice(0, 10) : '?';
      const newest = r.newest ? r.newest.toISOString().slice(0, 10) : '?';
      line('    ' + String(name).padEnd(24) + String(r.n).padStart(8) + '  ' + oldest + ' -> ' + newest);
      if (r.n > ALERT_MOVEMENTS_PER_STORE) {
        issue('store ' + name + ' has ' + r.n + ' movements (>' + ALERT_MOVEMENTS_PER_STORE + ')');
      }
    }
  }

  line('\n  retention: movements are an append-only audit ledger. Reconciliation (balance == ' +
    'sum of deltas) and order-lifecycle replay both depend on every row, so prune only by ' +
    'freezing history - export the store rows to a read-only archive collection (or CSV) by ' +
    '`createdAt` window, then delete, keeping any row referenced by a live reservation/order. ' +
    'Never edit rows; corrections are new `correction` movements.');

  line('');
  if (violations === 0) { line('[LEDGER GROWTH WATCH] OK'); await mongoose.disconnect(); process.exit(0); }
  line('[LEDGER GROWTH WATCH] ' + violations + ' WARNING(S)');
  await mongoose.disconnect();
  process.exit(1);
}

main().catch(function (e) { console.error('[LEDGER GROWTH WATCH] FAILED', e); process.exit(1); });