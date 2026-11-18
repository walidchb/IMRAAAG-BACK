require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Boxes feature — read-only data verifier (plan §10 Phase 7 / §12.2).
 *
 * Gates the invariants that the unit tests cannot see in a live database:
 *   - Box ownership: every eligible product/variant belongs to the Box's store.
 *   - Published Boxes have non-empty eligibility, no archived/deleted/inactive eligibility,
 *     and a globally unique slug.
 *   - Every Order.bundles[] entry has matching `bundleGroupId` component lines and vice-versa.
 *   - `lineTotal = price × quantity`, `component.quantity = quantityPerBox × bundle.quantity`,
 *     reference totals/savings are consistent, and the order total follows BR9.
 *   - No credential-looking keys in Box or order-bundle snapshots.
 *
 * READ-ONLY: never writes. Exits 1 on any violation.
 *
 * Run: node scripts/verify-boxes.js
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const COLLECTIONS = {
  boxes: 'boxes',
  products: 'products',
  variants: 'productvariants',
  orders: 'orders',
};

const violations = [];
function report(rule, detail) {
  violations.push({ rule, detail });
  console.log(`  FAIL  [${rule}] ${detail}`);
}
function ok(rule, msg) {
  console.log(`  ok    [${rule}] ${msg}`);
}
function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const CREDENTIAL_KEY_RE = /(password|passwd|secret|api[_-]?token|private[_-]?key|access[_-]?token)/i;

function scanCredentials(rule, label, value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, inner] of Object.entries(value)) {
    if (CREDENTIAL_KEY_RE.test(key)) {
      report(rule, `${label} contains a credential-looking key "${key}"`);
    } else if (inner && typeof inner === 'object') {
      scanCredentials(rule, label, inner);
    }
  }
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const boxes = db.collection(COLLECTIONS.boxes);
  const products = db.collection(COLLECTIONS.products);
  const variants = db.collection(COLLECTIONS.variants);
  const orders = db.collection(COLLECTIONS.orders);

  console.log('[VERIFY BOXES] Connected. Read-only.\n');

  const allBoxes = await boxes.find({}).toArray();
  const allProducts = await products
    .find({}, { projection: { _id: 1, storeId: 1, nameEn: 1, published: 1, isArchived: 1 } })
    .toArray();
  const allVariants = await variants
    .find({}, { projection: { _id: 1, storeId: 1, productId: 1, isActive: 1, isDeleted: 1 } })
    .toArray();

  const productById = new Map(allProducts.map((p) => [String(p._id), p]));
  const variantById = new Map(allVariants.map((v) => [String(v._id), v]));

  console.log(`  boxes:     ${allBoxes.length}`);
  console.log(`  products:  ${allProducts.length}`);
  console.log(`  variants:  ${allVariants.length}\n`);

  // 1 + 2. Ownership and eligibility health.
  let publishedChecked = 0;
  let draftSkipped = 0;
  let eligibilityFailures = 0;
  const slugSeen = new Map();

  for (const box of allBoxes) {
    const label = `box ${box._id} (${box.slug || 'no-slug'})`;

    if (slugSeen.has(box.slug)) {
      report('slug-unique', `${label} duplicates slug "${box.slug}" (also ${slugSeen.get(box.slug)})`);
    } else if (box.slug) {
      slugSeen.set(box.slug, String(box._id));
    }

    scanCredentials('no-credentials', label, box);

    const eligible = Array.isArray(box.eligibleItems) ? box.eligibleItems : [];
    const variantIds = eligible.flatMap((item) =>
      Array.isArray(item.variantIds) ? item.variantIds.map(String) : [],
    );

    if (box.published === true) {
      publishedChecked += 1;
      if (eligible.length === 0 || variantIds.length === 0) {
        report('published-eligibility', `${label} is published with no eligible variant`);
        eligibilityFailures += 1;
      }
    } else {
      draftSkipped += 1;
    }

    for (const item of eligible) {
      const product = productById.get(String(item.productId));
      if (!product) {
        if (box.published === true) {
          report('eligibility-product', `${label} references missing product ${item.productId}`);
          eligibilityFailures += 1;
        }
        continue;
      }
      if (!sameId(product.storeId, box.storeId)) {
        report('eligibility-store', `${label} product ${item.productId} belongs to another store`);
        eligibilityFailures += 1;
      }
      if (box.published === true && (product.published !== true || product.isArchived === true)) {
        report(
          'eligibility-product',
          `${label} eligible product ${item.productId} is ${product.isArchived ? 'archived' : 'draft'}`,
        );
        eligibilityFailures += 1;
      }

      for (const variantId of item.variantIds || []) {
        const variant = variantById.get(String(variantId));
        if (!variant) {
          if (box.published === true) {
            report('eligibility-variant', `${label} references missing variant ${variantId}`);
            eligibilityFailures += 1;
          }
          continue;
        }
        if (!sameId(variant.storeId, box.storeId)) {
          report('eligibility-store', `${label} variant ${variantId} belongs to another store`);
          eligibilityFailures += 1;
        }
        if (!sameId(variant.productId, item.productId)) {
          report(
            'eligibility-variant',
            `${label} variant ${variantId} does not belong to product ${item.productId}`,
          );
          eligibilityFailures += 1;
        }
        if (box.published === true && (variant.isActive === false || variant.isDeleted === true)) {
          report(
            'eligibility-variant',
            `${label} eligible variant ${variantId} is ${variant.isDeleted ? 'deleted' : 'inactive'}`,
          );
          eligibilityFailures += 1;
        }
      }
    }
  }

  if (eligibilityFailures === 0) {
    ok('eligibility', `all ${publishedChecked} published Box(es) have healthy eligibility`);
  }
  if (draftSkipped > 0) {
    console.log(`  info  draft Box(es) skipped for publish-only checks: ${draftSkipped}`);
  }

  // 3. Orders with Box snapshots.
  const bundleOrders = await orders
    .find(
      {
        $or: [
          { 'bundles.0': { $exists: true } },
          { 'items.bundleGroupId': { $exists: true } },
        ],
      },
      {
        projection: {
          _id: 1,
          orderNo: 1,
          total: 1,
          shippingFee: 1,
          items: 1,
          bundles: 1,
        },
      },
    )
    .toArray();

  console.log(`\n  orders with Box data: ${bundleOrders.length}`);

  let bundleFailures = 0;
  let bundleLines = 0;
  let componentLines = 0;

  for (const order of bundleOrders) {
    const label = `order ${order.orderNo || order._id}`;
    const bundles = Array.isArray(order.bundles) ? order.bundles : [];
    const items = Array.isArray(order.items) ? order.items : [];

    scanCredentials('no-credentials', label, bundles);

    const bundleGroupIds = new Set(bundles.map((b) => String(b.bundleGroupId)));
    const itemGroupIds = new Set(
      items.filter((i) => i.bundleGroupId).map((i) => String(i.bundleGroupId)),
    );

    for (const bundle of bundles) {
      bundleLines += 1;
      const groupId = String(bundle.bundleGroupId);
      const lineItems = items.filter((i) => String(i.bundleGroupId) === groupId);

      if (lineItems.length === 0) {
        report('bundle-lines', `${label} bundle ${groupId} has no component item lines`);
        bundleFailures += 1;
      }

      if (Math.abs(num(bundle.lineTotal) - num(bundle.price) * num(bundle.quantity)) > 0.01) {
        report(
          'bundle-line-total',
          `${label} bundle ${groupId} lineTotal ${bundle.lineTotal} != price ${bundle.price} × quantity ${bundle.quantity}`,
        );
        bundleFailures += 1;
      }

      const expectedReference = (bundle.contents || []).reduce(
        (sum, content) =>
          sum + num(content.referenceUnitPrice) * num(content.quantityPerBox) * num(bundle.quantity),
        0,
      );
      if (Math.abs(num(bundle.referenceTotal) - expectedReference) > 0.01) {
        report(
          'bundle-reference-total',
          `${label} bundle ${groupId} referenceTotal ${bundle.referenceTotal} != components ${expectedReference}`,
        );
        bundleFailures += 1;
      }
      if (
        Math.abs(
          num(bundle.savings) - Math.max(0, num(bundle.referenceTotal) - num(bundle.lineTotal)),
        ) > 0.01
      ) {
        report('bundle-savings', `${label} bundle ${groupId} savings is inconsistent`);
        bundleFailures += 1;
      }

      const contentByLineId = new Map(
        (bundle.contents || []).map((content) => [String(content.lineId), content]),
      );
      for (const item of lineItems) {
        componentLines += 1;
        const content = contentByLineId.get(String(item.lineId));
        if (!content) {
          report(
            'bundle-lines',
            `${label} component item ${item._id || item.lineId} has no contents entry in bundle ${groupId}`,
          );
          bundleFailures += 1;
          continue;
        }
        if (!sameId(content.variantId, item.variantId)) {
          report('bundle-lines', `${label} component ${item.lineId} variant does not match its contents entry`);
          bundleFailures += 1;
        }
        const expectedQty = num(content.quantityPerBox) * num(bundle.quantity);
        if (Math.abs(num(item.quantity) - expectedQty) > 0.01) {
          report(
            'bundle-quantity',
            `${label} component ${item.lineId} quantity ${item.quantity} != quantityPerBox ${content.quantityPerBox} × ${bundle.quantity}`,
          );
          bundleFailures += 1;
        }
        if (
          item.bundleReferencePrice != null &&
          Math.abs(num(item.bundleReferencePrice) - num(content.referenceUnitPrice)) > 0.01
        ) {
          report(
            'bundle-reference-price',
            `${label} component ${item.lineId} reference price ${item.bundleReferencePrice} != contents ${content.referenceUnitPrice}`,
          );
          bundleFailures += 1;
        }
      }
    }

    for (const groupId of itemGroupIds) {
      if (!bundleGroupIds.has(groupId)) {
        report('bundle-lines', `${label} component lines reference missing bundle group ${groupId}`);
        bundleFailures += 1;
      }
    }

    const expectedTotal =
      items
        .filter((item) => !item.bundleGroupId)
        .reduce((sum, item) => sum + num(item.price) * num(item.quantity), 0) +
      bundles.reduce((sum, bundle) => sum + num(bundle.lineTotal), 0) +
      num(order.shippingFee);
    if (Math.abs(num(order.total) - expectedTotal) > 0.01) {
      report(
        'order-total',
        `${label} total ${order.total} != non-bundle items + bundle lineTotals + shipping ${expectedTotal}`,
      );
      bundleFailures += 1;
    }
  }

  if (bundleFailures === 0) {
    ok(
      'bundle-orders',
      `${bundleOrders.length} order(s), ${bundleLines} Box line(s), ${componentLines} component line(s) consistent`,
    );
  }

  console.log('');
  if (violations.length === 0) {
    console.log('[VERIFY BOXES] CLEAN');
    await mongoose.disconnect();
    process.exit(0);
  }
  console.log(`[VERIFY BOXES] ${violations.length} ISSUE(S)`);
  for (const v of violations) console.log(`  - [${v.rule}] ${v.detail}`);
  await mongoose.disconnect();
  process.exit(1);
}

main().catch(function (e) {
  console.error('[VERIFY BOXES] FAILED', e);
  process.exit(1);
});
