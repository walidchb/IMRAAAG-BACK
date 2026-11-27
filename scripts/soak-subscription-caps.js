require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

/**
 * Plans & Subscriptions — live concurrency soak for the product cap (SUB-008).
 *
 * Sets the store's snapshot product limit to `activeProducts + 1`, fires `K` parallel
 * `POST /products`, and asserts exactly ONE succeeds — the per-store subscription lock must
 * serialize the count+insert. Restores the original snapshot and deletes the created product.
 *
 * Requirements: API up (`API_BASE`, default http://localhost:3000/api), MongoDB reachable, and
 * subscription feature enforcement ON for the vendor's store (otherwise the cap is not enforced).
 *
 * Self-restoring. Run: node scripts/soak-subscription-caps.js
 */

const API = process.env.API_BASE || 'http://localhost:3000/api';
const VENDOR_IDENTIFIER = process.env.SOAK_VENDOR_EMAIL || 'karim-bensalem@store.imraaah';
const VENDOR_PASSWORD = process.env.SOAK_VENDOR_PASSWORD || 'Vendor123!';
const MONGO_URI = process.env.MONGODB_URI;
const K = 5;

let failures = 0;
function pass(label, detail) {
  console.log('  ok    [' + label + '] ' + detail);
}
function fail(label, detail) {
  failures += 1;
  console.log('  FAIL  [' + label + '] ' + detail);
}

async function req(method, path, { token, body, allow } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (allow && allow.includes(res.status)) return { status: res.status, json };
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return { status: res.status, json };
}

async function main() {
  if (!MONGO_URI) {
    console.error('MONGODB_URI required');
    process.exit(1);
  }
  console.log('[SOAK CAPS] product-cap concurrency\n');

  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  let token;
  let storeId;
  try {
    const { json: login } = await req('POST', '/auth/login', {
      body: { identifier: VENDOR_IDENTIFIER, password: VENDOR_PASSWORD },
    });
    token = login.token;
    const { json: store } = await req('GET', '/stores/mine', { token });
    storeId = String(store._id);
  } catch {
    // Credentials may have drifted in the test DB; mint a vendor session from a store owner.
    const subs = await db.collection('subscriptions').find({}).toArray();
    for (const sub of subs) {
      const id = String(sub.storeId);
      const store = await db.collection('stores').findOne({
        _id: { $in: [id, new mongoose.Types.ObjectId(id)] },
      });
      if (!store?.vendorId) continue;
      const user = await db.collection('users').findOne({
        _id: {
          $in: [String(store.vendorId), new mongoose.Types.ObjectId(String(store.vendorId))],
        },
        role: 'VENDOR',
        isActive: true,
      });
      if (!user) continue;
      token = jwt.sign(
        {
          sub: String(user._id),
          email: user.email,
          role: user.role,
          tokenVersion: user.tokenVersion ?? 0,
        },
        process.env.JWT_SECRET,
        { expiresIn: '1h' },
      );
      storeId = String(store._id);
      break;
    }
  }
  if (!token || !storeId) {
    console.log('[SOAK CAPS] SKIP — no vendor session/store available.');
    await mongoose.disconnect();
    return;
  }

  const { json: me } = await req('GET', '/subscriptions/me', { token });
  if (!me.featureEnforcementEnabled) {
    console.log('[SOAK CAPS] SKIP — subscription feature enforcement is off for this store.');
    await mongoose.disconnect();
    return;
  }
  const storeIn = { $in: [storeId, new mongoose.Types.ObjectId(storeId)] };
  const categoryDoc = await db
    .collection('categories')
    .findOne({ storeId: storeIn, isDeleted: { $ne: true } });
  const subCategoryDoc =
    categoryDoc &&
    (await db.collection('subcategories').findOne({
      storeId: storeIn,
      categoryId: categoryDoc._id,
      isDeleted: { $ne: true },
    }));
  if (!categoryDoc || !subCategoryDoc) {
    console.log('[SOAK CAPS] SKIP — no category/subcategory to create a product.');
    await mongoose.disconnect();
    return;
  }
  const categoryId = String(categoryDoc._id);
  const subCategoryId = String(subCategoryDoc._id);

  const subFilter = {
    storeId: { $in: [storeId, new mongoose.Types.ObjectId(storeId)] },
  };
  const subscription = await db.collection('subscriptions').findOne(subFilter);
  if (!subscription) {
    console.log('[SOAK CAPS] SKIP — store has no subscription row.');
    await mongoose.disconnect();
    return;
  }
  const originalSnapshot = JSON.parse(JSON.stringify(subscription.planSnapshot));
  const activeProducts = await db
    .collection('products')
    .countDocuments({
      storeId: { $in: [storeId, new mongoose.Types.ObjectId(storeId)] },
      published: true,
      isArchived: { $ne: true },
    });

  const tempSnapshot = JSON.parse(JSON.stringify(originalSnapshot));
  tempSnapshot.limits = { ...(tempSnapshot.limits ?? {}), maxProducts: activeProducts + 1 };
  if (tempSnapshot.entitlements) {
    tempSnapshot.entitlements.maxProducts = activeProducts + 1;
  }

  const createdIds = [];
  try {
    await db
      .collection('subscriptions')
      .updateOne({ _id: subscription._id }, { $set: { planSnapshot: tempSnapshot } });
    pass('setup', `activeProducts=${activeProducts} temp limit=${activeProducts + 1}, burst K=${K}`);

    const base = {
      nameEn: 'Soak cap product',
      storyEn: 'Soak concurrency product',
      category: categoryId,
      subCategory: subCategoryId,
      originalPrice: 100,
      weight: 1,
      published: true,
      image: 'https://example.com/soak-cap.jpg',
      images: ['https://example.com/soak-cap.jpg'],
    };

    const results = await Promise.all(
      Array.from({ length: K }, (_, i) =>
        req('POST', '/products', {
          token,
          body: { ...base, nameEn: `Soak cap product ${Date.now()}-${i}` },
          allow: [201, 400, 403, 409],
        }).catch((err) => ({ status: 0, json: { message: String(err?.message ?? err) } })),
      ),
    );

    const ok = results.filter((r) => r.status === 201);
    const refused = results.filter(
      (r) => r.status === 409 && (r.json?.code === 'SUBSCRIPTION_PRODUCT_LIMIT_REACHED' || r.json?.error === 'SUBSCRIPTION_PRODUCT_LIMIT_REACHED'),
    );
    if (ok.length !== 1 || refused.length !== K - 1) {
      console.log(
        '        statuses: ' +
          results
            .map(
              (r) =>
                `${r.status}:${r.json?.code ?? r.json?.message ?? ''}:${JSON.stringify(
                  r.json?.params ?? r.json?.details ?? '',
                )}`,
            )
            .join(' | '),
      );
    }
    for (const row of ok) {
      const id = row.json?.id ?? row.json?._id;
      if (id) createdIds.push(String(id));
    }

    if (ok.length === 1) pass('cap', 'exactly one concurrent create succeeded');
    else fail('cap', `expected exactly 1 success, got ${ok.length}`);
    if (refused.length === K - 1) pass('refused', `${refused.length} refused with the cap code`);
    else fail('refused', `expected ${K - 1} cap refusals, got ${refused.length}`);
  } finally {
    for (const id of createdIds) {
      await req('DELETE', `/products/${id}`, { token, allow: [200, 204, 404] }).catch(() => {});
    }
    await db
      .collection('subscriptions')
      .updateOne({ _id: subscription._id }, { $set: { planSnapshot: originalSnapshot } });
    const after = await db
      .collection('products')
      .countDocuments({
        storeId: { $in: [storeId, new mongoose.Types.ObjectId(storeId)] },
        published: true,
        isArchived: { $ne: true },
      });
    if (after === activeProducts) pass('cleanup', `activeProducts restored to ${after}`);
    else fail('cleanup', `activeProducts ${after} != baseline ${activeProducts}`);
    await mongoose.disconnect();
  }

  if (failures > 0) {
    console.error(`\n[SOAK CAPS] FAILED (${failures})`);
    process.exit(1);
  }
  console.log('\n[SOAK CAPS] PASS');
}

main().catch(async (err) => {
  console.error('[SOAK CAPS] failed:', err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
