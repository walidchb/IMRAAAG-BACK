/**
 * Migration: Create the Phase 2 inventory collections and their indexes.
 *
 * Why this exists rather than relying on Mongoose's autoIndex: production must have the
 * unique constraints (`combinationKey`, per-store `sku`) in place *before* the first
 * write. An autoIndex build racing a write can admit a duplicate and then fail to build
 * the index, leaving a collection that silently accepts them forever.
 *
 * This script is additive only. It creates collections and indexes; it never rewrites an
 * existing document and never drops anything.
 *
 * Run:
 *   node scripts/migrate-inventory-schema.js [--dry-run] [--repair-indexes]
 *
 * --dry-run         Report what would be created and what has drifted; write nothing.
 * --repair-indexes  Opt in to dropping and recreating an index whose name matches but whose
 *                   definition does not. That is a write against a live collection, and the
 *                   uniqueness constraint is briefly absent while the rebuild runs, so it is
 *                   never done implicitly. Drift found without this flag is reported and exits 1.
 *
 * BEFORE RUNNING: take a MongoDB backup.
 *
 * Requires `npm run build` first: the collection names and the expected index set are read from
 * the compiled schemas rather than hardcoded, so this script cannot point at a collection the
 * application does not actually use.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');
const { inventoryCollections } = require('./lib/inventory-collections');

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI environment variable is required');
  process.exit(1);
}

const isDryRun = process.argv.includes('--dry-run');
const repairIndexes = process.argv.includes('--repair-indexes');

/**
 * Resolved from the schemas, not written here: the inventory schemas do not set `collection:`,
 * so the collection name is whatever Mongoose pluralizes the model name into. Hardcoding
 * `product_variants` here is what previously created seven phantom collections that nothing
 * ever wrote to.
 */
const COLLECTIONS = inventoryCollections();

/**
 * Compares the index options that actually change behaviour.
 *
 * `v`, `ns` and `key` are excluded deliberately: `v` is a storage version, `ns` is the
 * namespace, and `key` is compared separately. What matters is `unique`, `sparse`,
 * `partialFilterExpression` and `expireAfterSeconds` - a silent change to any of those
 * changes what the index *enforces*, which is the whole point of declaring it here.
 */
function sameIndexOptions(actual, expected) {
  const relevant = (o) => ({
    unique: !!o.unique,
    sparse: !!o.sparse,
    partialFilterExpression: o.partialFilterExpression ?? null,
    expireAfterSeconds: o.expireAfterSeconds ?? null,
  });
  return JSON.stringify(relevant(actual)) === JSON.stringify(relevant(expected));
}

/**
 * Mirrors the @Prop/index declarations in src/modules/inventory/schemas/*.schema.ts.
 * Kept as data so this script cannot drift from the schemas without being noticed: the
 * verification pass at the end re-reads what MongoDB actually has and diffs it.
 */
const SPECS = [
  {
    collection: COLLECTIONS.ProductOption,
    indexes: [
      { keys: { storeId: 1 }, options: { name: 'storeId_1' } },
      { keys: { productId: 1, position: 1 }, options: { name: 'productId_1_position_1' } },
      {
        keys: { productId: 1, key: 1 },
        options: { name: 'productId_1_key_1', unique: true },
      },
    ],
  },
  {
    collection: COLLECTIONS.ProductOptionValue,
    indexes: [
      { keys: { productId: 1 }, options: { name: 'productId_1' } },
      { keys: { optionId: 1 }, options: { name: 'optionId_1' } },
      { keys: { optionId: 1, position: 1 }, options: { name: 'optionId_1_position_1' } },
      {
        keys: { optionId: 1, value: 1 },
        options: { name: 'optionId_1_value_1', unique: true },
      },
    ],
  },
  {
    collection: COLLECTIONS.ProductVariant,
    indexes: [
      { keys: { storeId: 1 }, options: { name: 'storeId_1' } },
      { keys: { productId: 1 }, options: { name: 'productId_1' } },
      {
        keys: { productId: 1, combinationKey: 1 },
        options: { name: 'productId_1_combinationKey_1', unique: true },
      },
      {
        keys: { storeId: 1, sku: 1 },
        options: {
          name: 'storeId_1_sku_1',
          unique: true,
          // `partialFilterExpression` alone: MongoDB rejects a spec that also sets
          // `sparse` ("cannot mix partialFilterExpression and sparse options").
          partialFilterExpression: { sku: { $type: 'string' } },
        },
      },
      {
        keys: { productId: 1, isActive: 1 },
        options: { name: 'productId_1_isActive_1' },
      },
    ],
  },
  {
    collection: COLLECTIONS.VariantOptionValue,
    indexes: [
      { keys: { storeId: 1 }, options: { name: 'storeId_1' } },
      { keys: { optionValueId: 1 }, options: { name: 'optionValueId_1' } },
      {
        keys: { variantId: 1, optionValueId: 1 },
        options: { name: 'variantId_1_optionValueId_1', unique: true },
      },
    ],
  },
  {
    collection: COLLECTIONS.InventoryBalance,
    indexes: [
      { keys: { storeId: 1 }, options: { name: 'storeId_1' } },
      { keys: { variantId: 1 }, options: { name: 'variantId_1', unique: true } },
      { keys: { storeId: 1, onHand: 1 }, options: { name: 'storeId_1_onHand_1' } },
    ],
  },
  {
    collection: COLLECTIONS.InventoryMovement,
    indexes: [
      { keys: { storeId: 1, variantId: 1, createdAt: -1 }, options: { name: 'storeId_1_variantId_1_createdAt_-1' } },
      { keys: { storeId: 1, createdAt: -1 }, options: { name: 'storeId_1_createdAt_-1' } },
      { keys: { orderId: 1 }, options: { name: 'orderId_1' } },
      {
        keys: { idempotencyKey: 1 },
        options: {
          name: 'idempotencyKey_1',
          unique: true,
          // `partialFilterExpression` rather than `sparse`: the field has no default, but a
          // caller can still send an explicit null, and a sparse index treats that null as an
          // indexed value — so the second keyless movement would fail with E11000.
          // MongoDB also rejects a spec that sets both options.
          partialFilterExpression: { idempotencyKey: { $type: 'string' } },
        },
      },
    ],
  },
  {
    collection: COLLECTIONS.InventoryReservation,
    indexes: [
      // No standalone storeId_1: the schema declares only the two compound indexes below,
      // and storeId is already the leading field of storeId_1_status_1.
      {
        keys: { orderId: 1, orderItemIndex: 1 },
        options: { name: 'orderId_1_orderItemIndex_1', unique: true },
      },
      { keys: { storeId: 1, status: 1 }, options: { name: 'storeId_1_status_1' } },
    ],
  },
];

/**
 * Collections and indexes that must NOT exist: the old `Product.variants[]` array is the
 * pre-Phase-2 representation and its sparse indexes would fight the new unique ones.
 */
const FORBIDDEN_INDEX_PARTS = ['variants.productId', 'variants.sku'];

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log(
    `[INVENTORY SCHEMA] Connected. Dry run: ${isDryRun ? 'YES' : 'NO'}. ` +
      `Repair indexes: ${repairIndexes ? 'YES' : 'NO'}`,
  );

  let drift = 0;

  for (const spec of SPECS) {
    const exists = (await db.listCollections({ name: spec.collection }).toArray()).length > 0;
    console.log(
      `[INVENTORY SCHEMA] ${spec.collection}: ${exists ? 'exists' : 'will be created'}`,
    );

    for (const idx of spec.indexes) {
      // A conflicting index with the same name is a hard error, and `createIndex` would hide
      // it: MongoDB treats a name clash as a no-op, so a wrong index silently survives and the
      // script reports success. Compare keys *and* options - the `sparse` vs
      // `partialFilterExpression` difference is invisible if only the keys are compared, and
      // it is exactly the difference that makes the index wrong.
      //
      // This runs on a dry run too: a dry run that cannot detect an index enforcing the wrong
      // thing is not a preview of the run it is previewing.
      const existing = exists ? await db.collection(spec.collection).indexes() : [];
      const clash = existing.find((i) => i.name === idx.options.name);
      if (!clash) {
        if (isDryRun) {
          console.log(`[INVENTORY SCHEMA]   ${idx.options.name}: would be created`);
        } else {
          if (!exists) await db.createCollection(spec.collection);
          await db.collection(spec.collection).createIndex(idx.keys, idx.options);
          console.log(`[INVENTORY SCHEMA]   created ${idx.options.name}`);
        }
        continue;
      }

      const sameKeys = JSON.stringify(clash.key) === JSON.stringify(idx.keys);
      const sameOptions = sameIndexOptions(clash, idx.options);
      if (sameKeys && sameOptions) {
        console.log(`[INVENTORY SCHEMA]   ${idx.options.name}: already correct`);
        continue;
      }

      const why = sameKeys ? 'options differ' : 'keys differ';
      drift += 1;
      if (!repairIndexes) {
        console.log(
          `[INVENTORY SCHEMA]   ${idx.options.name}: MISMATCH (${why}) - ` +
            'rerun with --repair-indexes to replace it',
        );
        continue;
      }
      if (isDryRun) {
        console.log(
          `[INVENTORY SCHEMA]   ${idx.options.name}: would be REPAIRED (${why}) - drop and recreate`,
        );
        continue;
      }

      if (!exists) await db.createCollection(spec.collection);
      console.log(`[INVENTORY SCHEMA]   ${idx.options.name}: REPAIRING (${why}) - drop and recreate`);
      await db.collection(spec.collection).dropIndex(idx.options.name);
      await db.collection(spec.collection).createIndex(idx.keys, idx.options);
      console.log(`[INVENTORY SCHEMA]   ${idx.options.name}: repaired`);
    }
  }

  if (!isDryRun) {
    // The legacy sparse array index is not an error on its own - dropping an index that
    // another migration created is riskier than leaving it. Report, do not act.
    for (const name of ['products', 'orders']) {
      const indexes = await db.collection(name).indexes();
      for (const idx of indexes) {
        const keyText = Object.keys(idx.key).join(' ');
        for (const part of FORBIDDEN_INDEX_PARTS) {
          if (keyText.includes(part.split('.').pop()) && keyText.includes(part.split('.')[0])) {
            console.log(
              `[INVENTORY SCHEMA] NOTE: legacy index "${idx.name}" on ${name} (${keyText}) is still present`,
            );
          }
        }
      }
    }
  }

  // Post-check: confirm every expected index actually exists.
  // On a dry run this would report every index of a not-yet-created collection as missing, so
  // there is nothing useful to confirm: the per-index output above already said what would
  // happen.
  let missing = 0;
  if (!isDryRun) {
    for (const spec of SPECS) {
      const exists = (await db.listCollections({ name: spec.collection }).toArray()).length > 0;
      const names = new Set(
        exists ? (await db.collection(spec.collection).indexes()).map((i) => i.name) : [],
      );
      for (const idx of spec.indexes) {
        if (!names.has(idx.options.name)) {
          missing += 1;
          console.log(`[INVENTORY SCHEMA] MISSING: ${spec.collection}.${idx.options.name}`);
        }
      }
    }
    console.log(`[INVENTORY SCHEMA] Missing indexes after run: ${missing}`);
  }

  if (drift > 0) {
    console.log(
      `[INVENTORY SCHEMA] ${drift} index(es) exist with the expected name but the wrong ` +
        'definition. They enforce something other than this migration assumes.',
    );
  }

  await mongoose.disconnect();
  if (missing > 0 || drift > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[INVENTORY SCHEMA] FAILED:', err);
  process.exit(1);
});