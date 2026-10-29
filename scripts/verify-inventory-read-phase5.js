/**
 * End-to-end verification of the Phase 5 inventory read endpoints against the live database.
 *
 * Covers the three endpoints Phase 5's UI depends on, which did not exist before:
 *   10.2  GET  /inventory           store-wide variant list: search, filters, sort, paging, summary
 *   10.4  GET  /inventory/movements store-wide ledger: filters, enrichment, cursor paging
 *   6.3   PATCH /inventory/threshold variant override, product default, clearing
 *
 * Every assertion runs against the real services through the Nest DI container (real indexes,
 * real unique constraints, real aggregation). Collection names are resolved from the compiled
 * schemas via scripts/lib/inventory-collections.js, never hardcoded.
 *
 * The list and ledger are the two places where a bug is invisible rather than loud: a wrong
 * `$lookup` target or a `$match` that compares a field to a literal string both succeed and
 * return quietly wrong data. So the assertions here check values, not just "it returned 200".
 *
 * Run: `npm run build && node scripts/verify-inventory-read-phase5.js`
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');
const { NestFactory } = require('@nestjs/core');
const { getConnectionToken } = require('@nestjs/mongoose');
const { Types } = mongoose;
const { VariantsService } = require('../dist/modules/inventory/services/variants.service');
const { InventoryService } = require('../dist/modules/inventory/services/inventory.service');
const { InventoryReadService } = require('../dist/modules/inventory/services/inventory-read.service');
const { MovementsService } = require('../dist/modules/inventory/services/movements.service');
const { inventoryCollectionNames } = require('./lib/inventory-collections');

const COL = inventoryCollectionNames();

let app;
let db;
let variantsService;
let inventoryService;
let inventoryReadService;
let movementsService;

const tmpProducts = [];

let passed = 0;
function assert(cond, label) {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}`);
  if (cond) passed += 1;
  else process.exitCode = 1;
}

function eq(actual, expected, label) {
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)})`);
}

async function errOf(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

/** The AppErrorCode an `errOf` call threw, or null if it did not throw at all. */
function codeOf(err) {
  return err && err.errorCode ? err.errorCode : null;
}

/**
 * A 2x2 variant product, all four combinations created.
 *
 * Quantities are NOT seeded here. Combinations are created via `createVariants` (every variant
 * opens at a zero balance) and the levels themselves are then set by label through
 * `setOnHand`, keeping the fixture independent of `combinationKey` internals. The levels are
 * chosen so every status bucket is non-empty - 0 is out of stock, 3 sits at the threshold,
 * 20 is comfortably in stock. A fixture where everything is in stock would make the low and
 * out-of-stock filters pass without ever matching anything.
 */
async function makeVariantProduct(label) {
  const store = await db.collection('stores').findOne({});
  const res = await db.collection('products').insertOne({
    storeId: store._id,
    vendorEmail: store.vendorEmail,
    nameEn: `ZZ Read ${label}`,
    nameAr: `ZZ Read ${label}`,
    nameFr: `ZZ Read ${label}`,
    slug: `zz-read-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    originalPrice: 100,
    price: 100,
    weight: 1,
    lowStockThreshold: 5,
    published: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const productId = res.insertedId;
  tmpProducts.push(productId);
  const storeId = new Types.ObjectId(store._id);

  const size = await variantsService.createOption(String(productId), storeId, {
    key: 'Size',
    nameEn: 'Size',
  });
  const colour = await variantsService.createOption(String(productId), storeId, {
    key: 'Colour',
    nameEn: 'Colour',
  });
  const small = await variantsService.createValue(String(productId), storeId, size._id, {
    value: 's',
    valueEn: 'Small',
  });
  const large = await variantsService.createValue(String(productId), storeId, size._id, {
    value: 'l',
    valueEn: 'Large',
  });
  const red = await variantsService.createValue(String(productId), storeId, colour._id, {
    value: 'red',
    valueEn: 'Red',
  });
  const blue = await variantsService.createValue(String(productId), storeId, colour._id, {
    value: 'blue',
    valueEn: 'Blue',
  });

  const preview = await variantsService.previewCombinations(String(productId), storeId, {});
  const selections = preview.possibleCombinations.map((c) => ({
    combinationKey: c.combinationKey,
    optionValueIds: c.optionValueIds,
  }));
  // `toggleVariants` no longer exists: every product is a variant product and combinations are
  // created at a zero balance, then stocked below through the real write path.
  await variantsService.createVariants(String(productId), storeId, { selections });

  const matrix = await variantsService.getMatrix(String(productId), storeId);
  const byLabel = {};
  for (const v of matrix.variants) {
    const sizeName = v.optionValueIds.some((id) => id === String(small._id)) ? 'Small' : 'Large';
    const colourName = v.optionValueIds.some((id) => id === String(red._id)) ? 'Red' : 'Blue';
    byLabel[`${sizeName}-${colourName}`] = v;
  }

  return { productId, storeId, store, variants: byLabel, labels: { small, red, blue } };
}

async function cleanup() {
  if (!db) return;
  // `KEEP_FIXTURES=1` leaves the throwaway rows in place so a failure can be inspected
  // directly in the database instead of being cleaned up before it can be read.
  if (process.env.KEEP_FIXTURES === '1') {
    console.log('\n[SMOKE] KEEP_FIXTURES=1 - fixtures left in place');
    return;
  }
  const ids = tmpProducts.map((id) => new Types.ObjectId(id));
  if (ids.length === 0) return;
  const variantIds = (
    await db.collection(COL.variants).find({ productId: { $in: ids } }).project({ _id: 1 }).toArray()
  ).map((v) => v._id);
  await db.collection(COL.balances).deleteMany({ variantId: { $in: variantIds } });
  await db.collection(COL.movements).deleteMany({ variantId: { $in: variantIds } });
  await db.collection(COL.joins).deleteMany({ variantId: { $in: variantIds } });
  await db.collection(COL.variants).deleteMany({ _id: { $in: variantIds } });
  await db.collection(COL.reservations).deleteMany({ variantId: { $in: variantIds } });
  const optionIds = (
    await db.collection(COL.options).find({ productId: { $in: ids } }).project({ _id: 1 }).toArray()
  ).map((o) => o._id);
  await db.collection(COL.optionValues).deleteMany({ optionId: { $in: optionIds } });
  await db.collection(COL.options).deleteMany({ _id: { $in: optionIds } });
  await db.collection('products').deleteMany({ _id: { $in: ids } });
  console.log('\n[SMOKE] fixtures removed');
}

async function main() {
  const { AppModule } = require('../dist/app.module');
  app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  db = app.get(getConnectionToken()).db;
  variantsService = app.get(VariantsService);
  inventoryService = app.get(InventoryService);
  inventoryReadService = app.get(InventoryReadService);
  movementsService = app.get(MovementsService);

  console.log('\n[SMOKE] context up');

  // 4 combos: Small/Red=20 (healthy), Small/Blue=3 (at threshold -> low),
  // Large/Red=0 (out), Large/Blue=20 (healthy).
  const ctx = await makeVariantProduct('p5', {
    's-red': 20,
    's-blue': 3,
    'l-red': 0,
    'l-blue': 20,
  });
  const v = ctx.variants;
  console.log(`  product=${ctx.productId} store=${ctx.storeId}`);

  // The list filters on `variant.storeId`, so confirm the service really stamped it in the
  // same BSON shape the filter uses. A raw-driver insert can leave a *string* where the
  // pipeline expects an ObjectId, which matches nothing and looks exactly like "no stock".
  // Stock levels: healthy, at-threshold, empty, healthy. Set through the real write path so the
// ledger rows these tests later read are genuine movements rather than direct inserts.
const LEVELS = { 'Small-Red': 20, 'Small-Blue': 3, 'Large-Red': 0, 'Large-Blue': 20 };
for (const [label, qty] of Object.entries(LEVELS)) {
  await inventoryService.setOnHand({
    storeId: ctx.storeId,
    variantId: new Types.ObjectId(v[label].variantId),
    quantity: qty,
    reason: 'zz_read_seed',
    actorUserId: null,
  });
}
console.log(`  seeded ${Object.entries(LEVELS).map(([l, q]) => `${l}=${q}`).join(', ')}`);

  // One SKU, so `search` has a SKU to find. Without it the SKU branch of the search would
  // match nothing and the assertion would pass for the wrong reason.
  await variantsService.updateVariant(String(ctx.productId), ctx.storeId, v['Large-Blue'].variantId, {
    sku: 'ZZSKU-A',
  });
  console.log('  seeded sku ZZSKU-A on Large-Blue');

  // -------------------------------------------------------------------------------
  console.log('\n10.2 GET /inventory - list, summary and precedence');
  {
    const list = await inventoryReadService.listStoreInventory(ctx.storeId, {
      productId: String(ctx.productId),
    });

    eq(list.data.length, 4, 'all four variants are listed');
    eq(list.page, 1, 'defaults to page 1');
    // Default page size was 25; shipped as 20 end-to-end on 2026-10-07 (vendorFront
    // INVENTORY_DEFAULTS.limit + backend `query.limit ?? 20`), so the first page spans 20.
    eq(list.limit, 20, 'defaults to a limit of 20');
    eq(list.total, 4, 'total counts the whole filtered set, not the page');
    eq(list.totalPages, 1, 'totalPages is derived from total and limit');
    // The list endpoint deliberately carries no summary - a summary computed over a search
    // result would drift from the store-wide stats. Row-level precedence is asserted below.
    eq(list.summary, undefined, 'no per-list summary: stats live on getStoreStats instead');

    // The list and the matrix describe the same variant, so they must name it identically.
    // Comparing against the matrix's own label rather than a literal catches a divergence in
    // either direction, which a hardcoded string would not.
    const matrixLabelFor = (key) => ctx.variants[key].label;
    for (const key of ['Small-Red', 'Small-Blue', 'Large-Red', 'Large-Blue']) {
      const variant = ctx.variants[key];
      const row = list.data.find((r) => r.variantId === variant.variantId);
      assert(
        !!row && row.label === variant.label,
        `list label matches the matrix for ${key} ("${row?.label}" vs "${variant.label}")`,
      );
    }
    assert(
      list.data.some((r) => r.label.includes('Size:')),
      `labels name the option, not just the raw value (${list.data[0]?.label})`,
    );

    const zero = list.data.find((r) => r.variantId === v['Large-Red'].variantId);
    eq(zero.onHand, 0, 'a zero-stock row reports onHand 0, not a missing value');
    eq(zero.available, 0, 'available is derived as onHand - reserved');
    eq(zero.lowStockThreshold, 5, 'the product default is used when nothing overrides it');
    eq(zero.isLowStock, false, 'available 0 is out of stock, not low');
    assert(zero.productName.en.startsWith('ZZ Read'), 'the product name is joined in');
    eq(zero.productId, String(ctx.productId), 'productId is returned');
    assert(!!zero.updatedAt, 'updatedAt is returned for sorting');
  }

  // -------------------------------------------------------------------------------
  console.log('\n10.2 status filters');
  {
    const storeId = ctx.storeId;
    const pid = String(ctx.productId);
    const out = await inventoryReadService.listStoreInventory(storeId, { productId: pid, status: 'out' });
    eq(out.data.length, 1, 'status=out returns only the zero-stock variant');
    eq(out.data[0].variantId, v['Large-Red'].variantId, 'and it is the right one');

    const low = await inventoryReadService.listStoreInventory(storeId, { productId: pid, status: 'low' });
    eq(low.data.length, 1, 'status=low returns the at-threshold row only (zero is out, not low)');
    assert(
      low.data.every((r) => r.available > 0 && r.available <= r.lowStockThreshold),
      'every low row is stocked but at or under its threshold',
    );

    const inStock = await inventoryReadService.listStoreInventory(storeId, {
      productId: pid,
      status: 'in_stock',
    });
    // Availability only - availability 3 is below the threshold of 5 but is still sellable, so
    // it counts as in stock. Being "low" is not "out".
    eq(inStock.data.length, 3, 'status=in_stock means available > 0, regardless of threshold');
    assert(
      inStock.data.every((r) => r.available > 0),
      'every in_stock row really has availability',
    );

    const all = await inventoryReadService.listStoreInventory(storeId, { productId: pid, status: 'all' });
    eq(all.data.length, 4, 'status=all is not a filter');
  }

  // -------------------------------------------------------------------------------
  console.log('\n10.2 search, sorting and paging');
  {
    const storeId = ctx.storeId;
    const pid = String(ctx.productId);

    const byName = await inventoryReadService.listStoreInventory(storeId, { search: 'ZZ Read' });
    assert(byName.total >= 4, `search by product name matches (${byName.total})`);

    const bySku = await inventoryReadService.listStoreInventory(storeId, {
      productId: pid,
      search: 'ZZSKU-A',
    });
    eq(bySku.data.length, 1, 'search by SKU matches exactly one row');

    const p1 = await inventoryReadService.listStoreInventory(storeId, { productId: pid, limit: 3, page: 1 });
    const p2 = await inventoryReadService.listStoreInventory(storeId, { productId: pid, limit: 3, page: 2 });
    eq(p1.data.length, 3, 'page 1 holds the requested number of rows');
    eq(p2.data.length, 1, 'page 2 holds the remainder');
    eq(p1.total, 4, 'the total is stable across pages');
    eq(p1.totalPages, 2, 'totalPages is derived from the total, not the page size');
    assert(
      !p1.data.some((a) => p2.data.some((b) => b.variantId === a.variantId)),
      'the two pages do not overlap',
    );
    // Pagination never fabricates a summary - the summary lives on getStoreStats.
    eq(p1.summary, undefined, 'no per-list summary across pages either');

    const p9 = await inventoryReadService.listStoreInventory(storeId, { productId: pid, page: 9, limit: 3 });
    eq(p9.data.length, 0, 'a page past the end is empty rather than an error');
  }

  // -------------------------------------------------------------------------------
  console.log('\n6.3 PATCH /inventory/threshold - override, default and clearing');
  {
    const storeId = ctx.storeId;
    const target = v['Small-Red'];

    const set = await inventoryService.setThreshold({
      storeId,
      variantId: target.variantId,
      threshold: 25,
    });
    eq(set.scope, 'variant', 'a variant target is reported as a variant override');
    eq(set.threshold, 25, 'the override is echoed back');

    // This is the precedence rule: 25 at the balance level must beat the product default of 5.
    const overridden = await inventoryReadService.listStoreInventory(storeId, {
      productId: String(ctx.productId),
    });
    const row = overridden.data.find((r) => r.variantId === target.variantId);
    eq(row.lowStockThreshold, 25, 'the balance override wins over the product default');
    eq(row.isLowStock, true, 'available 20 is now low against a threshold of 25');
    eq(row.available, 20, 'changing a threshold never changes stock');

    const sibling = overridden.data.find((r) => r.variantId === v['Large-Blue'].variantId);
    eq(sibling.lowStockThreshold, 5, 'a sibling variant still inherits the product default');

    // Clearing must restore inheritance, which is the whole point of `clear`.
    const cleared = await inventoryService.setThreshold({
      storeId,
      variantId: target.variantId,
      threshold: null,
    });
    eq(cleared.threshold, null, 'the override clears to null');
    const restored = await inventoryReadService.listStoreInventory(storeId, {
      productId: String(ctx.productId),
    });
    eq(
      restored.data.find((r) => r.variantId === target.variantId).lowStockThreshold,
      5,
      'after clearing, the product default applies again',
    );

    const productDefault = await inventoryService.setThreshold({
      storeId,
      productId: String(ctx.productId),
      threshold: 2,
    });
    eq(productDefault.scope, 'product', 'a product target is reported as the default');
    const afterDefault = await inventoryReadService.listStoreInventory(storeId, {
      productId: String(ctx.productId),
    });
    assert(
      afterDefault.data.every((r) => r.lowStockThreshold === 2),
      'the new product default applies to every variant that has no override',
    );
    // Leave the fixture as it was so the earlier sections stay meaningful if re-run.
    await inventoryService.setThreshold({ storeId, productId: String(ctx.productId), threshold: 5 });

    const noStock = await errOf(() =>
      inventoryService.setThreshold({
        storeId,
        variantId: new Types.ObjectId().toHexString(),
        threshold: 3,
      }),
    );
    assert(
      noStock?.errorCode === 'TENANT_ACCESS_DENIED' || noStock?.errorCode === 'VARIANT_NOT_FOUND',
      `an unknown variant cannot have a threshold set (${noStock?.errorCode})`,
    );

    const foreign = await errOf(() =>
      inventoryService.setThreshold({
        storeId: new Types.ObjectId(),
        productId: String(ctx.productId),
        threshold: 3,
      }),
    );
    eq(foreign?.errorCode, 'PRODUCT_NOT_IN_STORE', 'another store cannot set this product threshold');
  }

  // -------------------------------------------------------------------------------
  console.log('\n10.4 GET /inventory/movements - ledger, filters and enrichment');
  {
    const storeId = ctx.storeId;
    const target = v['Large-Blue'];

    await inventoryService.adjustByDelta({
      storeId,
      variantId: target.variantId,
      delta: 7,
      reason: 'zz_read_manual',
      note: 'ZZ Read restock note',
      actorUserId: null,
    });

    const all = await movementsService.listForStore(storeId, {});
    assert(all.data.length >= 5, `the ledger returns this store's movements (${all.data.length})`);
    assert(
      all.data.every((m) => m.variantId),
      'every row names the variant it moved',
    );

    // Enrichment is the point of the store-wide view; an ObjectId column is not a history.
    const seeded = all.data.find((m) => m.reason === 'zz_read_manual');
    assert(!!seeded, 'the manual adjustment is in the ledger');
    assert(
      !!seeded.productName?.en && seeded.productName.en.startsWith('ZZ Read'),
      `the product name is joined in (${seeded?.productName?.en})`,
    );
    eq(seeded.variantLabel, ctx.variants['Large-Blue'].label, `the variant label is assembled (${seeded.variantLabel})`);
    eq(seeded.productId, String(ctx.productId), 'the movement resolves back to its product');
    assert(seeded.actorName === null, 'a system movement reports no actor rather than a bad name');

    const byProduct = await movementsService.listForStore(storeId, {
      variantIds: await inventoryReadService.variantIdsForProduct(String(ctx.productId), storeId),
    });
    assert(byProduct.data.length > 0, 'filtering by productId returns rows');
    assert(
      byProduct.data.every((m) => m.productId === String(ctx.productId)),
      'no row from another product leaks in',
    );

    const byType = await movementsService.listForStore(storeId, { type: 'manual_increase' });
    assert(
      byType.data.length >= 1 && byType.data.every((m) => m.type === 'manual_increase'),
      'filtering by type returns only that type',
    );

    const bySearch = await movementsService.listForStore(storeId, { search: 'ZZ Read restock' });
    eq(bySearch.data.length, 1, 'free-text search over reason/note finds the row');

    const none = await movementsService.listForStore(storeId, { search: 'zz-no-such-note' });
    eq(none.data.length, 0, 'a search with no match returns nothing');

    const noVariants = await movementsService.listForStore(storeId, { variantIds: [] });
    eq(
      noVariants.data.length,
      0,
      'an empty variantIds list means zero rows, not the whole ledger',
    );

    const future = new Date(Date.now() + 86400000);
    const bounded = await movementsService.listForStore(storeId, { to: future });
    assert(bounded.data.length > 0, 'an upper date bound that includes today still returns rows');

    // Precise boundary probe on the row we just wrote: `to` is exclusive ($lt), so a bound one
    // millisecond *before* that movement must exclude it while still returning older rows.
    const seededDoc = await db
      .collection(COL.movements)
      .findOne({ storeId: new Types.ObjectId(String(storeId)), reason: 'zz_read_manual' });
    const barelyBefore = new Date(new Date(seededDoc.createdAt).getTime() - 1);
    const sliced = await movementsService.listForStore(storeId, { to: barelyBefore });
    assert(
      sliced.data.every((m) => m.reason !== 'zz_read_manual'),
      'an upper bound before that movement excludes it ($lt is exclusive)',
    );
    assert(
      sliced.data.length > 0,
      'older ledger rows on the same store still return below the bound',
    );

    // Cursor paging must not repeat or skip when rows share a timestamp.
    const page1 = await movementsService.listForStore(storeId, { limit: 2 });
    const page2 = await movementsService.listForStore(storeId, { limit: 2, cursor: page1.nextCursor });
    assert(!!page1.nextCursor, 'a full page advertises a next cursor');
    assert(
      !page1.data.some((a) => page2.data.some((b) => b.id === a.id)),
      'consecutive cursor pages do not repeat rows',
    );
    assert(
      page1.data.every((a) => new Date(a.createdAt) >= page2.data[page2.data.length - 1].createdAt),
      'pages are ordered newest first',
    );
  }

  // -------------------------------------------------------------------------------
  console.log('\ntenant isolation');
  {
    const otherStoreId = new Types.ObjectId();
    const empty = await inventoryReadService.listStoreInventory(otherStoreId, {});
    eq(empty.data.length, 0, 'an unrelated store sees no variants');
    eq(empty.summary, undefined, 'no per-list summary for an empty store either');

    const otherLedger = await movementsService.listForStore(otherStoreId, {});
    eq(otherLedger.data.length, 0, 'an unrelated store sees no movements');
  }

  // -------------------------------------------------------------------------------
  console.log('\nsoft-deleted and inactive handling');
  {
    const doomed = v['Small-Blue'];
    await db.collection(COL.variants).updateOne(
      { _id: new Types.ObjectId(doomed.variantId) },
      { $set: { isDeleted: true } },
    );
    const afterDelete = await inventoryReadService.listStoreInventory(ctx.storeId, {
      productId: String(ctx.productId),
    });
    eq(afterDelete.data.length, 3, 'a soft-deleted variant leaves the list');
    eq(afterDelete.summary, undefined, 'no per-list summary after a soft-delete either');

    await variantsService.deactivateVariant(
      String(ctx.productId),
      ctx.storeId,
      v['Large-Red'].variantId,
      { choice: 'keep' },
    );
    const inactiveOnly = await inventoryReadService.listStoreInventory(ctx.storeId, {
      productId: String(ctx.productId),
      status: 'inactive',
    });
    eq(inactiveOnly.data.length, 1, 'status=inactive finds the deactivated variant');
    const activeOnly = await inventoryReadService.listStoreInventory(ctx.storeId, {
      productId: String(ctx.productId),
      status: 'active',
    });
    eq(activeOnly.data.length, 2, 'status=active excludes it');

    await variantsService.activateVariant(
      String(ctx.productId),
      ctx.storeId,
      v['Large-Red'].variantId,
    );

    await db.collection(COL.variants).updateOne(
      { _id: new Types.ObjectId(doomed.variantId) },
      { $set: { isDeleted: false } },
    );
  }

  // -------------------------------------------------------------------------------
  // Regressions for three defects found while binding the frontend to these endpoints.
  console.log('\nregressions: single-variant filter, threshold chain, controller guards');
  {
    // (1) `variantId` on the store ledger was validated and then dropped, so the route
    // returned the whole store's history while implying one variant's.
    const target = new Types.ObjectId(v['Small-Red'].variantId);
    const one = await movementsService.listForStore(ctx.storeId, {
      singleVariantId: target,
      limit: 200,
    });
    assert(
      one.data.length > 0,
      'filtering the ledger to one variant returns rows rather than nothing',
    );
    assert(
      one.data.every((m) => m.variantId === String(target)),
      `every returned row belongs to the requested variant (${one.data.length} checked)`,
    );
    const wide = await movementsService.listForStore(ctx.storeId, { limit: 200 });
    assert(
      one.data.length < wide.data.length,
      `the single-variant filter actually narrows (${one.data.length} < ${wide.data.length})`,
    );
    // Intersecting with productId must not widen back out to the store.
    const both = await movementsService.listForStore(ctx.storeId, {
      singleVariantId: target,
      variantIds: await inventoryReadService.variantIdsForProduct(ctx.productId, ctx.storeId),
      limit: 200,
    });
    assert(
      both.data.every((m) => m.variantId === String(target)),
      'variantId and productId intersect rather than override',
    );
    // A product with no variants is zero rows, not the whole ledger.
    const none = await movementsService.listForStore(ctx.storeId, { variantIds: [] });
    eq(none.data.length, 0, 'an empty variantIds list stays zero rows');

    // (2) Threshold precedence: the store list resolved balance -> variant -> product while
    // the single-variant readers skipped the variant level, so the same variant could be
    // flagged low in one place and not in the other.
    const productThreshold = 5;
    const chainVariantId = v['Small-Red'].variantId;

    await db.collection(COL.variants).updateOne(
      { _id: new Types.ObjectId(chainVariantId) },
      { $set: { lowStockThreshold: 25 } },
    );
    const chainList = await inventoryReadService.listStoreInventory(ctx.storeId, {
      productId: String(ctx.productId),
    });
    const chainRow = chainList.data.find((r) => r.variantId === chainVariantId);
    eq(chainRow.lowStockThreshold, 25, 'the list reports the variant-level threshold');

    const chainBalance = await inventoryReadService.getBalance(chainVariantId);
    eq(chainBalance.lowStockThreshold, 25, 'getBalance agrees with the list on the threshold');
    eq(chainBalance.isLowStock, chainRow.isLowStock, 'and on the low-stock flag');
    eq(
      await inventoryReadService.effectiveThreshold(chainVariantId),
      25,
      'effectiveThreshold resolves the variant level',
    );

    // The balance override still wins over the variant level, in all three readers.
    await inventoryService.setThreshold({
      storeId: ctx.storeId,
      variantId: chainVariantId,
      threshold: 40,
    });
    const overriddenList = await inventoryReadService.listStoreInventory(ctx.storeId, {
      productId: String(ctx.productId),
    });
    const overriddenRow = overriddenList.data.find((r) => r.variantId === chainVariantId);
    eq(overriddenRow.lowStockThreshold, 40, 'the balance override beats the variant level');
    eq(
      (await inventoryReadService.effectiveThreshold(chainVariantId)),
      40,
      'effectiveThreshold prefers the balance override',
    );
    eq(
      (await inventoryReadService.getBalance(chainVariantId)).lowStockThreshold,
      40,
      'getBalance prefers the balance override',
    );

    // Clearing it falls back to the variant level rather than to nothing.
    await inventoryService.setThreshold({
      storeId: ctx.storeId,
      variantId: chainVariantId,
      threshold: null,
    });
    eq(
      (await inventoryReadService.effectiveThreshold(chainVariantId)),
      25,
      'clearing the override reveals the variant level again',
    );

    await db.collection(COL.variants).updateOne(
      { _id: new Types.ObjectId(chainVariantId) },
      { $set: { lowStockThreshold: null } },
    );
    eq(
      await inventoryReadService.effectiveThreshold(chainVariantId),
      productThreshold,
      'with no overrides left the product default applies',
    );
  }

  // -------------------------------------------------------------------------------
  console.log('\ncontroller guards');
  {
    // (3) A request naming a target but no threshold used to default to null, which silently
    // wiped an existing override instead of doing nothing.
    const { InventoryController } = require('../dist/modules/inventory/inventory.controller');
    const controller = app.get(InventoryController);
    // A real vendor id, so the auth step resolves this fixture's store and the assertions
    // below measure the input guards rather than tripping over STORE_NOT_FOUND first.
    const fakeUser = { id: String(ctx.store.vendorId) };
    const targetVariantId = v['Small-Red'].variantId;

    await inventoryService.setThreshold({
      storeId: ctx.storeId,
      variantId: targetVariantId,
      threshold: 7,
    });

    // Exactly one target: naming both or neither is ambiguous.
    for (const [body, label] of [
      [{ variantId: targetVariantId, productId: String(ctx.productId) }, 'both targets'],
      [{}, 'neither target'],
    ]) {
      const code = codeOf(await errOf(() => controller.setThreshold(body, { user: fakeUser })));
      assert(
        code === 'VALIDATION_INVALID_VALUE',
        `setThreshold refuses ${label} (${code})`,
      );
    }

    // The omitted-threshold hole.
    const omitted = codeOf(
      await errOf(() => controller.setThreshold({ variantId: targetVariantId }, { user: fakeUser })),
    );
    assert(
      omitted === 'VALIDATION_INVALID_VALUE',
      `an omitted threshold is refused instead of clearing (${omitted})`,
    );
    eq(
      await inventoryReadService.effectiveThreshold(targetVariantId),
      7,
      'and the existing override survived the refused request',
    );

    // Explicit null without clear is still refused.
    const nullNoClear = codeOf(
      await errOf(() =>
        controller.setThreshold({ variantId: targetVariantId, threshold: null }, { user: fakeUser }),
      ),
    );
    assert(
      nullNoClear === 'VALIDATION_INVALID_VALUE',
      `threshold: null without clear is refused (${nullNoClear})`,
    );
    eq(
      await inventoryReadService.effectiveThreshold(targetVariantId),
      7,
      'the override survived that too',
    );

    // A malformed ObjectId in the ledger's variantId filter must be rejected, not ignored.
    // The code is VARIANT_NOT_FOUND rather than a validation code: that is the pre-existing
    // behaviour of the shared `variantId()` helper, which every variant route uses, and
    // changing it here would alter responses well outside Phase 5. What matters here is that
    // the filter is applied to a validated id at all, so the assertion pins the code to stop
    // it passing on some unrelated failure.
    const badId = codeOf(
      await errOf(() =>
        controller.listStoreMovements({ variantId: 'not-an-object-id' }, { user: fakeUser }),
      ),
    );
    assert(badId === 'VARIANT_NOT_FOUND', `a malformed variantId is rejected (${badId})`);

    // A well-formed variantId from another store must not leak that store's movements. The
    // store scope comes from the session, so this is about the filter not bypassing it.
    const foreign = new Types.ObjectId();
    const foreignResult = await movementsService.listForStore(ctx.storeId, {
      singleVariantId: foreign,
    });
    eq(foreignResult.data.length, 0, 'an unrelated variantId matches nothing in this store');
  }

  console.log(`\n[SMOKE] ${passed} assertions passed`);
}

main()
  .catch((e) => {
    console.error('\n[SMOKE] crashed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    if (app) await app.close();
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });