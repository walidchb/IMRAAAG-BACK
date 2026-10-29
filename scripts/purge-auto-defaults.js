/**
 * Removes the auto-seeded "Default > One Size" scaffold from products that have since grown
 * real options/values/variants, so a size/colour matrix never sits beside a phantom "One Size".
 *
 * Product creation seeds a placeholder default variant so a new product is orderable before the
 * seller touches variants. That placeholder is now purged automatically by the API the moment a
 * real option is created (`VariantsService.purgeAutoDefault`), but products created before that
 * (including every product already in the live DB) still carry the scaffold - this script cleans
 * those up.
 *
 * The scaffold is detected two ways:
 *   - explicit: `ProductOption.isDefault === true` (new writes),
 *   - legacy:    `key === 'default'` plus exactly the scaffold names (pre-flag rows).
 *
 * Only products that ALSO have at least one other (real) option are touched. A product whose
 * only option is the default keeps it - that IS the "One Size" product.
 *
 * Legacy defaults are stamped `isDefault: true` first so future `duplicateMatrix` copies keep
 * the tag and can be purged again if they ever grow real options.
 *
 * Run: npm run build && node scripts/purge-auto-defaults.js              (dry run)
 *      npm run build && node scripts/purge-auto-defaults.js --allow-execute
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');
const { NestFactory } = require('@nestjs/core');
const { VariantsService } = require('../dist/modules/inventory/services/variants.service');
const { inventoryCollectionNames } = require('./lib/inventory-collections');

const COL = inventoryCollectionNames();
const ALLOW_EXECUTE = process.argv.includes('--allow-execute');

const AUTO_DEFAULT_OR = [
  { isDefault: true },
  { key: 'default', nameEn: 'Default', nameAr: 'افتراضي', nameFr: 'Par défaut' },
];

async function main() {
  const { AppModule } = require('../dist/app.module');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const connection = app.get(require('@nestjs/mongoose').getConnectionToken());
  const db = connection.db;
  const variantsService = app.get(VariantsService);

  const options = db.collection(COL.options);
  const optionValues = db.collection(COL.optionValues);
  const variants = db.collection(COL.variants);
  const joins = db.collection(COL.joins);

  // --- find every scaffold-default option ------------------------------------
  const defaults = await options
    .find({ $or: AUTO_DEFAULT_OR })
    .project({ productId: 1, storeId: 1, isDefault: 1, key: 1, nameEn: 1 })
    .toArray();

  if (defaults.length === 0) {
    console.log(JSON.stringify({ mode: ALLOW_EXECUTE ? 'EXECUTE' : 'DRY RUN', found: 0, message: 'no auto-default options found' }, null, 2));
    await app.close();
    return;
  }

  const byProduct = new Map();
  for (const d of defaults) {
    const key = String(d.productId);
    const row = byProduct.get(key) ?? { productId: d.productId, storeId: d.storeId, defaults: [] };
    row.defaults.push({ optionId: String(d._id), flagged: !!d.isDefault });
    byProduct.set(key, row);
  }

  // --- how many options does each product really have? ------------------------
  const productIds = [...byProduct.values()].map((r) => new mongoose.Types.ObjectId(r.productId));
  const counts = {};
  for (const row of await options
    .aggregate([
      { $match: { productId: { $in: productIds } } },
      { $group: { _id: '$productId', n: { $sum: 1 } } },
    ])
    .toArray()) {
    counts[String(row._id)] = row.n;
  }

  // A product keeps its default when the default is its ONLY option.
  const candidates = [...byProduct.values()]
    .filter((r) => (counts[String(r.productId)] ?? 0) > 1)
    .map((r) => ({ ...r, totalOptions: counts[String(r.productId)] }));

  // --- preview which candidates have contaminated combinations (default value id
  // --- embedded in a real variant's join rows) ---------------------------------
  const infoRows = [];
  for (const c of candidates) {
    const pid = new mongoose.Types.ObjectId(c.productId);
    const defaultOptionIds = c.defaults.map((d) => new mongoose.Types.ObjectId(d.optionId));
    const defaultValues = await optionValues
      .find({ optionId: { $in: defaultOptionIds } })
      .project({ _id: 1 })
      .toArray();
    const defaultValIds = new Set(defaultValues.map((v) => String(v._id)));
    const variantDocs = await variants
      .find({ productId: pid })
      .project({ _id: 1 })
      .toArray();
    const joinDocs = variantDocs.length
      ? await joins
          .find({ variantId: { $in: variantDocs.map((v) => v._id) } })
          .project({ variantId: 1, optionValueId: 1 })
          .toArray()
      : [];
    const byVariant = new Map();
    for (const j of joinDocs) {
      const list = byVariant.get(String(j.variantId)) ?? [];
      list.push(String(j.optionValueId));
      byVariant.set(String(j.variantId), list);
    }
    let contaminated = 0;
    for (const ids of byVariant.values()) {
      if (ids.some((id) => defaultValIds.has(id)) && ids.length > 1) contaminated++;
    }
    infoRows.push({
      productId: String(c.productId),
      totalOptions: c.totalOptions,
      defaultOptions: c.defaults.length,
      variants: variantDocs.length,
      contaminatedCombos: contaminated,
    });
  }

  if (!ALLOW_EXECUTE) {
    console.log(
      JSON.stringify(
        {
          mode: 'DRY RUN (--allow-execute to apply)',
          autoDefaultOptions: defaults.length,
          productsKeepingDefault: byProduct.size - candidates.length,
          productsToPurge: candidates.length,
          products: infoRows,
        },
        null,
        2,
      ),
    );
    await app.close();
    return;
  }

  // --- apply ------------------------------------------------------------------
  const results = [];
  for (const c of candidates) {
    const pid = String(c.productId);
    const sid = c.storeId;

    // Stamp legacy defaults so future duplications keep the flag.
    for (const d of c.defaults) {
      if (!d.flagged) {
        await options.updateOne(
          { _id: new mongoose.Types.ObjectId(d.optionId) },
          { $set: { isDefault: true } },
        );
      }
    }

    const res = await variantsService.purgeAutoDefault(pid, sid);
    results.push({ productId: pid, ...res });
  }

  console.log(
    JSON.stringify(
      {
        mode: 'EXECUTE',
        autoDefaultOptions: defaults.length,
        productsKeepingDefault: byProduct.size - candidates.length,
        productsPurged: results.filter((r) => r.purged > 0 || r.rewritten > 0 || r.deactivated > 0).length,
        results,
      },
      null,
      2,
    ),
  );

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});