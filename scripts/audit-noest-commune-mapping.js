#!/usr/bin/env node
/**
 * audit-noest-commune-mapping.js
 *
 * Read-only by default audit of `communes.noestexpress_uuid` (NOEST-COMMUNE-MAPPING-IMPLEMENTATION-PLAN.md §8.5).
 *
 * The field holds the Noest commune **name** (`nom`), not a UUID. A populated value means the
 * commune needs no manual Noest mapping; an empty one is what the vendor UI flags. "Populated" is
 * not the same as "correct": a fuzzy sync can write a valid-but-wrong name, and Noest accepts it
 * silently, so this audit classifies every value against Noest's live list.
 *
 * Usage:
 *   node scripts/audit-noest-commune-mapping.js                 # static audit only (no credentials)
 *   node scripts/audit-noest-commune-mapping.js --live          # + cross-check against Noest
 *   node scripts/audit-noest-commune-mapping.js --live --apply  # write only EXACT per-wilaya matches
 *   node scripts/audit-noest-commune-mapping.js --clear-numeric # clear postal-code-shaped values
 *
 * `--apply` never fuzzy-matches: it only writes a live name that equals the platform commune's own
 * name (after normalisation) for the same wilaya. Anything ambiguous is reported, never guessed.
 * Exits non-zero when drift remains.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const NOEST_BASE = process.env.NOEST_LABEL_API_BASE || 'https://app.noest-dz.com';
const API_TOKEN = process.env.NOEST_API_TOKEN;

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const APPLY = args.includes('--apply');
const CLEAR_NUMERIC = args.includes('--clear-numeric');

/** Same normalisation the original sync script used, so "variant" means the same thing here. */
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/-/g, ' ')
    .replace(/[''`]/g, '')
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ');
}

function isNumericValue(value) {
  return /^\d{3,8}$/.test(String(value || '').trim());
}

function report(rule, detail) {
  console.log(`  ISSUE [${rule}] ${detail}`);
}

async function fetchLiveCommunes() {
  const response = await fetch(`${NOEST_BASE}/api/public/get/communes`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${API_TOKEN}`, Accept: 'application/json' },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Noest API error ${response.status}: ${text.slice(0, 300)}`);
  }
  const body = await response.json();
  const entries = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? Object.values(body)
      : [];

  const byWilaya = new Map();
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const nom = typeof raw.nom === 'string' ? raw.nom.trim() : '';
    const wilaya = String(Number(raw.wilaya_id));
    if (!nom || !/^\d{1,2}$/.test(wilaya)) continue;
    if (raw.is_active === 0 || raw.is_active === '0' || raw.is_active === false) continue;
    if (!byWilaya.has(wilaya)) byWilaya.set(wilaya, []);
    byWilaya.get(wilaya).push(nom);
  }
  return byWilaya;
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const communes = db.collection('communes');
  const orders = db.collection('orders');

  console.log('[AUDIT NOEST COMMUNE MAPPING] Connected.\n');
  console.log(`  registry field : communes.noestexpress_uuid (holds the Noest "nom", not a UUID)`);
  console.log(`  mode           : ${LIVE ? 'live cross-check' : 'static'}${APPLY ? ' + apply' : ''}`);

  const docs = await communes
    .find({}, { projection: { name: 1, post_code: 1, wilaya_code: 1, noestexpress_uuid: 1 } })
    .toArray();

  const populated = docs.filter(
    (d) => typeof d.noestexpress_uuid === 'string' && d.noestexpress_uuid.trim(),
  );
  const empty = docs.filter(
    (d) => !(typeof d.noestexpress_uuid === 'string' && d.noestexpress_uuid.trim()),
  );
  const numeric = populated.filter((d) => isNumericValue(d.noestexpress_uuid));

  console.log(`\n  communes                : ${docs.length}`);
  console.log(`  mapped                  : ${populated.length}`);
  console.log(`  empty / missing         : ${empty.length}`);
  console.log(`  numeric (postal-shaped) : ${numeric.length}  <- wrong meaning for this field`);

  for (const doc of empty) {
    console.log(`  empty   [${doc.wilaya_code}-${doc.post_code}] ${doc.name}`);
  }

  let exact = 0;
  let variant = 0;
  let notInNoest = 0;
  let suspect = 0;
  let fixable = 0;
  let cleared = 0;
  const updates = [];

  if (CLEAR_NUMERIC && numeric.length > 0) {
    const ids = numeric.map((d) => d._id);
    if (APPLY) {
      const res = await communes.updateMany({ _id: { $in: ids } }, { $unset: { noestexpress_uuid: '' } });
      cleared = res.modifiedCount;
      console.log(`\n  cleared ${cleared} numeric value(s)`);
    } else {
      console.log(`\n  would clear ${ids.length} numeric value(s) (add --apply to write)`);
    }
  }

  if (LIVE) {
    if (!API_TOKEN) {
      console.error('\nNOEST_API_TOKEN is required for --live');
      await mongoose.disconnect();
      process.exit(1);
    }

    const live = await fetchLiveCommunes();
    const liveByName = new Map();
    for (const [wilaya, names] of live) {
      for (const name of names) liveByName.set(`${wilaya}|${normalizeName(name)}`, name);
    }

    // A value is "claimed" when the platform commune sitting at that name in the same wilaya
    // carries a *different* mapping — the signature of a fuzzy mis-match.
    const claimedBy = new Map();
    for (const doc of populated) {
      const wilaya = String(Number(doc.wilaya_code));
      claimedBy.set(`${wilaya}|${normalizeName(doc.name)}`, doc.noestexpress_uuid.trim());
    }

    for (const doc of populated) {
      const value = doc.noestexpress_uuid.trim();
      const wilaya = String(Number(doc.wilaya_code));
      const liveNames = live.get(wilaya) || [];
      const exactName = liveNames.find((n) => n.toLowerCase() === value.toLowerCase());
      const variantName = exactName
        ? null
        : liveNames.find((n) => normalizeName(n) === normalizeName(value));

      if (exactName) {
        exact += 1;
        const claimed = claimedBy.get(`${wilaya}|${normalizeName(exactName)}`);
        if (claimed && claimed.toLowerCase() !== exactName.toLowerCase()) {
          suspect += 1;
          report(
            'suspect',
            `${wilaya}-${doc.post_code} ${doc.name} -> "${value}" also names another commune in this wilaya`,
          );
        }
        continue;
      }

      if (variantName) {
        variant += 1;
        continue;
      }

      notInNoest += 1;
      report('not-in-noest', `${wilaya}-${doc.post_code} ${doc.name} -> "${value}" is not a Noest commune for wilaya ${wilaya}`);

      // Only an exact (normalised) match to the commune's OWN name is auto-fixable.
      const ownExact = liveNames.find((n) => n.toLowerCase() === doc.name.trim().toLowerCase());
      const ownNormalized = liveNames.find((n) => normalizeName(n) === normalizeName(doc.name));
      const replacement = ownExact || ownNormalized;
      if (replacement) {
        fixable += 1;
        updates.push({ id: doc._id, label: `${wilaya}-${doc.post_code} ${doc.name}`, replacement });
      }
    }

    console.log(`\n  live values: exact ${exact} · variant ${variant} · not in Noest ${notInNoest}`);
    console.log(`  fuzzy-suspect (value names another commune): ${suspect}`);
    console.log(`  exact auto-fixable: ${fixable}`);

    if (updates.length > 0) {
      if (APPLY) {
        let written = 0;
        for (const u of updates) {
          const res = await communes.updateOne(
            { _id: u.id },
            { $set: { noestexpress_uuid: u.replacement } },
          );
          written += res.modifiedCount;
        }
        console.log(`  applied ${written} exact correction(s)`);
      } else {
        for (const u of updates) {
          console.log(`  fixable ${u.label} -> "${u.replacement}"`);
        }
        console.log('  (add --apply to write these exact matches)');
      }
    }
  }

  const noestOrders = await orders.countDocuments({ deliveryCompanyId: 'noest', isDeleted: { $ne: true } });
  const mappedOrders = await orders.countDocuments({
    deliveryCompanyId: 'noest',
    isDeleted: { $ne: true },
    noestCommune: { $type: 'object' },
  });
  console.log(`\n  active Noest orders: ${noestOrders} (with an explicit mapping: ${mappedOrders})`);
  console.log(`  flag: ${process.env.NOEST_COMMUNE_MAPPING_ENABLED === 'true' ? 'ON' : 'off'}`);

  // What is still wrong after this run: a live mismatch that could not be fixed exactly, plus any
  // postal-code-shaped value that was not cleared.
  const remainingWrong = APPLY ? Math.max(0, notInNoest - fixable) : notInNoest;
  const remainingNumeric = CLEAR_NUMERIC && APPLY ? 0 : numeric.length;
  const unresolved = remainingWrong + remainingNumeric;

  console.log(
    `\n[AUDIT NOEST COMMUNE MAPPING] ${unresolved > 0 ? `${unresolved} unresolved finding(s)` : 'OK'}`,
  );
  await mongoose.disconnect();
  process.exit(unresolved > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[AUDIT NOEST COMMUNE MAPPING] FAILED', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
