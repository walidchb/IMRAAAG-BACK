require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

let normalizeSubdomain;
let isReservedStoreSubdomain;
try {
  ({ normalizeSubdomain } = require('../dist/modules/stores/store-subdomain.util'));
  ({ isReservedStoreSubdomain } = require('../dist/common/constants/store-subdomain.const'));
} catch (err) {
  console.error(
    '[VERIFY STORE SUBDOMAINS] Could not load the compiled backend. Run `npm run build` first.',
  );
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
}

/**
 * Store Subdomain plan, §4.4 - live read-only verifier. Never writes.
 *
 * Gates the contents, not just the presence, of the `subdomain` field: the partial unique
 * index must have the exact shape, every stored value must already be canonical, valid and
 * non-reserved, and no value may repeat. Stores without a subdomain are reported as a warning
 * (the field is additive and migration is optional for legacy stores) but are not violations.
 *
 * Requires `npm run build` first (the same normalization/reserved implementation the service
 * uses, never a copy).
 *
 * Run: node scripts/verify-store-subdomains.js
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const INDEX_NAME = 'store_subdomain_unique';
const violations = [];
const warnings = [];

function report(rule, detail) {
  violations.push({ rule, detail });
  console.log(`  FAIL  [${rule}] ${detail}`);
}
function warn(rule, msg) {
  warnings.push({ rule, msg });
  console.log(`  warn  [${rule}] ${msg}`);
}
function ok(rule, msg) {
  console.log(`  ok    [${rule}] ${msg}`);
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const stores = db.collection('stores');

  console.log('[VERIFY STORE SUBDOMAINS] Connected. Read-only.\n');

  // 1. Exact index shape.
  const indexes = await stores.indexes();
  const index = indexes.find((i) => i.name === INDEX_NAME);
  if (!index) {
    report('index', `index "${INDEX_NAME}" is missing`);
  } else {
    const key = index.key || {};
    const partial = index.partialFilterExpression || {};
    const shapeOk =
      index.unique === true &&
      key.subdomain === 1 &&
      Object.keys(key).length === 1 &&
      partial.subdomain &&
      partial.subdomain.$type === 'string';
    if (shapeOk) {
      ok('index', `"${INDEX_NAME}" is unique on { subdomain } with a string partial filter`);
    } else {
      report('index', `unexpected definition: ${JSON.stringify({ key, unique: index.unique, partial })}`);
    }
  }

  // 2. Stored values are canonical, valid, non-reserved, and unique.
  const all = await stores
    .find({}, { projection: { _id: 1, storeName: 1, status: 1, subdomain: 1 } })
    .toArray();
  const withSubdomain = all.filter((s) => typeof s.subdomain === 'string' && s.subdomain);
  const unassigned = all.length - withSubdomain.length;

  console.log(`  total stores:                ${all.length}`);
  console.log(`  stores with a subdomain:     ${withSubdomain.length}`);
  console.log(`  stores without a subdomain:  ${unassigned}\n`);

  const seen = new Map();
  for (const store of withSubdomain) {
    const value = store.subdomain;
    const normalized = normalizeSubdomain(value);
    if (normalized === null) {
      report('valid', `store ${store._id} has an invalid subdomain "${value}"`);
    } else if (normalized !== value) {
      report('normalized', `store ${store._id} stores "${value}" but normalizes to "${normalized}"`);
    }
    if (value.length < 3 || value.length > 30) {
      report('length', `store ${store._id} subdomain "${value}" is outside 3-30 chars`);
    }
    if (isReservedStoreSubdomain(value)) {
      report('reserved', `store ${store._id} uses the reserved subdomain "${value}"`);
    }
    if (seen.has(value)) {
      report('unique', `subdomain "${value}" is used by both ${seen.get(value)} and ${store._id}`);
    } else {
      seen.set(value, store._id);
    }
  }
  if (violations.length === 0) {
    ok('contents', `all ${withSubdomain.length} stored subdomains are canonical, valid and unique`);
  }

  // 3. Every active store is reachable by its own subdomain.
  const active = withSubdomain.filter((s) => s.status === 'Active');
  let lookupMismatches = 0;
  for (const store of active) {
    const found = await stores.findOne({ subdomain: store.subdomain }, { projection: { _id: 1 } });
    if (!found || String(found._id) !== String(store._id)) {
      lookupMismatches += 1;
      report('lookup', `subdomain "${store.subdomain}" does not resolve to store ${store._id}`);
    }
  }
  if (lookupMismatches === 0) {
    ok('lookup', `all ${active.length} active subdomains resolve to their own store`);
  }

  if (unassigned > 0) {
    warn('coverage', `${unassigned} store(s) have no subdomain (run the migration to backfill)`);
  }

  console.log('');
  if (violations.length === 0) {
    console.log('[VERIFY STORE SUBDOMAINS] CLEAN');
    if (warnings.length > 0) console.log(`[VERIFY STORE SUBDOMAINS] ${warnings.length} warning(s)`);
    await mongoose.disconnect();
    process.exit(0);
  }
  console.log(`[VERIFY STORE SUBDOMAINS] ${violations.length} ISSUE(S)`);
  for (const v of violations) console.log(`  - [${v.rule}] ${v.detail}`);
  await mongoose.disconnect();
  process.exit(1);
}

main().catch(function (e) {
  console.error('[VERIFY STORE SUBDOMAINS] FAILED', e);
  process.exit(1);
});
