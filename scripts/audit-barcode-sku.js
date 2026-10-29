require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');
const { inventoryCollectionNames } = require('./lib/inventory-collections');

/**
 * Barcode/SKU audit (Barcode/SKU/Label plan, Phase 1). Read-only — never writes.
 *
 * Reports the pre-rollout reality so later phases have a baseline: how many variants exist,
 * how many already carry a barcode/SKU, whether any barcode is duplicated within a store
 * (must be zero), and whether the two per-store unique indexes are actually present.
 *
 * Requires `npm run build` first (collection names are resolved from the compiled schemas).
 *
 * Run: node scripts/audit-barcode-sku.js
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const COLLECTIONS = inventoryCollectionNames();
const violations = [];

function report(rule, detail) {
  violations.push({ rule, detail });
  console.log(`  FAIL  [${rule}] ${detail}`);
}
function ok(rule, msg) {
  console.log(`  ok    [${rule}] ${msg}`);
}

function hasIndex(indexes, fieldA, fieldB) {
  return indexes.some(function (ix) {
    const key = ix.key || {};
    return key[fieldA] === 1 && key[fieldB] === 1;
  });
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const variants = db.collection(COLLECTIONS.variants);
  const stores = db.collection('stores');

  console.log('[BARCODE/SKU AUDIT] Connected. Read-only.\n');

  const total = await variants.countDocuments({});
  const withBarcode = await variants.countDocuments({ barcode: { $type: 'string' } });
  const withSku = await variants.countDocuments({ sku: { $type: 'string' } });
  console.log(`  total variants:              ${total}`);
  console.log(`  with barcode (string):       ${withBarcode}`);
  console.log(`  with sku (string):           ${withSku}`);

  // Duplicate barcode within one store must be zero; the store leads because a barcode is only
  // meaningful inside its own store.
  const dupes = await variants
    .aggregate([
      { $match: { barcode: { $type: 'string' } } },
      { $group: { _id: { storeId: '$storeId', barcode: '$barcode' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();
  if (dupes.length === 0) {
    ok('barcode-unique-per-store', 'no duplicate barcode within any store');
  } else {
    for (const d of dupes) {
      report(
        'barcode-unique-per-store',
        `store ${String(d._id.storeId)} has barcode ${d._id.barcode} on ${d.n} variants`,
      );
    }
  }

  // The two per-store unique indexes the whole feature depends on.
  const indexes = await variants.indexes();
  const barcodeIx = indexes.find(function (ix) {
    const key = ix.key || {};
    return key.storeId === 1 && key.barcode === 1;
  });
  const skuIx = indexes.find(function (ix) {
    const key = ix.key || {};
    return key.storeId === 1 && key.sku === 1;
  });

  if (barcodeIx) {
    if (barcodeIx.unique) {
      ok(
        'index-storeId-barcode',
        `${barcodeIx.name}${barcodeIx.partialFilterExpression ? ' (partial)' : ''} (unique)`,
      );
    } else {
      report(
        'index-storeId-barcode',
        `${barcodeIx.name} exists but is NOT unique — duplicate barcodes are not enforced per store`,
      );
    }
  } else {
    report('index-storeId-barcode', 'missing {storeId, barcode} index');
  }
  if (skuIx) {
    ok(
      'index-storeId-sku',
      `${skuIx.name}${skuIx.partialFilterExpression ? ' (partial)' : ''}${
        skuIx.unique ? ' (unique)' : ''
      }`,
    );
  } else {
    report('index-storeId-sku', 'missing {storeId, sku} index');
  }

  // Store counter readiness. Existing stores default to 0 via the schema, so a missing field in
  // the raw document is expected and harmless until the first generation.
  const storeTotal = await stores.countDocuments({});
  const storeSeqSet = await stores.countDocuments({ barcodeSeq: { $exists: true } });
  console.log(`  stores with barcodeSeq set:  ${storeSeqSet} / ${storeTotal} (unset defaults to 0)`);

  if (violations.length === 0) {
    console.log('\n[BARCODE/SKU AUDIT] CLEAN');
    await mongoose.disconnect();
    process.exit(0);
  }
  console.log(`\n[BARCODE/SKU AUDIT] ${violations.length} ISSUE(S)`);
  for (const v of violations) console.log(`  - [${v.rule}] ${v.detail}`);
  await mongoose.disconnect();
  process.exit(1);
}

main().catch(function (e) {
  console.error('[BARCODE/SKU AUDIT] FAILED', e);
  process.exit(1);
});
