#!/usr/bin/env node
/**
 * verify-noest-commune-mapping.js
 *
 * Read-only integrity check for the Noest commune mapping (NOEST-COMMUNE-MAPPING-IMPLEMENTATION-PLAN.md §8.5).
 * Never writes. Exits non-zero on any violation.
 *
 * Mirrors `verify-dhd-commune-mapping.js`, minus the stop-desk rule: Noest publishes no per-commune
 * stop-desk capability, so a mapping has no `hasStopDesk` to check — and none must be written.
 *
 * Run: node scripts/verify-noest-commune-mapping.js [--verbose]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const VERBOSE = process.argv.includes('--verbose');
const violations = [];

function report(rule, detail) {
  violations.push({ rule, detail });
  console.log(`  FAIL  [${rule}] ${detail}`);
}
function ok(rule, message) {
  console.log(`  ok    [${rule}] ${message}`);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const orders = db.collection('orders');
  const communes = db.collection('communes');

  console.log('[VERIFY NOEST COMMUNE MAPPING] Connected. Read-only.\n');
  console.log(`  feature flag: ${process.env.NOEST_COMMUNE_MAPPING_ENABLED === 'true' ? 'ON' : 'off'}\n`);

  const selected = await orders
    .find(
      { noestCommune: { $type: 'object' } },
      {
        projection: {
          orderNo: 1,
          storeId: 1,
          deliveryCompanyId: 1,
          shippingMethod: 1,
          'customer.wilaya': 1,
          'customer.commune': 1,
          noestCommune: 1,
        },
      },
    )
    .toArray();

  console.log(`  orders with a Noest mapping: ${selected.length}`);

  let malformed = 0;
  let wilayaMismatch = 0;
  let stopDeskField = 0;
  let unknownName = 0;
  const credentialPatterns = [/api[_-]?token/i, /bearer\s/i, /user[_-]?guid/i, /secret/i, /password/i];

  for (const order of selected) {
    const sel = order.noestCommune;
    const label = order.orderNo || String(order._id);

    if (!isPlainObject(sel)) {
      malformed += 1;
      report('shape', `${label}: noestCommune is not an object`);
      continue;
    }
    if (typeof sel.name !== 'string' || !sel.name.trim()) {
      malformed += 1;
      report('name', `${label}: noestCommune.name is missing or blank`);
    }
    const wilayaId = Number(sel.wilayaId);
    if (!Number.isInteger(wilayaId) || wilayaId < 1 || wilayaId > 58) {
      malformed += 1;
      report('wilaya-id', `${label}: noestCommune.wilayaId "${sel.wilayaId}" is not a wilaya code 1-58`);
    }
    if (sel.postalCode !== null && sel.postalCode !== undefined && typeof sel.postalCode !== 'string') {
      malformed += 1;
      report('postal-code', `${label}: noestCommune.postalCode must be a string or null`);
    }
    if (sel.hasStopDesk !== undefined) {
      stopDeskField += 1;
      report('stop-desk', `${label}: Noest publishes no stop-desk flag, but hasStopDesk was written`);
    }
    if (sel.selectedAt !== null && sel.selectedAt !== undefined && Number.isNaN(new Date(sel.selectedAt).getTime())) {
      malformed += 1;
      report('selected-at', `${label}: noestCommune.selectedAt is not a valid date`);
    }
    if (sel.selectedBy !== null && sel.selectedBy !== undefined && typeof sel.selectedBy !== 'string') {
      malformed += 1;
      report('selected-by', `${label}: noestCommune.selectedBy must be a string or null`);
    }

    for (const [key, value] of Object.entries(sel)) {
      if (typeof value === 'string' && credentialPatterns.some((re) => re.test(value))) {
        report('credentials', `${label}: noestCommune.${key} looks like credential material`);
      }
    }

    const orderWilaya = Number(order.customer?.wilaya);
    if (Number.isFinite(orderWilaya) && Number.isInteger(wilayaId) && wilayaId !== orderWilaya) {
      wilayaMismatch += 1;
      report('wilaya-match', `${label}: mapping wilaya ${wilayaId} does not match customer wilaya ${orderWilaya}`);
    }

    // The selected name should be a Noest name this wilaya knows about. The platform registry is
    // the offline oracle; a name it has never seen is reported for review, not silently accepted.
    if (typeof sel.name === 'string' && sel.name.trim()) {
      const known = await communes.findOne(
        {
          wilaya_code: String(wilayaId),
          $or: [{ noestexpress_uuid: sel.name }, { name: sel.name }],
        },
        { projection: { _id: 1 } },
      );
      if (!known) {
        unknownName += 1;
        report(
          'name-known',
          `${label}: "${sel.name}" is not a noestexpress_uuid (or commune name) registered for wilaya ${wilayaId}`,
        );
      }
    }

    if (VERBOSE) {
      console.log(
        `        ${label} -> "${sel.name}" (wilaya ${sel.wilayaId}${sel.postalCode ? `, ${sel.postalCode}` : ''})`,
      );
    }
  }

  if (malformed === 0) ok('shape', `all ${selected.length} mappings have a valid shape`);
  if (wilayaMismatch === 0) ok('wilaya-match', 'every mapping matches its order wilaya');
  if (stopDeskField === 0) ok('stop-desk', 'no mapping carries a fabricated hasStopDesk flag');
  if (unknownName === 0) ok('name-known', 'every selected name is registered for its wilaya');

  const noestUnmapped = await orders.countDocuments({
    deliveryCompanyId: 'noest',
    isDeleted: { $ne: true },
    $or: [{ noestCommune: null }, { noestCommune: { $exists: false } }],
  });
  console.log(`\n  active Noest orders without a mapping: ${noestUnmapped}`);
  console.log(
    noestUnmapped === 0
      ? '  ok    [coverage] every active Noest order has a commune mapping'
      : '  note  [coverage] these orders cannot dispatch while the feature flag is ON unless their\n' +
          '        platform commune carries a communes.noestexpress_uuid',
  );

  const otherCarriers = await orders.countDocuments({
    noestCommune: { $type: 'object' },
    deliveryCompanyId: { $nin: ['noest', null] },
  });
  console.log(`  mappings on non-Noest carriers (inert): ${otherCarriers}`);

  const registryEmpty = await communes.countDocuments({
    $or: [{ noestexpress_uuid: null }, { noestexpress_uuid: '' }, { noestexpress_uuid: { $exists: false } }],
  });
  const registryTotal = await communes.countDocuments({});
  console.log(`  registry: ${registryTotal - registryEmpty}/${registryTotal} communes mapped to Noest`);

  console.log(`\n[VERIFY NOEST COMMUNE MAPPING] ${violations.length === 0 ? 'OK' : `${violations.length} violation(s)`}`);
  await mongoose.disconnect();
  process.exit(violations.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('[VERIFY NOEST COMMUNE MAPPING] FAILED', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
