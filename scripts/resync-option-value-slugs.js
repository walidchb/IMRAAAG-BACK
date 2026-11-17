/**
 * Re-derives the canonical `value` slug of every product option value from its labels.
 *
 * Background: `PATCH /products/:productId/options/:optionId/values/:valueId` used to rewrite
 * only `valueEn/valueAr/valueFr`, leaving the old machine slug in place. Because the
 * `{optionId, value}` index is unique, a value renamed "Red" -> "Purple" kept `value: 'red'`
 * forever, so the seller could never create a new "Red". The service now re-keys the slug when
 * the English label changes; this script repairs rows that were renamed before that fix.
 *
 * Read-only by default. Usage:
 *   node scripts/resync-option-value-slugs.js            # report drift, write nothing
 *   node scripts/resync-option-value-slugs.js --apply    # rewrite the drifted slugs
 *
 * It never touches the auto-seeded "Default / One Size" scaffold (that identity is `default`
 * by design) and it refuses to re-key a value onto a slug another value of the same option
 * already holds - those are real conflicts for a human to resolve and are reported, not guessed.
 */
const { connect, connection } = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/imraaah';
const APPLY = process.argv.includes('--apply');

// Same rule as VariantsService.slug(): lowercase, [a-z0-9_] only, trimmed of separators.
function slug(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function desiredSlug(doc) {
  return (
    slug(doc.valueEn) ||
    slug(doc.valueFr) ||
    slug(doc.valueAr) ||
    ''
  );
}

async function run() {
  await connect(MONGO_URI);
  const db = connection.db;
  const values = db.collection('productoptionvalues');

  const totals = {
    scanned: 0,
    scaffold: 0,
    noLabels: 0,
    consistent: 0,
    drift: 0,
    renamed: 0,
    collisions: 0,
  };
  const drift = [];
  const collisions = [];

  const cursor = values.find({});
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    totals.scanned++;

    if (doc.value === 'default' && doc.valueEn === 'One Size') {
      totals.scaffold++;
      continue;
    }

    const desired = desiredSlug(doc);
    if (!desired) {
      totals.noLabels++;
      continue;
    }

    if (desired === doc.value) {
      totals.consistent++;
      continue;
    }

    // The slug is unique per option; a rename may not steal a sibling's identity.
    const clash = await values.findOne({
      _id: { $ne: doc._id },
      optionId: doc.optionId,
      value: desired,
    });
    if (clash) {
      totals.collisions++;
      if (collisions.length < 20) {
        collisions.push({
          valueId: String(doc._id),
          optionId: String(doc.optionId),
          current: doc.value,
          desired,
          labels: { en: doc.valueEn ?? null, fr: doc.valueFr ?? null, ar: doc.valueAr ?? null },
          heldBy: String(clash._id),
        });
      }
      continue;
    }

    totals.drift++;
    if (drift.length < 20) {
      drift.push({
        valueId: String(doc._id),
        productId: String(doc.productId),
        optionId: String(doc.optionId),
        current: doc.value,
        desired,
        labels: { en: doc.valueEn ?? null, fr: doc.valueFr ?? null, ar: doc.valueAr ?? null },
      });
    }

    if (APPLY) {
      await values.updateOne({ _id: doc._id }, { $set: { value: desired } });
      totals.renamed++;
    }
  }

  console.log(`[resync-option-value-slugs] mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(
    `scanned=${totals.scanned} consistent=${totals.consistent} drift=${totals.drift} ` +
      `renamed=${totals.renamed} collisions=${totals.collisions} scaffold=${totals.scaffold} noLabels=${totals.noLabels}`,
  );

  if (drift.length) {
    console.log(`\n${APPLY ? 'Renamed' : 'Would rename'} (first ${drift.length}):`);
    for (const row of drift) {
      console.log(
        `  ${row.current} -> ${row.desired}  (option ${row.optionId}, labels en=${JSON.stringify(row.labels.en)} fr=${JSON.stringify(row.labels.fr)} ar=${JSON.stringify(row.labels.ar)})`,
      );
    }
  }
  if (collisions.length) {
    console.log(`\nSkipped conflicts (first ${collisions.length}) - resolve manually:`);
    for (const row of collisions) {
      console.log(
        `  ${row.current} -> ${row.desired} is already held by ${row.heldBy} (option ${row.optionId})`,
      );
    }
  }
  if (!APPLY && totals.drift > 0) {
    console.log('\nRe-run with --apply to write these renames.');
  }

  await connection.close();
  process.exit(0);
}

run().catch(async (err) => {
  console.error('[resync-option-value-slugs] failed:', err);
  try {
    await connection.close();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
