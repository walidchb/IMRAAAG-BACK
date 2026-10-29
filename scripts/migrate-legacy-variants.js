/**
 * Data-integrity guard for the retired embedded `Product.variants` array.
 *
 * ## Why the conversion is gone
 *
 * This script used to convert the retired embedded `Product.variants` array (a list of *option
 * groups*, never sellable variants) into the matrix model via `VariantsService.toggleVariants`.
 * Both are gone now:
 *
 *   - `Product.variants`, `Product.stock` and `hasVariants` were removed from the schema. Every
 *     product is a variant product (universal variants), so there is no "simple" form to convert
 *     to. A product's only stock is its `InventoryBalance` rows.
 *   - `toggleVariants` was deleted along with the flip concept.
 *
 * The one-time data move already ran (93 seeded products converted to a default variant; legacy
 * fields unset on all 94 that carried them). Nothing remains to migrate, and re-implementing the
 * conversion would recreate the dual-source state this refactor exists to eliminate.
 *
 * ## What it does now
 *
 * It scans the `products` collection for any document that still carries legacy stock data — a
 * non-empty embedded `variants` array, a `stock` field, or a `hasVariants` field — and fails with
 * a report if any are found. A raw driver write, a re-seeded database, or a stale restore could
 * reintroduce them; the guard makes that visible instead of letting the removed fields silently
 * drift out of sync with the balances.
 *
 * ## Safety
 *
 * Read-only. Reports each offending product, never writes. Exits 0 only when every product is
 * clean.
 *
 * Run: `npm run build && node scripts/migrate-legacy-variants.js`
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const { NestFactory } = require('@nestjs/core');

let app;
let db;

async function main() {
  const { AppModule } = require('../dist/app.module');
  app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  db = app.get(require('@nestjs/mongoose').getConnectionToken()).db;

  console.log('\n[MIGRATE LEGACY VARIANTS] (now a data-integrity guard)');
  console.log('  scanning for documents still carrying removed legacy stock fields');

  const offenders = await db
    .collection('products')
    .find({
      $or: [
        { variants: { $type: 'array', $ne: [] } },
        { stock: { $type: ['number', 'string'] } },
        { hasVariants: { $exists: true } },
      ],
    })
    .project({ _id: 1, nameEn: 1, variants: 1, stock: 1, hasVariants: 1 })
    .toArray();

  if (offenders.length === 0) {
    console.log('\n  clean: no product carries a legacy `variants` array, `stock` or `hasVariants`.');
    console.log('  The Phase 0 migration is fully applied and no legacy stock data has returned.');
    return;
  }

  console.log(`\n  ${offenders.length} product(s) still carry removed legacy stock data:`);
  for (const p of offenders) {
    const flags = [];
    if (Array.isArray(p.variants) && p.variants.length > 0) flags.push('non-empty variants array');
    if (p.stock !== undefined) flags.push(`stock=` + JSON.stringify(p.stock));
    if (p.hasVariants !== undefined) flags.push(`hasVariants=${p.hasVariants}`);
    console.log(`    - ${String(p._id)} ${p.nameEn ?? ''}: ${flags.join(', ')}`);
  }
  console.log('\n  These fields no longer exist on the schema; inspect the offending documents and');
  console.log('  move any real quantity into `InventoryBalance` rows before retrying.');
  process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (app) await app.close();
  });