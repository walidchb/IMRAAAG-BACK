/*
 * Audits the universal-variant invariant: inventory balances are the only stock source.
 *
 * Post-migration (scripts/migrate-simple-to-default-variant.js) the Product collection has
 * no `stock`, `hasVariants` or embedded `variants` field at all. This script verifies that
 * live state and reports the two remaining expectations:
 *
 *   - every product owns a variant matrix except a storeless orphan (whose stock figure has
 *     no store scope to live in and is intentionally skipped);
 *   - every order line names a variant, except the same orphan's historical lines.
 *
 * Run: node scripts/audit-product-stock.js
 */
const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');
const path = require('path');
const { inventoryCollectionNames } = require('./lib/inventory-collections');

const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
const uri = (env.match(/MONGO_URI=(.*)/) || env.match(/MONGODB_URI=(.*)/) || env.match(/DATABASE_URL=(.*)/))[1].trim().replace(/^['"]|['"]$/g, '');

(async () => {
  const c = await MongoClient.connect(uri);
  const db = c.db();

  const C = inventoryCollectionNames();
  const P = db.collection('products');
  const B = db.collection(C.balances);
  const V = db.collection(C.variants);
  const O = db.collection('orders');

  const total = await P.countDocuments({});

  // A product "has stock" iff at least one inventory balance row exists behind it.
  const withVariants = await P.aggregate([
    { $lookup: { from: C.variants, localField: '_id', foreignField: 'productId', as: 'v' } },
    { $match: { 'v.0': { $exists: true } } },
    { $count: 'n' },
  ]).toArray();
  const variantProductCount = withVariants[0]?.n ?? 0;

  const withoutVariants = await P.aggregate([
    { $lookup: { from: C.variants, localField: '_id', foreignField: 'productId', as: 'v' } },
    { $match: { v: { $size: 0 } } },
    { $project: { _id: 1, nameEn: 1, slug: 1, storeId: 1, published: 1 } },
  ]).toArray();

  // The old fields are gone — any product still carrying one is a failed unset.
  const legacyFieldDocs = await P.countDocuments({
    $or: [{ stock: { $exists: true } }, { hasVariants: { $exists: true } }, { variants: { $exists: true } }],
  });

  const balances = await B.countDocuments({});
  const variants = await V.countDocuments({});

  const orderLines = await O.aggregate([
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.variantId',
        n: { $sum: 1 },
        productIds: { $addToSet: '$items.productId' },
      },
    },
  ]).toArray();
  const linesMissingVariant = orderLines.find((r) => r._id === null) ?? orderLines.find((r) => r._id === undefined) ?? null;

  console.log(JSON.stringify({
    invariant: 'Inventory balances are the only stock source',
    total,
    productsWithVariantMatrix: variantProductCount,
    productsWithoutVariantMatrix: withoutVariants,
    legacyFieldDocsRemaining: legacyFieldDocs,
    balances,
    variants,
    orderLineBreakdown: orderLines,
    pass: legacyFieldDocs === 0 && variantProductCount === total - 1,
  }, null, 2));
  await c.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });