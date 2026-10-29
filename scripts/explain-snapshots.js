/*
 * EXPLAIN snapshots for the Phase 8 hot reads.
 *
 * Runs `.explain('executionStats')` on the queries the inventory list, the movement ledger
 * (cursor reads) and the order list actually issue, and prints a table of the winning plan:
 * nReturned / totalDocsExamined / totalKeysExamined / execution time / stage shape. The
 * assertions that fail the snapshot are exactly the ones Phase 8 shipped indexes for:
 *   - no COLLSCAN anywhere (every hot read rides an index);
 *   - the three movement-ledger cursor reads sort WITHOUT an in-memory SORT stage
 *     (the new `{storeId,_id}`, `{storeId,variantId,_id}`, `{orderId,_id}` indexes);
 *   - the leading inventory-list match and the balance lookup stay index scans.
 * Order doesn't need EXPLAIN snapshots to be correct at 10× data — it needs the index plans.
 *
 * Read-only. Uses the largest store/variant/order currently in the ledger so the snapshot
 * reflects the worst case present today (this is a baseline to diff at 10× volume).
 *
 * Requires `npm run build` first (collection names resolve from the compiled schemas).
 * Usage: node scripts/explain-snapshots.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');
const { inventoryCollectionNames } = require('./lib/inventory-collections');
const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) { console.error('MONGODB_URI required'); process.exit(1); }
const COLLECTIONS = inventoryCollectionNames();

let failures = 0;
function fail(label, detail) { failures++; console.log('  FAIL  [' + label + '] ' + detail); }

/** Collect the distinct stage types present anywhere in the executionStages tree. */
function stageTypes(node, acc) {
  if (!node || typeof node !== 'object') return acc;
  if (node.stage) acc.add(node.stage);
  for (const k of ['inputStage', 'innerStage', 'outerStage', 'child']) {
    if (node[k]) stageTypes(node[k], acc);
  }
  if (Array.isArray(node.inputStages)) for (const s of node.inputStages) stageTypes(s, acc);
  return acc;
}

function describe(stats) {
  const stages = stageTypes(stats.executionStages, new Set());
  return {
    returned: stats.nReturned,
    docsExamined: stats.totalDocsExamined,
    keysExamined: stats.totalKeysExamined,
    timeMs: stats.executionTimeMillis,
    stages: [...stages].sort(),
  };
}

/** Run explain('executionStats') over a raw-collection find chain. */
async function explainFind(coll, filter, { sort, limit }) {
  let cur = coll.find(filter);
  if (sort) cur = cur.sort(sort);
  if (limit) cur = cur.limit(limit);
  const explain = await cur.explain('executionStats');
  return describe(explain.executionStats);
}

/** Run explain over an aggregate pipeline. */
async function explainAgg(coll, pipeline) {
  const explain = await coll.aggregate(pipeline).explain('executionStats');
  return describe(explain.executionStats);
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const movingColl = db.collection(COLLECTIONS.movements);
  const variantColl = db.collection(COLLECTIONS.variants);
  const balanceColl = db.collection(COLLECTIONS.balances);
  const ordersColl = db.collection('orders');

  console.log('[EXPLAIN SNAPSHOTS] Connected. Read-only. (requires prior eager index sync)\n');

  // Representative worst-case ids: the store with the most movements, a variant of it with
  // movements, and an order with movements.
  const mover = await movingColl.aggregate([{ $group: { _id: '$storeId', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 1 }]).toArray();
  if (mover.length === 0) { console.log('[EXPLAIN SNAPSHOTS] SKIP — no movements to snapshot'); await mongoose.disconnect(); process.exit(0); }
  const storeId = mover[0]._id;
  const sampleMove = await movingColl.find({ storeId }).limit(1).toArray();
  const variantId = sampleMove[0].variantId;
  const orderId = sampleMove[0].orderId || (await movingColl.find({ storeId, orderId: { $ne: null } }).limit(1).toArray())[0]?.orderId;

  const snapshot = [];


  const list = await explainAgg(variantColl, [
    { $match: { storeId, isDeleted: { $ne: true } } },
  ]);
  const balance = await explainFind(balanceColl, { variantId }, { limit: 1 });

  // POS scan + hand-edit barcode lookup: { storeId, barcode } must hit the partial unique
  // index (Barcode/SKU/Label plan). Any barcode in the store works; when none exists yet the
  // filter shape is unchanged, so a synthetic prefix-20 value still proves the plan.
  const sampleBarcode = await variantColl.findOne(
    { storeId, barcode: { $type: 'string' } },
    { projection: { barcode: 1 } },
  );
  const probeBarcode = sampleBarcode ? sampleBarcode.barcode : '2000000000000';
  const barcodeLookup = await explainFind(
    variantColl,
    { storeId, barcode: probeBarcode },
    { limit: 1 },
  );


  const ledgerStore = await explainFind(movingColl, { storeId }, { sort: { _id: -1 }, limit: 51 });
  const ledgerVariant = await explainFind(movingColl, { storeId, variantId }, { sort: { _id: -1 }, limit: 51 });
  const ledgerOrder = orderId
    ? await explainFind(movingColl, { orderId }, { sort: { _id: -1 }, limit: 500 })
    : null;
  const ledgerWindow = await explainFind(
    movingColl,
    { storeId, createdAt: { $gte: new Date(Date.now() - 365 * 86400000) } },
    { sort: { _id: -1 }, limit: 51 },
  );


  const ordersPlain = await explainFind(ordersColl, { storeId, isDeleted: false }, { sort: { createdAt: -1, _id: -1 }, limit: 20 });
  const ordersTab = await explainFind(
    ordersColl,
    { storeId, isDeleted: false, 'status.slug': 'placed' },
    { sort: { createdAt: -1, _id: -1 }, limit: 20 },
  );

  const reservationsColl = db.collection(COLLECTIONS.reservations);
  const reservationIdem = await explainFind(reservationsColl, { orderId, orderItemIndex: 0 }, { limit: 1 });

  const rows = [
    ['inv-list leading $match', list],
    ['balance lookup (variantId)', balance],
    ['barcode lookup (storeId,barcode)', barcodeLookup],
    ['ledger store cursor', ledgerStore],
    ['ledger variant cursor', ledgerVariant],
    ['ledger order (listForOrder)', ledgerOrder],
    ['ledger date window', ledgerWindow],
    ['orders vendor list', ordersPlain],
    ['orders status tab', ordersTab],
    ['reservation idempotent read', reservationIdem],
  ];

  console.log('  query                          ret | docsExam | keyExam | ms | stages');
  // The three pure cursor reads must be index-sorted (no blocking SORT). A date-window read
  // is allowed to sort a small range in memory: with a selective `createdAt` bound, using the
  // date index and sorting the window can beat scanning the store in `_id` order.
  const mustBeSortFree = new Set(['ledger store cursor', 'ledger variant cursor', 'ledger order (listForOrder)']);
  for (const [name, r] of rows) {
    if (!r) { console.log('  ' + String(name).padEnd(18) + '  SKIP (no sample)'); continue; }
    const hasIx = r.stages.includes('IXSCAN') || r.stages.includes('EXPRESS_IXSCAN') || r.stages.includes('PROJECTION_COVERED');
    const hasScan = r.stages.includes('COLLSCAN');
    const hasSort = r.stages.includes('SORT');
    console.log(
      '  ' + String(name).padEnd(18) +
        String(r.returned).padStart(5) + ' | ' + String(r.docsExamined).padStart(8) + ' | ' +
        String(r.keysExamined).padStart(8) + ' | ' + String(r.timeMs).padStart(4) + ' | ' +
        r.stages.join(','),
    );
    if (hasScan) fail(name, 'COLLSCAN in winning plan — hot read is not indexed');
    if (mustBeSortFree.has(name) && hasSort) {
      fail(name, 'in-memory SORT in winning plan — expected index-covered sort');
    }
    if (!hasIx) fail(name, 'no index scan (IXSCAN/EXPRESS_IXSCAN) in winning plan');
    snapshot.push({ name, ...r });
  }

  console.log('\n  snapshot JSON (diff this at 10× volume):');
  console.log('  ' + JSON.stringify(snapshot));

  console.log('');
  if (failures === 0) { console.log('[EXPLAIN SNAPSHOTS] OK'); await mongoose.disconnect(); process.exit(0); }
  console.log('[EXPLAIN SNAPSHOTS] ' + failures + ' FAILURE(S)');
  await mongoose.disconnect();
  process.exit(1);
}

main().catch(function (e) { console.error('[EXPLAIN SNAPSHOTS] FAILED', e); process.exit(1); });