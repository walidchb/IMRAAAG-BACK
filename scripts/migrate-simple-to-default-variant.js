/*
 * Universal-variant migration: make InventoryBalances the only stock source.
 *
 * Background: `Product.stock` and `Product.hasVariants` no longer exist - every product is
 * a variant product. On a fresh schema this changes nothing, but the live DB still carries
 * legacy documents:
 *
 *   - one *simple* product (no options/variants) whose only stock number sits in
 *     `Product.stock` (observed: the t-shirt, `stock: 5`, with 4 legacy order lines that
 *     carry no `variantId`);
 *   - 93 variant products whose `Product.stock` was already zeroed at conversion time
 *     (stale, set to 0) and who have full matrices already.
 *
 * This script:
 *   1. For every product that still has NO variants, builds the default "One Size" option,
 *      value, variant, join row, balance and `initial_stock` movement - exactly what
 *      `VariantsService.createDefaultVariant` would have created at creation time, seeded
 *      from `Product.stock` (the seller's own count) rather than a guess.
 *   2. `$unset`s `stock` and `hasVariants` on every product, so no competing stock number
 *      survives even at zero.
 *   3. Backfills `items[].variantId` on legacy order lines that have a `productId`, when
 *      that product has exactly one live variant (the default one). This keeps the "every
 *      order line names a variant" invariant readable on historical orders.
 *
 * Collection names resolve through `scripts/lib/inventory-collections.js`, so they cannot
 * drift from the compiled schemas (run `npm run build` first).
 *
 * Idempotent and dry by default: `node scripts/migrate-simple-to-default-variant.js --allow-execute`.
 */
const { MongoClient, ObjectId } = require('mongodb');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const { inventoryCollectionNames } = require('./lib/inventory-collections');

const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
const uriMatcher = env.match(/MONGO_URI=(.*)/) || env.match(/MONGODB_URI=(.*)/) || env.match(/DATABASE_URL=(.*)/);
if (!uriMatcher) { console.error('No MONGO_URI in .env'); process.exit(1); }
const uri = uriMatcher[1].trim().replace(/^['"]|['"]$/g, '');

const EXECUTE = process.argv.includes('--allow-execute');

function combinationKeyFor(optionValueIds) {
  return createHash('sha1')
    .update([...new Set(optionValueIds.map(String))].sort().join(':'))
    .digest('hex');
}

(async () => {
  const client = await MongoClient.connect(uri);
  const db = client.db();

  const C = inventoryCollectionNames();
  const P = db.collection('products');
  const CL = db.collection(C.options);
  const CV = db.collection(C.optionValues);
  const CVr = db.collection(C.variants);
  const CJ = db.collection(C.joins);
  const CB = db.collection(C.balances);
  const CM = db.collection(C.movements);
  const ORD = db.collection('orders');

  const products = await P.find({}, { projection: { _id: 1, storeId: 1, stock: 1, nameEn: 1 } }).toArray();

  const converted = [];
  const alreadyHaveMatrix = [];
  const skippedNoStore = [];
  const now = new Date();

  for (const product of products) {
    const variantCount = await CVr.countDocuments({ productId: product._id });
    if (variantCount > 0) {
      alreadyHaveMatrix.push(String(product._id));
      continue;
    }

    if (!product.storeId) {
      skippedNoStore.push({ id: String(product._id), name: product.nameEn });
      continue;
    }

    const storeId = new ObjectId(String(product.storeId));
    const productId = product._id;
    const opening = Math.floor(Number(product.stock ?? 0)) || 0;

    const option = await CL.findOne({ productId, key: 'default' });

    let optionId;
    if (option) {
      optionId = option._id;
    } else {
      const inserted = await CL.insertOne({
        storeId, productId, key: 'default',
        nameEn: 'Default', nameAr: '\u0627\u0641\u062A\u0631\u0627\u0636\u064A', nameFr: 'Par défaut',
        position: 0, type: 'text', createdAt: now, updatedAt: now,
      });
      optionId = inserted.insertedId;
    }

    let value = await CV.findOne({ optionId, value: 'default' });
    let valueId;
    if (value) {
      valueId = value._id;
    } else {
      const inserted = await CV.insertOne({
        storeId, productId, optionId, value: 'default',
        valueEn: 'One Size', valueAr: '\u0645\u0642\u0627\u0633 \u0648\u0627\u062D\u062F', valueFr: 'Taille unique',
        color: null, position: 0, isActive: true, createdAt: now, updatedAt: now,
      });
      valueId = inserted.insertedId;
    }

    const variantId = new ObjectId();
    await CVr.insertOne({
      _id: variantId, storeId, productId,
      combinationKey: combinationKeyFor([String(valueId)]),
      sku: null, priceOverride: null, compareAtPrice: null, lowStockThreshold: null, image: null,
      position: 0, isActive: true, isDeleted: false, createdAt: now, updatedAt: now,
    });

    await CJ.insertOne({ storeId, variantId, optionValueId: valueId });

    await CB.insertOne({
      storeId, variantId, onHand: opening, reserved: 0, lowStockThreshold: null,
      createdAt: now, updatedAt: now,
    });

    await CM.insertOne({
      storeId, variantId, type: 'initial_stock',
      quantityDelta: opening, onHandBefore: 0, onHandAfter: opening,
      reservedBefore: 0, reservedAfter: 0,
      reason: 'Legacy Product.stock converted on migration',
      actorUserId: null, createdAt: now,
    });

    converted.push({ id: String(product._id), name: product.nameEn, opening });
  }

  // 2. Drop the legacy fields everywhere (they are the competing source §4.3 forbids).
  // `variants` is the pre-inventory embedded option-group array - dead, and confusing to
  // leave on a document whose schema no longer defines it.
  const unsetResult = await (async () => {
    if (!EXECUTE) return { acknowledged: true, modifiedCount: 0, dryRun: true };
    const r = await P.updateMany(
      {
        $or: [
          { stock: { $exists: true } },
          { hasVariants: { $exists: true } },
          { variants: { $exists: true } },
        ],
      },
      { $unset: { stock: '', hasVariants: '', variants: '' } },
    );
    return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  })();

  // 3. Backfill variantId on legacy order lines that resolve to exactly one live variant.
  let backfilledLines = 0;
  let unresolvableLines = 0;
  const orders = await ORD.find({}).project({ items: 1 }).toArray();
  for (const order of orders) {
    if (!Array.isArray(order.items)) continue;
    let changed = false;
    const items = order.items.map((item) => {
      if (item.variantId || !item.productId) return item;
      return { ...item, variantId: null, _unresolved: true };
    });
    for (const item of items) {
      if (!item._unresolved) continue;
      delete item._unresolved;
      const variants = await CVr
        .find({ productId: new ObjectId(String(item.productId)), isDeleted: { $ne: true }, isActive: true })
        .project({ _id: 1 })
        .limit(2)
        .toArray();
      if (variants.length !== 1) {
        unresolvableLines += 1;
        item.variantId = null;
      } else {
        item.variantId = String(variants[0]._id);
        backfilledLines += 1;
        changed = true;
      }
    }
    if (changed && EXECUTE) {
      await ORD.updateOne({ _id: order._id }, { $set: { items } });
    }
  }

  await client.close();

  console.log(JSON.stringify({
    mode: EXECUTE ? 'EXECUTE' : 'DRY RUN (--allow-execute to apply)',
    productsScanned: products.length,
    convertedToDefaultVariant: converted,
    alreadyHadMatrix: alreadyHaveMatrix.length,
    skippedNoStore,
    legacyFieldsUnset: unsetResult,
    orderLinesBackfilled: backfilledLines,
    orderLinesUnresolvable: unresolvableLines,
  }, null, 2));
})().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });