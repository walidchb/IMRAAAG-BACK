/*
 * k6-style parallel soak test for the order→inventory concurrency machinery.
 *
 * Phase 8 verification (roadmap §Phase 8): spin up a burst of concurrent order creates,
 * then a burst of concurrent confirms (the reserve path), against ONE variant, at HTTP
 * level against the running API. Asserts the Phase 1 invariants hold under load:
 *   - reserves never exceed on-hand (exactly `available` confirms succeed, the rest 409);
 *   - reservation leaves `onHand` untouched and moves `reserved` by exactly the sum of the
 *     confirmed quantities;
 *   - concurrent pre-dispatch cancels release everything and the variant returns to its
 *     exact baseline.
 *
 * Self-restoring: nothing is left behind (orders cancelled + soft-deleted, reserves
 * released). Requires the API to be up (`API_BASE`, default http://localhost:3000/api).
 *
 * Usage: node scripts/soak-concurrent-orders.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });

const API = process.env.API_BASE || 'http://localhost:3000/api';
const VENDOR_IDENTIFIER = process.env.SOAK_VENDOR_EMAIL || 'karim-bensalem@store.imraaah';
const VENDOR_PASSWORD = process.env.SOAK_VENDOR_PASSWORD || 'Vendor123!';
// Under the create-order throttle (10/min per IP), a burst above this would 429 before the
// first reserve. The shipped tests only need to saturate one variant's on-hand (12 @5), so
// 8 keeps the burst honest without tripping the limiter.
const K = 8;

let failures = 0;
function pass(label, detail) { console.log('  ok    [' + label + '] ' + detail); }
function fail(label, detail) { failures++; console.log('  FAIL  [' + label + '] ' + detail); }

async function req(method, path, { token, body, allow } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (allow && allow.includes(res.status)) return { status: res.status, json };
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return { status: res.status, json };
}

async function pollStock(token, variantId, want, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const { json } = await req('GET', `/inventory/variants/${variantId}/stock`, { token });
    if (json.reserved === want.reserved && json.onHand === want.onHand) return json;
    if (Date.now() - t0 > timeoutMs) return json;
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function main() {
  console.log('[SOAK] parallel-concurrent-order burst over the live API\n');

  const { json: login } = await req('POST', '/auth/login', {
    body: { identifier: VENDOR_IDENTIFIER, password: VENDOR_PASSWORD },
  });
  const token = login.token;
  pass('login', VENDOR_IDENTIFIER);

  const { json: store } = await req('GET', '/stores/mine', { token });
  const storeId = String(store._id);

  const { json: list } = await req('GET', '/inventory?limit=100&status=in_stock', { token });
  const usable = (list.data || []).filter((r) => r.available > 0);
  if (usable.length === 0) { console.log('[SOAK] SKIP — no in-stock variants to burst'); process.exit(0); }
  // Widest headroom first: most confirms should land, exactly exhausting available.
  const target = usable.sort((a, b) => b.available - a.available)[0];
  const variantId = target.variantId;

  const { json: base } = await req('GET', `/inventory/variants/${variantId}/stock`, { token });
  const expectOk = Math.min(K, base.available);
  pass('baseline', `variant ${variantId} onHand=${base.onHand} reserved=${base.reserved} available=${base.available} (burst K=${K})`);

  // 1) Concurrent guest creates (P0: reservations only happen on confirm; creates race but
  //    thesis + advisory compute against current balances, exactly as a checkout stampede).
  const created = await Promise.all(
    Array.from({ length: K }, (_, i) =>
      req('POST', '/orders', {
        body: {
          storeId,
          shippingMethod: 'home',
          shippingFee: 300,
          customer: {
            name: `Soak #${i}`,
            phone: '0555123456',
            wilaya: '16',
            commune: 'Bab Ezzouar',
            address: '1 Soak Street',
          },
          items: [{ productName: 'Soak Target', quantity: 1, price: 500, variantId }],
          total: 800,
        },
      }),
    ),
  );
  const orderIds = created.map((c) => String(c.json._id));
  pass('creates', `${orderIds.length}/${K} orders created concurrently`);

  // 2) Concurrent confirms — the reserve path. Exactly `expectOk` must land; the rest get
  //    RESERVED_STOCK_CONFLICT. Never oversell.
  const confirms = await Promise.all(
    orderIds.map((id) =>
      req('PATCH', `/orders/${id}`, { token, body: { status: 'confirmed' }, allow: [409] }),
    ),
  );
  const ok = confirms.filter((c) => c.status === 200).length;
  const conflicts = confirms.filter((c) => c.status === 409).length;
  if (ok !== expectOk) {
    fail('confirm-oversell', `expected ${expectOk} confirms to land, got ${ok} (conflicts ${conflicts})`);
  } else {
    pass('confirm-oversell', `${ok} confirmed, ${conflicts} reservations refused — available never went negative`);
  }

  const afterReserve = await pollStock(token, variantId, { onHand: base.onHand, reserved: ok });
  if (afterReserve.reserved !== ok) fail('reserve-accounting', `reserved=${afterReserve.reserved}, expected ${ok}`);
  else pass('reserve-accounting', `reserved=${afterReserve.reserved} (sum of confirmed qty), onHand unchanged=${afterReserve.onHand}`);
  if (afterReserve.available !== base.available - ok) fail('available-accounting', `available=${afterReserve.available}, expected ${base.available - ok}`);
  else pass('available-accounting', `available=${afterReserve.available}`);

  // 3) Concurrent pre-dispatch cancels — everything released, baseline restored exactly.
  const cancels = await Promise.all(
    orderIds.map((id) => req('PATCH', `/orders/${id}`, { token, body: { status: 'cancelled' }, allow: [409] })),
  );
  if (cancels.some((c) => c.status !== 200)) fail('cancel-all', `some cancels non-200: ${cancels.map((c) => c.status).join(',')}`);
  else pass('cancel-all', `all ${K} orders cancelled concurrently`);

  const afterRelease = await pollStock(token, variantId, { onHand: base.onHand, reserved: 0 });
  if (afterRelease.reserved !== 0) fail('release-accounting', `reserved=${afterRelease.reserved}, expected 0`);
  else pass('release-accounting', `reserved=0`);
  if (afterRelease.available !== base.available) fail('release-restore', `available=${afterRelease.available}, expected ${base.available}`);
  else pass('release-restore', `available=${afterRelease.available} == baseline`);

  // 4) Cleanup — soft-delete the burst orders so the store and ledger stay tidy.
  const dels = await Promise.all(orderIds.map((id) => req('DELETE', `/orders/${id}`, { token })));
  const delOk = dels.filter((d) => d.status === 200).length;
  if (delOk !== orderIds.length) fail('teardown', `${delOk}/${orderIds.length} cleanup deletes`);
  else pass('teardown', `${orderIds.length} burst orders soft-deleted`);

  console.log('');
  if (failures === 0) { console.log('[SOAK] PASS'); process.exit(0); }
  console.log('[SOAK] ' + failures + ' FAILURE(S)');
  process.exit(1);
}

main().catch(function (e) { console.error('[SOAK] FAILED', e); process.exit(1); });