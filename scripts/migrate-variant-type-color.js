/*
 * Variant-type/colour migration.
 *
 * Product options previously carried a presentation `displayType` (`buttons|dropdown|swatch|list`)
 * and option values carried a `swatch` hex plus a dead `image` slot. Both are now canonicalised:
 *
 *   - `ProductOption.displayType` → `type: 'text' | 'color'`
 *       `swatch` maps to `color`, everything else maps to `text`; missing → `text`.
 *   - `ProductOptionValue.swatch` → `color` (display-only hex). The real value of an
 *       option is its multilingual text name.
 *   - `ProductOptionValue.image` is not renamed — it was never consumed anywhere.
 *
 * Reads tolerate pre-migration documents (`type ?? displayType-swatch`, `color ?? swatch`),
 * so this script is a data-hygiene pass, not a compatibility gate.
 *
 * Idempotent and dry by default: `node scripts/migrate-variant-type-color.js --allow-execute`.
 * Collection names resolve through `scripts/lib/inventory-collections.js`, so run `npm run build`
 * first (it reads the compiled schemas).
 */
const { MongoClient } = require('mongodb');
const { inventoryCollectionNames } = require('./lib/inventory-collections');

const EXECUTE = process.argv.includes('--allow-execute');

function readUri() {
  const fs = require('fs');
  const path = require('path');
  const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  const matcher = env.match(/MONGO_URI=(.*)/) || env.match(/MONGODB_URI=(.*)/) || env.match(/DATABASE_URL=(.*)/);
  if (!matcher) {
    console.error('No MONGO_URI in .env');
    process.exit(1);
  }
  return matcher[1].trim().replace(/^['"]|['"]$/g, '');
}

(async () => {
  const client = await MongoClient.connect(readUri());
  const db = client.db();

  const C = inventoryCollectionNames();
  const OPT = db.collection(C.options);
  const VAL = db.collection(C.optionValues);

  const stats = { mode: EXECUTE ? 'EXECUTE' : 'DRY RUN (--allow-execute to apply)' };

  // --- options: displayType -> type --------------------------------------------
  // Only docs that do not already carry a canonical `type`. A doc whose displayType is already
  // absent and which has no type is defaulted to 'text' too, so nothing is left undefined.
  const optionFilter = {
    $and: [
      { type: { $exists: false } },
      { $or: [{ displayType: { $exists: true } }, { displayType: { $exists: false } }] },
    ],
  };
  const optionsWithDisplayType = await OPT.countDocuments({ displayType: { $exists: true }, type: { $exists: false } });
  const optionsMissingBoth = await OPT.countDocuments({ displayType: { $exists: false }, type: { $exists: false } });
  const optionMatch = await OPT
    .find(optionFilter, { projection: { _id: 1, displayType: 1 } })
    .toArray();

  stats.options = {
    withDisplayType: optionsWithDisplayType,
    missingBothDefaultToText: optionsMissingBoth,
    willUpdate: optionMatch.length,
    sampledMappings: optionMatch.slice(0, 5).map((o) => ({
      _id: String(o._id),
      displayType: o.displayType ?? null,
      mapsTo: o.displayType === 'swatch' ? 'color' : 'text',
    })),
  };

  if (EXECUTE && optionMatch.length > 0) {
    const r = await OPT.updateMany(optionFilter, [
      {
        $set: {
          type: { $cond: [{ $eq: ['$displayType', 'swatch'] }, 'color', 'text'] },
        },
      },
      { $unset: 'displayType' },
    ]);
    stats.options.applied = { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  // --- values: swatch -> color --------------------------------------------------
  const valueFilter = { swatch: { $exists: true }, color: { $exists: false } };
  const valuesWithSwatch = await VAL.countDocuments(valueFilter);
  const valueMatch = await VAL
    .find(valueFilter, { projection: { _id: 1, swatch: 1 } })
    .toArray();

  stats.values = {
    withSwatch: valuesWithSwatch,
    willRename: valueMatch.length,
    sampled: valueMatch.slice(0, 5).map((v) => ({ _id: String(v._id), swatch: v.swatch })),
  };

  if (EXECUTE && valueMatch.length > 0) {
    const r = await VAL.updateMany(valueFilter, { $rename: { swatch: 'color' } });
    stats.values.applied = { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  await client.close();
  console.log(JSON.stringify(stats, null, 2));
})().catch((e) => {
  console.error('ERR', e.stack || e.message);
  process.exit(1);
});