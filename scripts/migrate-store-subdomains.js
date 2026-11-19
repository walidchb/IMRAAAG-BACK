/**
 * Migration: backfill `subdomain` on the `stores` collection (Store Subdomain plan, §4.4).
 *
 * Every store should be reachable at `<subdomain>.imraaah.com`, so stores created before the
 * feature gets a deterministic subdomain without any owner action. The field is additive and
 * nullable; nothing else (name, slug, ownership, products, orders) is touched.
 *
 * Algorithm (idempotent - only touches stores missing `subdomain`):
 *   1. Ensure the partial unique index `store_subdomain_unique` exists.
 *   2. base = normalize(truncate(storeSlug || slugify(storeName), 30)).
 *   3. Invalid/reserved base -> `store-<last 6 chars of _id>`.
 *   4. Taken base -> `base-2`, `base-3`, ... up to `base-50`.
 *   5. Write with a filtered update `{ _id, subdomain: { $exists: false } }` so a concurrent
 *      manual change always wins.
 *
 * Run:
 *   node scripts/migrate-store-subdomains.js [--dry-run] [--apply]
 *        [--force-candidate=<storeId>=<subdomain>]
 *
 * Requires `npm run build` first (normalization/reserved rules come from the compiled backend,
 * the same implementation the service uses - never a copy).
 *
 * BEFORE RUNNING --apply: take a MongoDB backup.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

let normalizeSubdomain;
let isReservedStoreSubdomain;
try {
  ({ normalizeSubdomain } = require('../dist/modules/stores/store-subdomain.util'));
  ({ isReservedStoreSubdomain } = require('../dist/common/constants/store-subdomain.const'));
} catch (err) {
  console.error(
    '[STORE-SUBDOMAIN MIGRATION] Could not load the compiled backend. Run `npm run build` first.',
  );
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
}

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI environment variable is required');
  process.exit(1);
}

const MAX = 30;
const MAX_SUFFIX = 50;
const INDEX_NAME = 'store_subdomain_unique';

const isApply = process.argv.includes('--apply');
const isDryRun = !isApply;

const forceCandidates = new Map();
for (const arg of process.argv) {
  const m = /^--force-candidate=([0-9a-fA-F]{24})=(.+)$/.exec(arg);
  if (m) forceCandidates.set(m[1], m[2]);
}

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function truncate(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}

function deriveBase(store) {
  const source = store.storeSlug || slugify(store.storeName);
  const trimmed = truncate(String(source || ''), MAX).replace(/-+$/g, '').replace(/^[ -]+/g, '');
  const normalized = normalizeSubdomain(trimmed);
  if (!normalized || isReservedStoreSubdomain(normalized)) return null;
  return normalized;
}

function candidateWithSuffix(base, n) {
  const suffix = `-${n}`;
  const head = truncate(base, MAX - suffix.length).replace(/-+$/g, '');
  const candidate = normalizeSubdomain(`${head}${suffix}`);
  return candidate && !isReservedStoreSubdomain(candidate) ? candidate : null;
}

function fallbackBase(store) {
  const id = String(store._id);
  return normalizeSubdomain(`store-${id.slice(-6)}`);
}

function pickCandidate(store, taken) {
  const forced = forceCandidates.get(String(store._id));
  if (forced) {
    const normalized = normalizeSubdomain(forced);
    if (!normalized || isReservedStoreSubdomain(normalized)) {
      return { candidate: null, reason: `forced candidate "${forced}" is invalid or reserved`, forced: true };
    }
    if (taken.has(normalized)) {
      return { candidate: null, reason: `forced candidate "${normalized}" is already taken`, forced: true };
    }
    return { candidate: normalized, forced: true };
  }

  const base = deriveBase(store);
  let reservedFallback = false;
  let start = base;
  if (!start) {
    start = fallbackBase(store);
    reservedFallback = true;
  }
  if (!start) return { candidate: null, reason: 'could not derive a valid label' };
  if (!taken.has(start)) return { candidate: start, reservedFallback };

  for (let n = 2; n <= MAX_SUFFIX; n += 1) {
    const candidate = candidateWithSuffix(start, n);
    if (candidate && !taken.has(candidate)) {
      return { candidate, reservedFallback, collided: true };
    }
  }
  return { candidate: null, reason: `no free label after ${MAX_SUFFIX} attempts`, reservedFallback };
}

function describeIndex(index) {
  return JSON.stringify({
    key: index.key,
    unique: index.unique,
    partialFilterExpression: index.partialFilterExpression,
  });
}

async function ensureIndex(col) {
  const indexes = await col.indexes();
  const existing = indexes.find((i) => i.name === INDEX_NAME);
  if (existing) {
    const sameShape =
      existing.unique === true &&
      existing.key &&
      existing.key.subdomain === 1 &&
      Object.keys(existing.key).length === 1 &&
      existing.partialFilterExpression &&
      existing.partialFilterExpression.subdomain &&
      existing.partialFilterExpression.subdomain.$type === 'string';
    if (!sameShape) {
      console.error(
        `[STORE-SUBDOMAIN MIGRATION] Conflicting index "${INDEX_NAME}": ${describeIndex(existing)}`,
      );
      return false;
    }
    console.log(`[STORE-SUBDOMAIN MIGRATION] Index "${INDEX_NAME}" already present.`);
    return true;
  }

  const other = indexes.find(
    (i) => i.key && Object.keys(i.key).length === 1 && i.key.subdomain === 1,
  );
  if (other) {
    console.error(
      `[STORE-SUBDOMAIN MIGRATION] Conflicting existing subdomain index "${other.name}": ${describeIndex(other)}`,
    );
    return false;
  }

  if (isDryRun) {
    console.log(`[STORE-SUBDOMAIN MIGRATION] Dry run: index "${INDEX_NAME}" would be created.`);
    return true;
  }

  await col.createIndex(
    { subdomain: 1 },
    {
      unique: true,
      partialFilterExpression: { subdomain: { $type: 'string' } },
      name: INDEX_NAME,
    },
  );
  console.log(`[STORE-SUBDOMAIN MIGRATION] Index "${INDEX_NAME}" created.`);
  return true;
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const col = db.collection('stores');

  console.log(`[STORE-SUBDOMAIN MIGRATION] Connected. Mode: ${isDryRun ? 'DRY RUN' : 'APPLY'}`);

  const indexOk = await ensureIndex(col);
  if (!indexOk) {
    console.error('[STORE-SUBDOMAIN MIGRATION] Refusing to write with a conflicting index.');
    await mongoose.disconnect();
    process.exit(1);
  }

  const stores = await col
    .find({}, { projection: { _id: 1, storeName: 1, storeSlug: 1, subdomain: 1 } })
    .toArray();

  const taken = new Set();
  for (const s of stores) {
    if (typeof s.subdomain === 'string' && s.subdomain) taken.add(s.subdomain);
  }

  const missing = stores.filter((s) => !(typeof s.subdomain === 'string' && s.subdomain));
  console.log(
    `[STORE-SUBDOMAIN MIGRATION] stores=${stores.length}, already assigned=${stores.length - missing.length}, missing=${missing.length}`,
  );

  let assigned = 0;
  let skipped = 0;
  let reservedFallbacks = 0;
  let collisions = 0;
  const planned = [];

  for (const store of missing) {
    const picked = pickCandidate(store, taken);
    if (!picked.candidate) {
      skipped += 1;
      console.log(`  skip   store ${store._id} (${store.storeName}): ${picked.reason}`);
      continue;
    }
    if (picked.reservedFallback) reservedFallbacks += 1;
    if (picked.collided) collisions += 1;

    planned.push({ store, candidate: picked.candidate });
    taken.add(picked.candidate);

    if (isDryRun) {
      assigned += 1;
      console.log(`  plan   store ${store._id} (${store.storeName}) -> ${picked.candidate}`);
      continue;
    }

    const res = await col.updateOne(
      { _id: store._id, subdomain: { $exists: false } },
      { $set: { subdomain: picked.candidate } },
    );
    if (res.modifiedCount === 1) {
      assigned += 1;
      console.log(`  set    store ${store._id} (${store.storeName}) -> ${picked.candidate}`);
    } else {
      skipped += 1;
      console.log(`  skip   store ${store._id} (${store.storeName}): changed concurrently`);
    }
  }

  const remaining = await col.countDocuments({
    $or: [{ subdomain: { $exists: false } }, { subdomain: null }],
  });

  console.log('');
  console.log('[STORE-SUBDOMAIN MIGRATION] Summary');
  console.log(`  stores:                ${stores.length}`);
  console.log(`  ${isDryRun ? 'planned' : 'assigned'}:              ${assigned}`);
  console.log(`  skipped:               ${skipped}`);
  console.log(`  reserved fallbacks:    ${reservedFallbacks}`);
  console.log(`  collisions:            ${collisions}`);
  console.log(`  remaining unassigned:  ${remaining}`);
  if (planned.length > 0 && isDryRun) {
    console.log('[STORE-SUBDOMAIN MIGRATION] DRY RUN COMPLETE (nothing written)');
  }

  await mongoose.disconnect();
  if (!isDryRun && remaining > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
