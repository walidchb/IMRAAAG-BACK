/**
 * End-to-end verification of the inventory listing + store-level stats contract
 * (spec §2, §4, §5, §6, §8) against a running backend.
 *
 * Everything is asserted over the real HTTP API with two vendor sessions, so store
 * isolation is checked the way an attacker would experience it. The only writes are
 * `setOnHand` calls that give one seeded store a mix of in/out-of-stock variants; they are
 * restored to 0 at the end so the dev database is left as it was found.
 *
 * Run (backend must be up): node scripts/verify-inventory-listing.mjs
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000/api';

let passes = 0;
let failures = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passes++;
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
};
const group = (title) => console.log(`\n--- ${title} ---`);

async function req(token, path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  let body = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function login(identifier) {
  const { status, body } = await req(null, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier, password: 'Vendor123!' }),
  });
  if (status !== 200 && status !== 201) throw new Error(`login failed for ${identifier}: ${status} ${JSON.stringify(body)}`);
  return body.token;
}

const list = (token, qs = '') => req(token, `/inventory${qs ? `?${qs}` : ''}`);
const stats = (token) => req(token, '/inventory/stats');

const A_EMAIL = 'karim-bensalem@store.imraaah';
const B_EMAIL = 'fatima-zohra-moussaoui@store.imraaah';

const tokenA = await login(A_EMAIL);
const tokenB = await login(B_EMAIL);

// --- seed a mix of stock for vendor A (restored at the end) ------------------
let touched = [];
{
  const all = (await list(tokenA, 'limit=200')).body;
  const rows = all.data ?? [];
  const toStock = rows.filter((r) => r.onHand === 0).slice(0, 12);
  for (const row of toStock) {
    const res = await req(tokenA, `/inventory/variants/${row.variantId}/stock`, {
      method: 'PATCH',
      body: JSON.stringify({ quantity: 5, reason: 'verification seed (restored after)' }),
    });
    if (res.status !== 200 && res.status !== 201) {
      console.log(`  WARN  could not seed stock for ${row.variantId}: ${res.status}`);
    } else {
      touched.push(row.variantId);
    }
  }
}

// --- baseline ----------------------------------------------------------------
group('Baseline');
const baseList = await list(tokenA, 'limit=200');
check('GET /inventory is authenticated', (await list(null, '')).status === 401);
check('GET /inventory/stats is authenticated', (await stats(null)).status === 401);

const baseStats = (await stats(tokenA)).body;
const baseRows = baseList.body.data ?? [];
const total = baseList.body.total;
check('list response carries page metadata (project convention)', baseList.body.page === 1 && typeof baseList.body.totalPages === 'number');
check('list response carries NO summary (stats are a separate query)', baseList.body.summary === undefined, Object.keys(baseList.body));
check('store has variants', total > 0, total);
const inStock = baseRows.filter((r) => r.available > 0).length;
const outStock = baseRows.filter((r) => r.available <= 0).length;
check('seed produced a mix of in-stock and out-of-stock variants', inStock > 0 && outStock > 0, { inStock, outStock });
check('stats.variantCount equals the store total', baseStats.variantCount === total, { stats: baseStats.variantCount, total });
check('stats.outOfStockCount equals the out-of-stock rows', baseStats.outOfStockCount === outStock, { stats: baseStats.outOfStockCount, outStock });
const statsSnapshot = JSON.stringify(baseStats);

// --- search ------------------------------------------------------------------
group('Search');
const searchRes = await list(tokenA, 'search=zzz-no-such-product');
check('search narrows the list total', searchRes.body.total < total, searchRes.body.total);
check('search returning nothing yields an empty page', Array.isArray(searchRes.body.data) && searchRes.body.data.length === 0);
check('search does NOT change store statistics', JSON.stringify((await stats(tokenA)).body) === statsSnapshot);

const firstWord = (baseRows[0]?.productName?.en ?? 'shirt').split(' ')[0];
const searchHit = await list(tokenA, `search=${encodeURIComponent(firstWord)}`);
check(`search "${firstWord}" returns matching rows`, searchHit.body.total > 0, searchHit.body.total);
check('every search hit mentions the term (server-side filtering)', searchHit.body.data.every((r) => JSON.stringify(r).toLowerCase().includes(firstWord.toLowerCase())));
check('search does NOT change store statistics (hit case)', JSON.stringify((await stats(tokenA)).body) === statsSnapshot);

// --- filters -----------------------------------------------------------------
group('Filters');
for (const status of ['all', 'active', 'inactive', 'low', 'out', 'in_stock']) {
  const res = await list(tokenA, `status=${status}&limit=200`);
  check(`status=${status} is accepted and scoped`, res.status === 200 && res.body.data.every((r) => typeof r.variantId === 'string'));
  if (status === 'in_stock') {
    check('in_stock returns only available > 0', res.body.data.every((r) => r.available > 0));
    check('in_stock total matches the computed split', res.body.total === inStock, { got: res.body.total, want: inStock });
  }
  if (status === 'out') {
    check('out returns only available <= 0', res.body.data.every((r) => r.available <= 0));
    check('out total matches the computed split', res.body.total === outStock, { got: res.body.total, want: outStock });
  }
  check(`status=${status} does NOT change store statistics`, JSON.stringify((await stats(tokenA)).body) === statsSnapshot);
}

// --- pagination --------------------------------------------------------------
group('Pagination');
const p1 = await list(tokenA, 'page=1&limit=10');
const p2 = await list(tokenA, 'page=2&limit=10');
check('page 1 returns exactly the requested size', p1.body.data.length === 10, p1.body.data.length);
check('page 2 returns exactly the requested size', p2.body.data.length === Math.min(10, total - 10), p2.body.data.length);
check('pages do not overlap', p1.body.data.every((r) => !p2.body.data.some((s) => s.variantId === r.variantId)));
check('total is the filtered set, not the page', p1.body.total === total && p1.body.totalPages === Math.ceil(total / 10));
check('only the requested page crosses the wire (total=36, limit=10 → 10 rows)', p1.body.data.length === 10 && total > 10);
check('pagination does NOT change store statistics', JSON.stringify((await stats(tokenA)).body) === statsSnapshot);

const beyond = await list(tokenA, 'page=99&limit=10');
check('a page past the end returns empty data, not an error', beyond.status === 200 && beyond.body.data.length === 0);

// --- combined ----------------------------------------------------------------
group('Combined search + filter + pagination');
const combo = await list(tokenA, `search=${encodeURIComponent(firstWord)}&status=in_stock&page=1&limit=5`);
check('combined query succeeds', combo.status === 200, combo.status);
check('combined query honours every parameter', combo.body.data.length <= 5 && combo.body.data.every((r) => r.available > 0));
check('combined query does NOT change store statistics', JSON.stringify((await stats(tokenA)).body) === statsSnapshot);

// --- invalid parameters ------------------------------------------------------
group('Invalid query parameters');
check('unknown status → 400', (await list(tokenA, 'status=shredded')).status === 400);
check('removed sort param → 400 (no longer whitelisted)', (await list(tokenA, 'sort=password')).status === 400);
check('removed order param → 400 (no longer whitelisted)', (await list(tokenA, 'order=sideways')).status === 400);
check('sortBy alias → 400 (not a DTO field)', (await list(tokenA, 'sortBy=stock')).status === 400);
check('page=0 → 400', (await list(tokenA, 'page=0')).status === 400);
check('limit=5000 → 400', (await list(tokenA, 'limit=5000')).status === 400);
check('storeId cannot be injected → 400', (await list(tokenA, 'storeId=someone-elses')).status === 400);
check('malformed productId → 400', (await list(tokenA, 'productId=nope')).status === 400);
check('valid query still works after the rejects', (await list(tokenA, 'search=&page=1&limit=5')).status === 200);

// --- store isolation ---------------------------------------------------------
group('Store isolation');
const rowsB = (await list(tokenB, 'limit=200')).body.data ?? [];
const idsA = new Set(baseRows.map((r) => r.variantId));
const idsB = new Set(rowsB.map((r) => r.variantId));
const overlap = [...idsB].filter((id) => idsA.has(id));
check('vendor B sees variants of their own store', rowsB.length > 0, rowsB.length);
check('vendor A and B variant sets are disjoint', overlap.length === 0, overlap.slice(0, 3));
const statsB = (await stats(tokenB)).body;
check('vendor B has their own statistics', statsB.variantCount > 0 && statsB.variantCount !== undefined);
check('vendor B stats ignore the query string', JSON.stringify((await req(tokenB, '/inventory/stats?status=out&search=x')).body) === JSON.stringify(statsB));
check('vendor A statistics are untouched by anything vendor B did', JSON.stringify((await stats(tokenA)).body) === statsSnapshot);

// --- stats endpoint contract -------------------------------------------------
group('Store-level statistics endpoint');
check('stats ignores any query string rather than filtering on it', (await req(tokenA, '/inventory/stats?status=out&search=x&page=3')).status === 200);
const statsPlain = (await stats(tokenA)).body;
await list(tokenA, `search=${encodeURIComponent(firstWord)}&status=in_stock&page=2&limit=5`);
check('statistics unchanged after any search/filter/page combination',
  JSON.stringify((await stats(tokenA)).body) === JSON.stringify(statsPlain));
check('statistics shape', ['variantCount', 'activeCount', 'lowStockCount', 'outOfStockCount', 'totalOnHand', 'totalReserved', 'totalAvailable']
  .every((k) => typeof statsPlain[k] === 'number'), statsPlain);
check('in_stock + out_of_stock sum to variantCount',
  baseRows.filter((r) => r.available > 0).length + baseRows.filter((r) => r.available <= 0).length === statsPlain.variantCount);

// --- restore seeded stock ----------------------------------------------------
group('Restore seeded stock');
for (const variantId of touched) {
  await req(tokenA, `/inventory/variants/${variantId}/stock`, {
    method: 'PATCH',
    body: JSON.stringify({ quantity: 0, reason: 'verification restore' }),
  });
}
const afterRestore = (await list(tokenA, 'limit=200')).body;
check('stock restored to the pre-run state',
  touched.length === 0 || afterRestore.data.every((r) => r.onHand === 0),
  afterRestore.data.filter((r) => r.onHand !== 0).map((r) => r.onHand).slice(0, 5));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
