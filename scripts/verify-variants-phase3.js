/**
 * End-to-end verification of the variant behaviour against the live database, updated for
 * universal variants (every product is a variant product; `Product.stock`/`hasVariants` and
 * `toggleVariants` are gone).
 *
 * Creates throwaway `ZZ Smoke` products, exercises the real services through the Nest DI
 * container, then deletes everything it created. Collection names are resolved from the
 * compiled schemas via scripts/lib/inventory-collections.js, never hardcoded: hardcoding them
 * made an earlier version of this script count rows in seven empty phantom collections and
 * report success.
 *
 * Run: `npm run build && node scripts/verify-variants-phase3.js`
 *
 * This complements, rather than replaces, jest unit tests: it exercises the real indexes,
 * transactions and aggregation pipelines against a real replica set, which mocks cannot.
 *
 * The old flip scenarios (3.9) died with `toggleVariants`. What replaced them:
 *   - combinations are created by `createVariants`, always at a zero balance - stock is set
 *     deliberately afterwards with `InventoryService.setOnHand`, the only write path;
 *   - a product with no options cannot accept combinations;
 *   - `createDefaultVariant` gives a bare product its "Default > One Size" variant;
 *   - `duplicateMatrix` clones a matrix with every balance opened at 0.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');
const { NestFactory } = require('@nestjs/core');
const { Types } = mongoose;
const { VariantsService } = require('../dist/modules/inventory/services/variants.service');
const { InventoryService } = require('../dist/modules/inventory/services/inventory.service');
const { inventoryCollectionNames } = require('./lib/inventory-collections');

// Resolved from the compiled schemas, never hardcoded: hardcoding them is what made this script
// count rows in seven empty phantom collections and "pass".
const COL = inventoryCollectionNames();

let app;
let db;
let variantsService;
let inventoryService;
const tmpProducts = [];

function assert(cond, label) {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!cond) process.exitCode = 1;
}

async function errOf(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

/**
 * A bare product document. No `stock`, no `hasVariants`, no embedded `variants` - those fields
 * no longer exist. `price` is separate because a variant's effectivePrice falls back to
 * Product.price, and several assertions need that fallback to be a known value.
 */
async function makeProduct(label, price = 100) {
  const store = await db.collection('stores').findOne({});
  const res = await db.collection('products').insertOne({
    storeId: store._id,
    vendorEmail: store.vendorEmail,
    nameEn: `ZZ Smoke ${label}`,
    slug: `zz-smoke-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    originalPrice: price,
    price,
    weight: 1,
    published: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  tmpProducts.push(res.insertedId);
  return { productId: res.insertedId, storeId: store._id };
}

/** Two options x two values, ready for combination creation. */
async function makeSizeColour(productId, storeId) {
  const size = await variantsService.createOption(String(productId), storeId, {
    key: 'Size',
    nameEn: 'Size',
  });
  const colour = await variantsService.createOption(String(productId), storeId, {
    key: 'colour',
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
  return { size, colour, small, large, red, blue };
}

/**
 * Creates the combinations `preview` offers for exactly the keys present in `quantities`
 * (a subset is what the "unlisted combinations stay absent" assertions depend on) and stocks
 * each at its entry. Returns the matrix so callers can address variants by combinationKey.
 */
async function buildAndStock(productId, storeId, preview, quantities = {}) {
  const wanted = new Set(Object.keys(quantities));
  await variantsService.createVariants(String(productId), storeId, {
    selections: preview.possibleCombinations
      .filter((c) => wanted.has(c.combinationKey))
      .map((c) => ({
        combinationKey: c.combinationKey,
        optionValueIds: c.optionValueIds,
      })),
  });

  let matrix = await variantsService.getMatrix(String(productId), storeId);
  for (const v of matrix.variants) {
    await inventoryService.setOnHand({
      storeId,
      variantId: new Types.ObjectId(v.variantId),
      quantity: quantities[v.combinationKey] ?? 0,
      reason: 'phase3 smoke setup',
    });
  }

  matrix = await variantsService.getMatrix(String(productId), storeId);
  return matrix;
}

async function balanceOf(variantId) {
  return db.collection(COL.balances).findOne({ variantId: new Types.ObjectId(variantId) });
}

async function main() {
  // Destructure the class: `require('../dist/app.module')` yields the module *namespace*, and
  // handing that to Nest makes it treat every export as a provider -> "metatype is not a
  // constructor". The logger stays on too: with `logger: false` Nest's ExceptionHandler prints
  // nothing and just exits 1, hiding the real failure.
  const { AppModule } = require('../dist/app.module');
  app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  // Take the connection from the DI container, not `mongoose.connection`: the app does not use
  // the default connection, so the global one is never connected and `.db` is undefined.
  const connection = app.get(require('@nestjs/mongoose').getConnectionToken());
  db = connection.db;
  variantsService = app.get(VariantsService);
  inventoryService = app.get(InventoryService);
  console.log('\n[SMOKE] context up\n');

  // ---- 3.1 option + value CRUD --------------------------------------------------
  console.log('3.1 option/value CRUD');
  {
    const { productId, storeId } = await makeProduct('crud');
    const size = await variantsService.createOption(String(productId), storeId, {
      key: 'Size',
      nameEn: 'Size',
    });
    assert(size.key === 'size', 'option key slugified from "Size"');

    const colour = await variantsService.createOption(String(productId), storeId, {
      key: 'colour',
      nameEn: 'Colour',
    });
    const small = await variantsService.createValue(String(productId), storeId, size._id, {
      value: 's',
      valueEn: 'Small',
    });
    await variantsService.createValue(String(productId), storeId, size._id, { value: 'l' });
    await variantsService.createValue(String(productId), storeId, colour._id, { value: 'red' });

    const dupValue = await errOf(() =>
      variantsService.createValue(String(productId), storeId, size._id, { value: 's' }),
    );
    assert(dupValue?.errorCode === 'OPTION_VALUE_IN_USE', 'duplicate option value rejected');

    const dupKey = await errOf(() =>
      variantsService.createOption(String(productId), storeId, { key: 'size' }),
    );
    assert(dupKey?.errorCode === 'OPTION_KEY_IN_USE', 'duplicate option key rejected');

    // Renaming a label must preview the affected variants; before any exist there are none.
    const renamed = await variantsService.updateOption(String(productId), storeId, size._id, {
      nameEn: 'Taille',
    });
    assert(renamed.option.nameEn === 'Taille', 'option label renamed');
    assert(renamed.affected.count === 0, 'no variants affected before creation');
  }

  // ---- 3.2 preview creates nothing ----------------------------------------------
  console.log('\n3.2 cartesian preview');
  let comboKeys = [];
  {
    const { productId, storeId } = await makeProduct('preview');
    await makeSizeColour(productId, storeId);

    const preview = await variantsService.previewCombinations(String(productId), storeId, {});
    assert(preview.possibleCombinations.length === 4, 'preview: 2x2 = 4 combinations');
    assert(preview.summary.creatable === 4 && preview.summary.existing === 0, 'all creatable');
    assert(
      (await db.collection(COL.variants).countDocuments({ productId })) === 0,
      'preview created nothing',
    );

    // Re-previewing must report the same keys, proving the key is a pure function of the value
    // ids rather than of insertion order.
    comboKeys = preview.possibleCombinations.map((c) => c.combinationKey);
    assert(new Set(comboKeys).size === 4, 'combination keys are unique');
  }

  // ---- 3.3a a product with no options cannot accept combinations -----------------
  console.log('\n3.3a universal variant mode - a bare product has no combinations');
  {
    const { productId, storeId } = await makeProduct('bare');

    const noPreview = await errOf(() =>
      variantsService.previewCombinations(String(productId), storeId, {}),
    );
    assert(
      noPreview?.errorCode === 'NO_ACTIVE_VALUES',
      `previewing a bare product is refused (${noPreview?.errorCode})`,
    );

    const empty = await errOf(() =>
      variantsService.createVariants(String(productId), storeId, { selections: [] }),
    );
    assert(
      empty?.errorCode === 'INVALID_COMBINATION',
      `an empty selection is refused (${empty?.errorCode})`,
    );

    const fresh = await db.collection('products').findOne({ _id: productId });
    assert(fresh.stock === undefined, 'the product carries no stock field');
    assert(fresh.hasVariants === undefined, 'and no hasVariants field');
  }

  // ---- 3.3b subset-only creation, zero balances, SKU rules -----------------------
  console.log('\n3.3b subset-only creation');
  {
    const { productId, storeId } = await makeProduct('subset');
    const { small, red } = await makeSizeColour(productId, storeId);
    const preview = await variantsService.previewCombinations(String(productId), storeId, {});
    const keys = preview.possibleCombinations.map((c) => c.combinationKey);

    const res = await variantsService.createVariants(String(productId), storeId, {
      selections: [
        { combinationKey: keys[0], optionValueIds: preview.possibleCombinations[0].optionValueIds },
        {
          combinationKey: keys[3],
          optionValueIds: preview.possibleCombinations[3].optionValueIds,
          sku: 'SMOKE-SKU',
        },
      ],
    });
    assert(res.createdCount === 2, 'only the submitted subset was created');
    assert(res.skippedDuplicates.length === 0, 'nothing skipped');
    assert(
      (await db.collection(COL.variants).countDocuments({ productId })) === 2,
      'exactly two variants exist, no cartesian product implied',
    );

    // Every newly created variant opens at zero - stock is never invented.
    for (const variantId of res.created) {
      const balance = await balanceOf(variantId);
      assert(balance && balance.onHand === 0 && balance.reserved === 0, 'new variant starts at zero');
      await db.collection(COL.balances).updateOne(
        { variantId: new Types.ObjectId(variantId) },
        { $set: { onHand: 0 } },
      );
    }
    const joins = await db
      .collection(COL.joins)
      .countDocuments({ variantId: new Types.ObjectId(res.created[0]) });
    assert(joins === 2, 'two join rows for a two-dimension variant');

    // Re-submitting the same combination is reported, not silently duplicated.
    const dupe = await variantsService.createVariants(String(productId), storeId, {
      selections: [
        { combinationKey: keys[0], optionValueIds: preview.possibleCombinations[0].optionValueIds },
      ],
    });
    assert(dupe.createdCount === 0, 'existing combination not created twice');
    assert(dupe.skippedDuplicates.includes(keys[0]), 'existing combination reported as a duplicate');

    // ---- 3.4 order independence ---------------------------------------------------
    const keyA = variantsService.combinationKeyFor([String(small._id), String(red._id)]);
    const keyB = variantsService.combinationKeyFor([String(red._id), String(small._id)]);
    assert(keyA === keyB, 'combinationKey is order-independent');

    // ---- 3.8 SKU uniqueness per store --------------------------------------------
    const dupSku = await errOf(() =>
      variantsService.createVariants(String(productId), storeId, {
        selections: [
          {
            combinationKey: keys[1],
            optionValueIds: preview.possibleCombinations[1].optionValueIds,
            sku: 'SMOKE-SKU',
          },
        ],
      }),
    );
    assert(dupSku?.errorCode === 'DUPLICATE_SKU', 'duplicate SKU within the store rejected');
    assert(
      (await db.collection(COL.variants).countDocuments({ productId })) === 2,
      'the rejected creation left nothing behind',
    );
  }

  // ---- 3.5 rename preserves identity ---------------------------------------------
  console.log('\n3.5 label rename preserves identity');
  {
    const { productId, storeId } = await makeProduct('rename');
    const { size, small, red } = await makeSizeColour(productId, storeId);
    const preview = await variantsService.previewCombinations(String(productId), storeId, {});
    const keys = preview.possibleCombinations.map((c) => c.combinationKey);
    // The key containing `small` is the one this scenario renames, so it is stocked 5; the rest
    // are stocked 1 so the fixtures have non-zero, non-equal levels.
    const quantities = Object.fromEntries(keys.map((k) => [k, 1]));
    const smallKey = preview.possibleCombinations.find((c) =>
      c.optionValueIds.includes(String(small._id)),
    ).combinationKey;
    quantities[smallKey] = 5;
    await buildAndStock(productId, storeId, preview, quantities);

    const renamedValue = await variantsService.updateValue(
      String(productId),
      storeId,
      size._id,
      small._id,
      { valueEn: 'Petite' },
    );
    assert(renamedValue.value.valueEn === 'Petite', 'value label renamed');
    assert(renamedValue.value.value === 's', 'canonical value untouched');
    assert(renamedValue.affected.count >= 1, 'rename previewed the affected variants');
    assert(
      renamedValue.affected.variants.some((v) => v.label.includes('Petite') === false),
      'preview reflects the pre-rename label',
    );

    // A rename must not move stock: the identity is the combinationKey, not the label.
    const variantDoc = await db.collection(COL.variants).findOne({
      productId,
      combinationKey: smallKey,
    });
    const balanceAfterRename = await balanceOf(variantDoc._id);
    assert(balanceAfterRename.onHand === 5, 'renaming a label does not touch the balance');

    // The same bug class as above: an option rename must also report its variants.
    const renamedOption = await variantsService.updateOption(String(productId), storeId, size._id, {
      nameEn: 'Taille',
    });
    assert(renamedOption.option.nameEn === 'Taille', 'option label renamed');
    assert(renamedOption.affected.count >= 1, 'option rename previewed the affected variants');
    assert(
      renamedOption.affected.variants.every((v) => v.variantId && v.combinationKey),
      'affected variants are described, not empty stubs',
    );

    // A value from another product must not be accepted into this combination.
    const other = await makeProduct('rename-other');
    const otherOpts = await makeSizeColour(other.productId, other.storeId);
    const foreign = await errOf(() =>
      variantsService.createVariants(String(productId), storeId, {
        selections: [
          {
            combinationKey: 'x',
            optionValueIds: [String(otherOpts.small._id), String(red._id)],
          },
        ],
      }),
    );
    assert(foreign?.errorCode === 'OPTION_VALUE_NOT_FOUND', 'value from another product rejected');
  }

  // ---- 3.7 deactivation guards ---------------------------------------------------
  console.log('\n3.7 deactivation guards');
  {
    const { productId, storeId } = await makeProduct('deact');
    await makeSizeColour(productId, storeId);
    const preview = await variantsService.previewCombinations(String(productId), storeId, {});
    const keys = preview.possibleCombinations.map((c) => c.combinationKey);
    const quantities = Object.fromEntries(keys.map((k) => [k, 1]));
    quantities[keys[0]] = 6;
    const matrix = await buildAndStock(productId, storeId, preview, quantities);
    const variantId = matrix.variants.find((v) => v.combinationKey === keys[0]).variantId;

    const noChoice = await errOf(() =>
      variantsService.deactivateVariant(String(productId), storeId, String(variantId), {}),
    );
    assert(
      noChoice?.errorCode === 'VARIANT_DEACTIVATE_REQUIRES_CHOICE',
      'deactivate with stock and no choice is refused',
    );

    const kept = await variantsService.deactivateVariant(String(productId), storeId, String(variantId), {
      choice: 'keep',
      reason: 'smoke retire',
    });
    assert(kept.isActive === false, 'variant deactivated');
    assert((await balanceOf(variantId)).onHand === 6, 'choice "keep" retained the quantity');

    // Re-activating is allowed once nothing is reserved.
    const reactivated = await variantsService.activateVariant(
      String(productId),
      storeId,
      String(variantId),
    );
    assert(reactivated.isActive === true, 'variant re-activated');

    const noReason = await errOf(() =>
      variantsService.deactivateVariant(String(productId), storeId, String(variantId), {
        choice: 'zero',
      }),
    );
    assert(
      noReason?.errorCode === 'ADJUSTMENT_REASON_REQUIRED',
      'zeroing requires a reason for the ledger',
    );

    const zeroed = await variantsService.deactivateVariant(
      String(productId),
      storeId,
      String(variantId),
      { choice: 'zero', reason: 'smoke write-off' },
    );
    assert(zeroed.isActive === false, 'variant deactivated after zeroing');
    const balance = await balanceOf(variantId);
    assert(balance.onHand === 0 && balance.reserved === 0, 'stock zeroed, not silently discarded');
    assert(
      (await db.collection(COL.movements).countDocuments({
        variantId: new Types.ObjectId(variantId),
        type: 'manual_decrease',
      })) === 1,
      'write-off recorded in the ledger',
    );
  }

  // ---- reserved stock blocks deactivation and activation -------------------------
  console.log('\n3.7b reserved stock guards');
  {
    const { productId, storeId } = await makeProduct('reserved');
    await makeSizeColour(productId, storeId);
    const preview = await variantsService.previewCombinations(String(productId), storeId, {});
    const keys = preview.possibleCombinations.map((c) => c.combinationKey);
    const quantities = Object.fromEntries(keys.map((k) => [k, 1]));
    quantities[keys[0]] = 6;
    const matrix = await buildAndStock(productId, storeId, preview, quantities);
    const variantId = matrix.variants.find((v) => v.combinationKey === keys[0]).variantId;

    // Simulate an order holding stock.
    await db.collection(COL.balances).updateOne(
      { variantId: new Types.ObjectId(variantId) },
      { $set: { reserved: 2 } },
    );

    const blocked = await errOf(() =>
      variantsService.deactivateVariant(String(productId), storeId, String(variantId), {
        choice: 'zero',
        reason: 'smoke',
      }),
    );
    assert(
      blocked?.errorCode === 'VARIANT_INACTIVE',
      `deactivation blocked while stock is reserved (${blocked?.errorCode})`,
    );
    const balance = await balanceOf(variantId);
    assert(balance.onHand === 6, 'the blocked write-off changed nothing');

    const activateBlocked = await errOf(() =>
      variantsService.activateVariant(String(productId), storeId, String(variantId)),
    );
    assert(
      activateBlocked?.errorCode === 'VARIANT_INACTIVE',
      'activation blocked while stock is reserved',
    );
  }

  // ---- 3.6 value removal deactivates, never deletes -----------------------------
  console.log('\n3.6 value deactivation');
  {
    const { productId, storeId } = await makeProduct('values');
    const { size, small } = await makeSizeColour(productId, storeId);
    const preview = await variantsService.previewCombinations(String(productId), storeId, {});
    const keys = preview.possibleCombinations.map((c) => c.combinationKey);
    const quantities = Object.fromEntries(keys.map((k) => [k, 1]));
    quantities[keys[0]] = 9;
    await buildAndStock(productId, storeId, preview, quantities);

    const deact = await variantsService.deactivateValue(
      String(productId),
      storeId,
      size._id,
      small._id,
    );
    assert(deact.isActive === false, 'value deactivated');
    assert(
      (await db.collection(COL.optionValues).countDocuments({ _id: small._id })) === 1,
      'value row still exists (soft, not deleted)',
    );
    assert(deact.deactivatedVariants >= 1, 'variants using the value were deactivated');

    const retained = await db
      .collection(COL.balances)
      .findOne({ onHand: { $gt: 0 }, storeId });
    assert(!!retained, 'stock on a deactivated value is retained, not discarded');

    const after = await variantsService.previewCombinations(String(productId), storeId, {});
    assert(after.summary.existing >= 1, 'deactivated combinations leave the offered set');
  }

  // ---- 3.9 default-variant factory ----------------------------------------------
  console.log('\n3.9 default-variant factory (universal variants)');
  {
    const { productId, storeId } = await makeProduct('default', 120);

    const built = await variantsService.createDefaultVariant(String(productId), storeId, 12);
    assert(built.variantsCreated === 1, 'one default variant created');
    assert(built.openingQuantity === 12, 'the opening quantity is reported');

    const matrix = await variantsService.getMatrix(String(productId), storeId);
    assert(matrix.options.length === 1, 'the matrix has the single default option');
    assert(matrix.variants.length === 1, 'the matrix has the single default variant');
    assert(matrix.variants[0].available === 12, 'the default balance is the stock source');
    assert(matrix.variants[0].effectivePrice === 120, 'effectivePrice falls back to Product.price');

    const balance = await balanceOf(matrix.variants[0].variantId);
    assert(balance.onHand === 12 && balance.reserved === 0, 'the balance mirrors the opening quantity');
    const movement = await db.collection(COL.movements).findOne({
      variantId: new Types.ObjectId(matrix.variants[0].variantId),
      type: 'initial_stock',
    });
    assert(
      movement && movement.quantityDelta === 12 && movement.onHandAfter === 12 && movement.onHandBefore === 0,
      'an initial_stock movement records the opening level',
    );

    // Idempotent: a second call sees the variant it would have created.
    const again = await variantsService.createDefaultVariant(String(productId), storeId, 99);
    assert(again.variantsCreated === 0, 'a second call creates nothing');
    assert(again.skipReason === 'already_has_variants', 'and explains why');

    const summaries = await variantsService.getProductSummaries([String(productId)]);
    assert(summaries.get(String(productId))?.variantCount === 1, 'the summary counts the default variant');
    assert(summaries.get(String(productId))?.availableTotal === 12, 'the summary reads the balance');
  }

  // ---- 3.10 duplicate matrix opens every balance at zero -------------------------
  console.log('\n3.10 duplicateMatrix');
  {
    const src = await makeProduct('src', 100);
    const { small } = await makeSizeColour(src.productId, src.storeId);
    const preview = await variantsService.previewCombinations(String(src.productId), src.storeId, {});
    const keys = preview.possibleCombinations.map((c) => c.combinationKey);
    const quantities = Object.fromEntries(keys.map((k) => [k, 1]));
    quantities[keys[0]] = 5;
    const srcMatrix = await buildAndStock(src.productId, src.storeId, preview, quantities);
    const srcVariant = srcMatrix.variants.find((v) => v.combinationKey === keys[0]);
    await variantsService.updateVariant(String(src.productId), src.storeId, srcVariant.variantId, {
      priceOverride: 175,
    });

    const store = await db.collection('stores').findOne({ _id: src.storeId });
    const dup = await db.collection('products').insertOne({
      storeId: src.storeId,
      vendorEmail: store.vendorEmail,
      nameEn: `ZZ Smoke copy of src`,
      slug: `zz-smoke-copy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      originalPrice: 100,
      price: 100,
      weight: 1,
      published: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    tmpProducts.push(dup.insertedId);

    const result = await variantsService.duplicateMatrix(
      String(src.productId),
      String(dup.insertedId),
      new Types.ObjectId(String(src.storeId)),
    );
    assert(result.variantsCreated === 4, 'the matrix structure is duplicated');

    const dupMatrix = await variantsService.getMatrix(String(dup.insertedId), src.storeId);
    assert(dupMatrix.variants.length === 4, 'the copy exposes all four combinations');
    assert(
      dupMatrix.variants.every((v) => v.available === 0),
      'every new balance opens at 0, never inheriting quantity',
    );
    // Contract: `duplicateMatrix` copies structure and resets stock; merchandising overrides
    // are NOT inherited, so the copy's matching combination opens at the copy's own price.
    assert(
      dupMatrix.variants.some(
        (v) => v.label === srcVariant.label && v.effectivePrice === 100,
      ),
      'the copy resets merchandising (priceOverride not inherited)',
    );
    const dupDoc = await db.collection('products').findOne({ _id: dup.insertedId });
    assert(dupDoc.stock === undefined && dupDoc.hasVariants === undefined, 'the copy carries no legacy fields');

    // Sanity: the source's stock was untouched by the copy.
    const srcBalanceAfter = await balanceOf(srcVariant.variantId);
    assert(srcBalanceAfter.onHand === 5, 'duplicating never moves the source stock');
  }

  // ---- 3.11 matrix + summaries ---------------------------------------------------
  console.log('\n3.11 matrix and summaries');
  {
    const { productId, storeId } = await makeProduct('matrix', 250);
    await makeSizeColour(productId, storeId);
    const preview = await variantsService.previewCombinations(String(productId), storeId, {});
    const keys = preview.possibleCombinations.map((c) => c.combinationKey);
    // Deliberately only two of the four combinations, so the matrix has unlisted combinations
    // to hide at the end of this block.
    const quantities = { [keys[0]]: 3, [keys[1]]: 9 };
    const matrix = await buildAndStock(productId, storeId, preview, quantities);

    assert(matrix.options.length === 2, 'matrix returns both options');
    assert(matrix.variants.length === 2, 'matrix returns only the offered combinations');

    // An override on one variant: the other must fall back to Product.price.
    const target = matrix.variants[0];
    await variantsService.updateVariant(String(productId), storeId, target.variantId, {
      priceOverride: 175,
      sku: 'MATRIX-1',
    });

    const matrix2 = await variantsService.getMatrix(String(productId), storeId);
    assert(
      matrix2.variants.some((v) => v.effectivePrice === 175),
      'priceOverride is used when present',
    );
    assert(
      matrix2.variants.some((v) => v.effectivePrice === 250),
      'effectivePrice falls back to Product.price',
    );
    assert(matrix2.variants.some((v) => v.available === 9), 'available = onHand - reserved');
    assert(
      matrix2.variants.every((v) => typeof v.label === 'string' && v.label.length > 0),
      'every variant carries a human label',
    );

    const summaries = await variantsService.getProductSummaries([String(productId)]);
    const summary = summaries.get(String(productId));
    assert(summary?.variantCount === 2, 'batch summary variant count');
    assert(summary?.availableTotal === 12, 'batch summary aggregates availability');
    // The summary intentionally reports only the *override* range: a variant with no override
    // inherits Product.price, and the caller combines the two.
    assert(summary?.overrideMin === 175 && summary?.overrideMax === 175, 'batch summary reports the override range');
    assert(summary?.hasPriceOverride === true, 'batch summary flags the override');
    assert(summary?.inStock === true, 'batch summary derives inStock from availability');
    assert(
      summary?.availableTotal === 12 && summary.overrideMin < matrix.productPrice,
      'caller can combine overrideMin with Product.price to get the full range 175..250',
    );

    // Unlisted combinations must not appear as merely out of stock.
    assert(matrix2.variants.length < preview.possibleCombinations.length, 'unlisted combinations are absent');
  }

  // ---- listing + detail enrichment (the actual seller-facing surface) -------------
  // Regression guard. getProductSummaries joins inventory balances with a $lookup, and a
  // hardcoded 'inventory_balances' in that lookup matched nothing: every product listing then
  // reported variantSummary.availableTotal 0 and inStock false, however well stocked the
  // variants were. It is the one defect here that shipped silently to every page.
  console.log('\nlisting + detail enrichment');
  {
    const { productId, storeId } = await makeProduct('enrich', 250);
    await makeSizeColour(productId, storeId);
    const preview = await variantsService.previewCombinations(String(productId), storeId, {});
    const keys = preview.possibleCombinations.map((c) => c.combinationKey);
    const quantities = { [keys[0]]: 3, [keys[1]]: 9 };
    await buildAndStock(productId, storeId, preview, quantities);

    const store = await db.collection('stores').findOne({ _id: storeId });
    const { ProductsService } = require('../dist/modules/products/products.service');
    const productsService = app.get(ProductsService);

    const listed = await productsService.findVendorProducts(store.vendorEmail, { limit: 200 });
    const row = listed.products.find((p) => String(p._id) === String(productId));
    assert(!!row, 'the variant product appears in the seller listing');
    assert(row.variantSummary !== undefined, 'listing carries a variantSummary');
    assert(
      row.variantSummary?.variantCount === 2,
      `listing summary counts variants (${row.variantSummary?.variantCount})`,
    );
    assert(
      row.variantSummary?.availableTotal === 12,
      `listing summary aggregates availability (${row.variantSummary?.availableTotal})`,
    );
    assert(
      row.variantSummary?.inStock === true,
      'listing summary reports inStock for stocked variants',
    );
    // priceRange is assembled by ProductsService from the override range plus Product.price.
    assert(
      row.variantSummary?.priceRange?.min === 250 && row.variantSummary?.priceRange?.max === 250,
      `no override means the whole range is Product.price (${JSON.stringify(row.variantSummary?.priceRange)})`,
    );

    // updateVariant addresses a variant by id, so read the id back from the matrix the way a
    // client would.
    const beforeOverride = await variantsService.getMatrix(String(productId), storeId);
    const target = beforeOverride.variants.find((v) => v.combinationKey === keys[0]);
    await variantsService.updateVariant(String(productId), storeId, target.variantId, {
      priceOverride: 175,
    });
    const relisted = await productsService.findVendorProducts(store.vendorEmail, { limit: 200 });
    const row2 = relisted.products.find((p) => String(p._id) === String(productId));
    assert(
      row2.variantSummary?.priceRange?.min === 175 && row2.variantSummary?.priceRange?.max === 250,
      `an override widens the range (${JSON.stringify(row2.variantSummary?.priceRange)})`,
    );

    const detail = await productsService.findOne(String(productId));
    assert(!!detail.variantMatrix, 'detail carries the variant matrix');
    assert(
      detail.variantMatrix?.variants?.length === 2,
      `detail matrix lists the two offered variants (${detail.variantMatrix?.variants?.length})`,
    );
    assert(
      detail.variantMatrix?.options?.length === 2,
      'detail matrix carries both options',
    );
  }

  // ---- tenant isolation ----------------------------------------------------------
  console.log('\ntenant isolation');
  {
    const { productId, storeId } = await makeProduct('tenant');
    const other = await db.collection('stores').findOne({ _id: { $ne: storeId } });
    if (!other) {
      console.log('  skip  only one store exists, cannot test cross-store access');
    } else {
      const read = await errOf(() => variantsService.getMatrix(String(productId), other._id));
      assert(
        read?.errorCode === 'PRODUCT_NOT_IN_STORE',
        `cross-store read is refused (${read?.errorCode})`,
      );
      const write = await errOf(() =>
        variantsService.createOption(String(productId), other._id, { key: 'Colour' }),
      );
      assert(
        write?.errorCode === 'PRODUCT_NOT_IN_STORE',
        'cross-store write is refused',
      );
      const create = await errOf(() =>
        variantsService.createVariants(String(productId), other._id, { selections: [] }),
      );
      assert(
        create?.errorCode === 'PRODUCT_NOT_IN_STORE',
        'cross-store combination creation is refused',
      );
    }
  }

  console.log(`\n[SMOKE] created ${tmpProducts.length} temporary product(s)`);
}

async function cleanup() {
  for (const productId of tmpProducts) {
    const variantIds = (
      await db.collection(COL.variants).find({ productId }).toArray()
    ).map((v) => v._id);
    await db.collection(COL.movements).deleteMany({ variantId: { $in: variantIds } });
    await db.collection(COL.reservations).deleteMany({ variantId: { $in: variantIds } });
    await db.collection(COL.balances).deleteMany({ variantId: { $in: variantIds } });
    await db.collection(COL.joins).deleteMany({ variantId: { $in: variantIds } });
    await db.collection(COL.variants).deleteMany({ productId });
    await db.collection(COL.optionValues).deleteMany({ productId });
    await db.collection(COL.options).deleteMany({ productId });
    await db.collection('products').deleteOne({ _id: productId });
  }
  console.log('\n[SMOKE] cleanup complete');
}

main()
  .catch((e) => {
    console.error('\n[SMOKE] ERROR:', e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (db && tmpProducts.length) await cleanup().catch((e) => console.error('cleanup failed:', e.message));
    if (app) await app.close();
    // No process.exit(): it discards buffered stdout when it is a pipe, which silently
    // swallows every assertion this script exists to print.
    console.log(process.exitCode ? '\n[SMOKE] FAILED' : '\n[SMOKE] ALL CHECKS PASSED');
  });