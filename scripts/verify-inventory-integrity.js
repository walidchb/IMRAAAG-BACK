/**
 * Verification: check Phase 2 inventory invariants across the live database.
 *
 * Read-only. It never writes, so it is safe to run at any time - including on
 * production, and including before the migration has been run (where it will report the
 * new collections as empty rather than as broken).
 *
 * Run:
 *   node scripts/verify-inventory-integrity.js [--allow-empty]
 *
 * --allow-empty  Permit the inventory collections to hold no variants. The run then reports
 *                SKIPPED for coverage rather than CLEAN, because "no violations" and "nothing
 *                to check" are different claims. Any real violation still fails.
 *
 * Exit code 0 = clean, 1 = at least one violation found.
 *
 * What it checks, and why each one matters:
 *  1. Every variant belongs to a product in the same store (cross-store join = a
 *     permission and accounting bug, not a data-entry slip).
 *  2. Every join row points at a value that belongs to the variant's product. MongoDB
 *     cannot enforce this; it is checked on write and re-checked here.
 *  3. Every variant has at most one balance row.
 *  4. `reserved <= onHand` on every balance. This is the invariant MongoDB cannot
 *     express as a validator, because a validator cannot compare two fields.
 *  5. No product carries the removed legacy stock fields (`stock`, `hasVariants`). A doc that
 *     has one means something wrote to the wrong source of truth after they were deleted.
 *  6. Every store-attributed product has at least one variant. Every product is a variant
 *     product now (universal variants), and a product with zero variants cannot be ordered.
 *     Storeless orphans (products with no `storeId`) are excluded: they were never migratable.
 *  7. No active balance references a soft-deleted variant.
 *  8. Every movement's before/after is arithmetically consistent with its delta.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');
const { inventoryCollectionNames } = require('./lib/inventory-collections');

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI environment variable is required');
  process.exit(1);
}

const COLLECTIONS = inventoryCollectionNames();

const allowEmpty = process.argv.includes('--allow-empty');

const violations = [];

function report(rule, detail) {
  violations.push({ rule, detail });
  console.log(`  FAIL  [${rule}] ${detail}`);
}

function ok(rule, message) {
  console.log(`  ok    [${rule}] ${message}`);
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const c = (name) => db.collection(name);

  console.log('[INVENTORY INTEGRITY] Connected. Read-only verification.\n');

  // Coverage guard. Every rule below is an "all documents satisfy X" check, so an empty
  // collection satisfies all of them trivially and the script would report CLEAN. That is
  // exactly how this script previously passed while inspecting the wrong collections: it read
  // `product_variants` (empty) rather than `productvariants` (populated) and had nothing to
  // complain about.
  //
  // Empty is legitimately possible - inventory is unlaunched, so a fresh environment has no
  // variants yet - and "no data" must not be reported as "no violations". So empty is refused
  // by default (exit 1) and must be asserted explicitly with --allow-empty, which reports
  // SKIPPED rather than CLEAN and still exits non-zero on any real violation.
  const variantCount = await db.collection(COLLECTIONS.variants).countDocuments();
  if (variantCount === 0) {
    if (allowEmpty) {
      console.log(
        `  SKIP  [coverage] "${COLLECTIONS.variants}" holds 0 documents (--allow-empty).\n` +
          '        No inventory data exists, so the invariant checks below have nothing to\n' +
          '        examine and this run certifies nothing.',
      );
    } else {
      console.error(
        `[INVENTORY INTEGRITY] FAILED: "${COLLECTIONS.variants}" holds 0 documents.\n` +
          '  Every invariant check here is vacuously true over an empty collection, so reporting\n' +
          '  CLEAN would be meaningless. Either inventory has no data yet (pass --allow-empty to\n' +
          '  record that this run certifies nothing) or this script is pointed at the wrong\n' +
          '  collection names.',
      );
      await mongoose.disconnect();
      process.exit(1);
    }
  } else {
    console.log(`  ok    [coverage] ${variantCount} variants present in ${COLLECTIONS.variants}`);
  }
  console.log('');

  // ---- 1. variant -> product store agreement ------------------------------------
  const variants = await c(COLLECTIONS.variants)
    .aggregate([
      {
        $lookup: {
          from: 'products',
          localField: 'productId',
          foreignField: '_id',
          as: 'p',
        },
      },
      { $unwind: '$p' },
      {
        $project: {
          _id: 1,
          storeId: 1,
          productId: 1,
          productStoreId: '$p.storeId',
        },
      },
    ])
    .toArray();

  const orphanedVariants = await c(COLLECTIONS.variants)
    .aggregate([
      { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'p' } },
      // `products.remove()` soft-deletes the variants and THEN hard-deletes the product, so a
      // deleted variant with no product is the designed tombstone (it keeps historical order
      // lines resolvable). Only an ACTIVE variant whose product is missing means a delete
      // skipped the cascade - that is the real bug this rule exists to catch.
      { $match: { p: { $size: 0 }, isDeleted: { $ne: true } } },
      { $project: { _id: 1, productId: 1 } },
    ])
    .toArray();

  if (orphanedVariants.length > 0) {
    report(
      'variant-has-product',
      `${orphanedVariants.length} variant(s) reference a product that does not exist: ` +
        orphanedVariants.slice(0, 5).map((v) => String(v._id)).join(', '),
    );
  } else {
    ok('variant-has-product', `${variants.length} variant(s) all resolve to a product`);
  }

  const crossStore = variants.filter(
    (v) => v.productStoreId && String(v.productStoreId) !== String(v.storeId),
  );
  if (crossStore.length > 0) {
    report(
      'variant-store-matches-product',
      `${crossStore.length} variant(s) have a storeId different from their product's`,
    );
  } else {
    ok('variant-store-matches-product', 'no cross-store variant/product pairs');
  }

  // ---- 2. join rows point at values of the same product -------------------------
  const joins = await c(COLLECTIONS.joins)
    .aggregate([
      { $lookup: { from: COLLECTIONS.variants, localField: 'variantId', foreignField: '_id', as: 'v' } },
      { $unwind: '$v' },
      {
        $lookup: {
          from: COLLECTIONS.optionValues,
          localField: 'optionValueId',
          foreignField: '_id',
          as: 'ov',
        },
      },
      { $unwind: '$ov' },
      {
        $project: {
          _id: 1,
          variantProductId: '$v.productId',
          valueProductId: '$ov.productId',
        },
      },
      { $match: { $expr: { $ne: ['$variantProductId', '$valueProductId'] } } },
    ])
    .toArray();

  if (joins.length > 0) {
    report(
      'join-same-product',
      `${joins.length} join row(s) reference an option value from a different product`,
    );
  } else {
    ok('join-same-product', 'every option value joined to a variant shares its product');
  }

  // ---- 3. one balance per variant ------------------------------------------------
  const duplicateBalances = await c(COLLECTIONS.balances)
    .aggregate([
      { $group: { _id: '$variantId', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();
  if (duplicateBalances.length > 0) {
    report(
      'one-balance-per-variant',
      `${duplicateBalances.length} variant(s) have more than one balance row`,
    );
  } else {
    ok('one-balance-per-variant', 'at most one balance row per variant');
  }

  // ---- 4. reserved <= onHand ------------------------------------------------------
  const overReserved = await c(COLLECTIONS.balances)
    .find({ $expr: { $gt: ['$reserved', '$onHand'] } })
    .project({ variantId: 1, onHand: 1, reserved: 1 })
    .toArray();
  if (overReserved.length > 0) {
    report(
      'reserved-lte-onhand',
      `${overReserved.length} balance(s) reserve more than they hold: ` +
        overReserved
          .slice(0, 5)
          .map((b) => `${String(b.variantId)} (onHand=${b.onHand}, reserved=${b.reserved})`)
          .join('; '),
    );
  } else {
    ok('reserved-lte-onhand', 'no balance reserves more than it holds');
  }

  const negative = await c(COLLECTIONS.balances)
    .find({ $or: [{ onHand: { $lt: 0 } }, { reserved: { $lt: 0 } }] })
    .toArray();
  if (negative.length > 0) {
    report('balance-non-negative', `${negative.length} balance(s) contain a negative number`);
  } else {
    ok('balance-non-negative', 'no negative onHand or reserved values');
  }

  // ---- 5/6. universal variants: removed fields never return, every product has a variant ----
  const allProducts = await c('products')
    .find({}, { projection: { _id: 1, nameEn: 1, storeId: 1, stock: 1, hasVariants: 1 } })
    .toArray();

  const strayStock = allProducts.filter(
    (p) => p.stock !== undefined || p.hasVariants !== undefined,
  );
  if (strayStock.length > 0) {
    report(
      'no-product-stock-fields',
      `${strayStock.length} product(s) still carry the removed stock field(s): ` +
        strayStock
          .slice(0, 5)
          .map((p) => {
            const bits = [];
            if (p.stock !== undefined) bits.push(`stock=${p.stock}`);
            if (p.hasVariants !== undefined) bits.push(`hasVariants=${p.hasVariants}`);
            return `${p.nameEn || String(p._id)} (${bits.join(', ')})`;
          })
          .join('; '),
    );
  } else {
    ok('no-product-stock-fields', 'no product carries a removed `stock`/`hasVariants` field');
  }

  const variantCounts = await c(COLLECTIONS.variants)
    .aggregate([
      { $group: { _id: '$productId', count: { $sum: 1 } } },
    ])
    .toArray();
  const countByProduct = new Map(variantCounts.map((v) => [String(v._id), v.count]));
  // Storeless orphans (e.g. a legacy product whose store was never created) have no inventory
  // owner and were deliberately skipped by the migration; excluding them keeps this from
  // failing forever on data that can never be sold anyway.
  const attributed = allProducts.filter((p) => p.storeId !== undefined && p.storeId !== null);
  const empty = attributed.filter((p) => !countByProduct.get(String(p._id)));
  if (empty.length > 0) {
    report(
      'every-product-has-variants',
      `${empty.length} store-attributed product(s) have no variants yet`,
    );
  } else {
    ok(
      'every-product-has-variants',
      `all ${attributed.length} store-attributed product(s) have at least one variant`,
    );
  }

  // ---- 7. balances for deleted variants -----------------------------------------
  // A zero balance on a tombstone is inert: it keeps the ledger replayable and can never be
  // sold, reserved or adjusted. What must never exist is stock still held against a variant
  // that is gone - units nobody can move, sell or reconcile away.
  const activeForDeleted = await c(COLLECTIONS.balances)
    .aggregate([
      {
        $lookup: {
          from: COLLECTIONS.variants,
          localField: 'variantId',
          foreignField: '_id',
          as: 'v',
        },
      },
      { $unwind: '$v' },
      { $match: { 'v.isDeleted': true, $or: [{ onHand: { $gt: 0 } }, { reserved: { $gt: 0 } }] } },
      { $project: { variantId: 1, onHand: 1, reserved: 1 } },
    ])
    .toArray();
  if (activeForDeleted.length > 0) {
    report(
      'no-balance-on-deleted-variant',
      `${activeForDeleted.length} balance(s) still hold stock on a soft-deleted variant: ` +
        activeForDeleted
          .slice(0, 5)
          .map((b) => `${b.variantId} (onHand=${b.onHand}, reserved=${b.reserved})`)
          .join(', '),
    );
  } else {
    ok('no-balance-on-deleted-variant', 'no stock held against soft-deleted variants');
  }

  // ---- 8. movement arithmetic ----------------------------------------------------
  const badMovements = await c(COLLECTIONS.movements)
    .find({
      $expr: { $ne: [{ $add: ['$onHandBefore', '$quantityDelta'] }, '$onHandAfter'] },
    })
    .toArray();
  if (badMovements.length > 0) {
    report(
      'movement-delta-consistent',
      `${badMovements.length} movement(s) where onHandBefore + delta !== onHandAfter`,
    );
  } else {
    ok('movement-delta-consistent', 'every movement reconciles with its recorded delta');
  }

  console.log('');
  if (violations.length === 0) {
    // "No violations" and "nothing to check" are different results and must not read alike.
    console.log(
      variantCount === 0
        ? '[INVENTORY INTEGRITY] NO DATA - no violations, but no variants existed to check. ' +
            'This run certifies nothing.'
        : `[INVENTORY INTEGRITY] CLEAN - ${variantCount} variant(s) checked, no violations.`,
    );
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log(`[INVENTORY INTEGRITY] ${violations.length} VIOLATION(S) FOUND:`);
  for (const v of violations) console.log(`  - [${v.rule}] ${v.detail}`);
  await mongoose.disconnect();
  process.exit(1);
}

main().catch((err) => {
  console.error('[INVENTORY INTEGRITY] FAILED:', err);
  process.exit(1);
});