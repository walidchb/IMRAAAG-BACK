require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');
const { inventoryCollectionNames } = require('./lib/inventory-collections');
const { isValidEan13 } = require('../dist/common/barcode/ean13');

/**
 * Barcode/SKU/Label plan, Phase 9 — live barcode verification. Read-only — never writes.
 *
 * Where `audit-barcode-sku.js` reports the pre-rollout baseline (how many codes exist, whether
 * the unique indexes are present), this script gates the *contents*: every generated barcode
 * must be a correctly-checksummed EAN-13 in the internal `20` range, and no barcode may repeat
 * within a store (the DB index enforces it, but a dropped/loosely-defined index would not —
 * this catches exactly that). Exits non-zero on any violation so it can gate a release.
 *
 * Requires `npm run build` first (collection names resolve from the compiled schemas, and the
 * EAN-13 validator is the compiled backend implementation — the same one generation uses).
 *
 * Run: node scripts/verify-barcodes.js
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const PREFIX = '20';
const COLLECTIONS = inventoryCollectionNames();
const violations = [];

function report(rule, detail) {
  violations.push({ rule, detail });
  console.log(`  FAIL  [${rule}] ${detail}`);
}
function ok(rule, msg) {
  console.log(`  ok    [${rule}] ${msg}`);
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const variants = db.collection(COLLECTIONS.variants);

  console.log('[VERIFY BARCODES] Connected. Read-only.\n');

  const total = await variants.countDocuments({});
  const coded = await variants
    .find({ barcode: { $type: 'string' } }, { projection: { storeId: 1, barcode: 1, sku: 1 } })
    .toArray();

  console.log(`  total variants:              ${total}`);
  console.log(`  variants with a barcode:     ${coded.length}\n`);

  // 1. Every generated barcode is a valid EAN-13 in the internal prefix-20 range.
  const invalid = [];
  for (const v of coded) {
    if (!isValidEan13(v.barcode)) {
      invalid.push(v);
      report('ean13-valid', `variant ${v._id} (store ${v.storeId}) barcode "${v.barcode}" is not a valid EAN-13`);
    } else if (!String(v.barcode).startsWith(PREFIX)) {
      invalid.push(v);
      report('ean13-range', `variant ${v._id} barcode "${v.barcode}" is valid but outside the internal ${PREFIX} range`);
    }
  }
  if (invalid.length === 0) {
    ok('ean13-valid', `all ${coded.length} barcodes are valid ${PREFIX}-prefixed EAN-13`);
  }

  // 2. No barcode repeats within a store. (Across stores a repeat is fine — the number is only
  //    meaningful inside its own barcode series.)
  const byStore = new Map();
  for (const v of coded) {
    const key = String(v.storeId);
    if (!byStore.has(key)) byStore.set(key, []);
    byStore.get(key).push(v);
  }

  let duplicateGroups = 0;
  for (const [storeId, rows] of byStore) {
    const seen = new Map();
    for (const v of rows) {
      if (seen.has(v.barcode)) {
        duplicateGroups += 1;
        report(
          'store-unique',
          `store ${storeId} has barcode "${v.barcode}" on both variant ${seen.get(v.barcode)} and ${v._id}`,
        );
      } else {
        seen.set(v.barcode, v._id);
      }
    }
  }
  if (duplicateGroups === 0) {
    ok('store-unique', `no barcode repeats within any of the ${byStore.size} store(s) that hold codes`);
  }

  // 3. A SKU (where present) is present-but-non-empty, matching the index's partial filter.
  const blankSku = coded.filter((v) => v.sku !== undefined && v.sku !== null && String(v.sku).trim() === '');
  if (blankSku.length === 0) {
    ok('sku-non-empty', 'no blank SKU strings (a null/absent SKU is allowed)');
  } else {
    for (const v of blankSku) {
      report('sku-non-empty', `variant ${v._id} carries a blank-string SKU`);
    }
  }

  console.log('');
  if (violations.length === 0) {
    console.log('[VERIFY BARCODES] CLEAN');
    await mongoose.disconnect();
    process.exit(0);
  }
  console.log(`[VERIFY BARCODES] ${violations.length} ISSUE(S)`);
  for (const v of violations) console.log(`  - [${v.rule}] ${v.detail}`);
  await mongoose.disconnect();
  process.exit(1);
}

main().catch(function (e) {
  console.error('[VERIFY BARCODES] FAILED', e);
  process.exit(1);
});
