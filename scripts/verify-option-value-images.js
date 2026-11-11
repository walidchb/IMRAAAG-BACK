require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');
const { inventoryCollectionNames } = require('./lib/inventory-collections');

/**
 * Product image ↔ option value association — read-only verifier.
 *
 * Checks every linked option value against the product it belongs to:
 *   - the image is a non-empty, trimmed string;
 *   - the product still exists, and the link crosses no store boundary;
 *   - the owning option exists on the same product/store;
 *   - the image is still one of the product's gallery URLs;
 *   - no two values on a product share the same image.
 *
 * Values whose product is gone are reported and skipped (deleted products leave deactivated
 * values behind by design). `--clear-orphans --yes` clears only those product-gone links.
 *
 * Requires `npm run build` first (collection names resolve from the compiled schemas).
 *
 * Run: node scripts/verify-option-value-images.js [--store <id>] [--json]
 *      node scripts/verify-option-value-images.js [--clear-orphans --yes]
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const argv = process.argv.slice(2);
const JSON_OUTPUT = argv.includes('--json');
const CLEAR_ORPHANS = argv.includes('--clear-orphans');
const CONFIRMED = argv.includes('--yes');
const storeIndex = argv.indexOf('--store');
const STORE_ARG = storeIndex >= 0 ? argv[storeIndex + 1] : null;

const violations = [];

function report(rule, detail) {
  violations.push({ rule, detail });
  if (!JSON_OUTPUT) console.log(`  FAIL  [${rule}] ${detail}`);
}
function ok(rule, msg) {
  if (!JSON_OUTPUT) console.log(`  ok    [${rule}] ${msg}`);
}

function galleryOf(product) {
  return new Set(
    [product.image, ...(product.images || [])]
      .map((url) => (typeof url === 'string' ? url.trim() : ''))
      .filter(Boolean),
  );
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const { options, optionValues } = inventoryCollectionNames();
  const valueCollection = db.collection(optionValues);
  const optionCollection = db.collection(options);
  const productCollection = db.collection('products');

  let storeFilter = null;
  if (STORE_ARG) {
    if (!mongoose.Types.ObjectId.isValid(STORE_ARG)) {
      console.error(`--store ${STORE_ARG} is not a valid ObjectId`);
      process.exit(1);
    }
    storeFilter = new mongoose.Types.ObjectId(STORE_ARG);
  }

  if (!JSON_OUTPUT) {
    console.log(
      `[VERIFY OPTION VALUE IMAGES] Connected. Read-only${storeFilter ? ` (store ${STORE_ARG})` : ''}.\n`,
    );
  }

  const valueFilter = { image: { $type: 'string' } };
  if (storeFilter) valueFilter.storeId = storeFilter;
  const linkedValues = await valueCollection
    .find(valueFilter, {
      projection: { _id: 1, storeId: 1, productId: 1, optionId: 1, value: 1, image: 1, isActive: 1 },
    })
    .toArray();

  const productIds = [...new Set(linkedValues.map((v) => String(v.productId)))];
  const products = await productCollection
    .find({ _id: { $in: productIds.map((id) => new mongoose.Types.ObjectId(id)) } }, {
      projection: { _id: 1, storeId: 1, image: 1, images: 1 },
    })
    .toArray();
  const productById = new Map(products.map((p) => [String(p._id), p]));

  const optionIds = [...new Set(linkedValues.map((v) => String(v.optionId)))];
  const optionRows = await optionCollection
    .find({ _id: { $in: optionIds.map((id) => new mongoose.Types.ObjectId(id)) } }, {
      projection: { _id: 1, storeId: 1, productId: 1 },
    })
    .toArray();
  const optionById = new Map(optionRows.map((o) => [String(o._id), o]));

  if (!JSON_OUTPUT) {
    console.log(`  linked option values: ${linkedValues.length}`);
    console.log(`  products referenced:  ${products.length}\n`);
  }

  const orphanIds = [];
  const seenImages = new Map();

  for (const value of linkedValues) {
    const label = `value ${value._id} (product ${value.productId}, option ${value.optionId})`;
    const product = productById.get(String(value.productId));

    if (!product) {
      orphanIds.push(value._id);
      report('product-exists', `${label} points at a product that no longer exists`);
      continue;
    }

    if (String(value.storeId) !== String(product.storeId)) {
      report('store-match', `${label} belongs to store ${value.storeId} but its product is ${product.storeId}`);
    }

    const option = optionById.get(String(value.optionId));
    if (!option) {
      report('option-exists', `${label} points at an option that no longer exists`);
    } else {
      if (String(option.productId) !== String(value.productId)) {
        report('option-product', `${label} option belongs to product ${option.productId}`);
      }
      if (String(option.storeId) !== String(value.storeId)) {
        report('option-store', `${label} option belongs to store ${option.storeId}`);
      }
    }

    if (typeof value.image !== 'string' || value.image.trim() !== value.image || !value.image.trim()) {
      report('image-normalised', `${label} image is empty or untrimmed: "${value.image}"`);
    } else if (!galleryOf(product).has(value.image)) {
      report('image-in-gallery', `${label} image "${value.image}" is not in its product gallery`);
    }

    const uniquenessKey = `${value.productId}::${value.image}`;
    const previous = seenImages.get(uniquenessKey);
    if (previous) {
      report(
        'image-unique',
        `product ${value.productId} links image "${value.image}" to both ${previous} and ${value._id}`,
      );
    } else {
      seenImages.set(uniquenessKey, String(value._id));
    }
  }

  if (violations.length === 0) {
    ok('all-rules', `${linkedValues.length} linked value(s) are valid`);
  }

  if (orphanIds.length > 0) {
    if (CLEAR_ORPHANS && CONFIRMED) {
      const result = await valueCollection.updateMany(
        { _id: { $in: orphanIds } },
        { $set: { image: null } },
      );
      console.log(`  cleared ${result.modifiedCount} orphan product link(s)`);
    } else if (!JSON_OUTPUT) {
      console.log(
        `\n  ${orphanIds.length} orphan link(s). Re-run with --clear-orphans --yes to clear them.`,
      );
    }
  }

  const summary = {
    storeId: STORE_ARG ?? null,
    linkedValues: linkedValues.length,
    products: products.length,
    orphanLinks: orphanIds.length,
    violations,
    ok: violations.length === 0,
  };

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `\n[VERIFY OPTION VALUE IMAGES] ${violations.length === 0 ? 'OK' : `FAILED (${violations.length} violation(s))`}`,
    );
  }

  await mongoose.disconnect();
  if (violations.length > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error('[VERIFY OPTION VALUE IMAGES] FAILED');
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
