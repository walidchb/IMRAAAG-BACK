#!/usr/bin/env node
/**
 * verify-dhd-commune-mapping.js
 *
 * Read-only integrity check for the DHD commune mapping (DHD-COMMUNE-MAPPING-IMPLEMENTATION-PLAN.md §9.5).
 * Never writes. Exits non-zero on any violation.
 *
 * Run: node scripts/verify-dhd-commune-mapping.js [--verbose]
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

  console.log('[VERIFY DHD COMMUNE MAPPING] Connected. Read-only.\n');
  console.log(`  feature flag: ${process.env.DHD_COMMUNE_MAPPING_ENABLED === 'true' ? 'ON' : 'off'}\n`);

  const selected = await orders
    .find(
      { dhdCommune: { $type: 'object' } },
      {
        projection: {
          orderNo: 1,
          storeId: 1,
          deliveryCompanyId: 1,
          shippingMethod: 1,
          'customer.wilaya': 1,
          dhdCommune: 1,
        },
      },
    )
    .toArray();

  console.log(`  orders with a DHD mapping:   ${selected.length}`);

  let malformed = 0;
  let wilayaMismatch = 0;
  let stopDeskUnsupported = 0;

  for (const order of selected) {
    const sel = order.dhdCommune;
    const label = order.orderNo || String(order._id);

    if (!isPlainObject(sel)) {
      malformed += 1;
      report('shape', `${label}: dhdCommune is not an object`);
      continue;
    }
    if (typeof sel.name !== 'string' || !sel.name.trim()) {
      malformed += 1;
      report('name', `${label}: dhdCommune.name is missing or blank`);
    }
    const wilayaId = Number(sel.wilayaId);
    if (!Number.isInteger(wilayaId) || wilayaId < 1 || wilayaId > 58) {
      malformed += 1;
      report('wilaya-id', `${label}: dhdCommune.wilayaId "${sel.wilayaId}" is not a wilaya code 1-58`);
    }
    if (sel.postalCode !== null && sel.postalCode !== undefined && typeof sel.postalCode !== 'string') {
      malformed += 1;
      report('postal-code', `${label}: dhdCommune.postalCode must be a string or null`);
    }
    if (sel.hasStopDesk !== undefined && typeof sel.hasStopDesk !== 'boolean') {
      malformed += 1;
      report('stop-desk', `${label}: dhdCommune.hasStopDesk must be boolean`);
    }
    if (sel.selectedAt !== null && sel.selectedAt !== undefined && Number.isNaN(new Date(sel.selectedAt).getTime())) {
      malformed += 1;
      report('selected-at', `${label}: dhdCommune.selectedAt is not a valid date`);
    }
    if (sel.selectedBy !== null && sel.selectedBy !== undefined && typeof sel.selectedBy !== 'string') {
      malformed += 1;
      report('selected-by', `${label}: dhdCommune.selectedBy must be a string or null`);
    }

    const orderWilaya = Number(order.customer?.wilaya);
    if (Number.isFinite(orderWilaya) && Number.isInteger(wilayaId) && wilayaId !== orderWilaya) {
      wilayaMismatch += 1;
      report(
        'wilaya-match',
        `${label}: mapping wilaya ${wilayaId} does not match customer wilaya ${orderWilaya}`,
      );
    }

    if (order.shippingMethod === 'stopdesk' && sel.hasStopDesk !== true) {
      stopDeskUnsupported += 1;
      report('stop-desk-support', `${label}: stop-desk order mapped to a commune without stop-desk support`);
    }

    if (VERBOSE) {
      console.log(
        `        ${label} -> "${sel.name}" (wilaya ${sel.wilayaId}${sel.postalCode ? `, ${sel.postalCode}` : ''})`,
      );
    }
  }

  if (malformed === 0) ok('shape', `all ${selected.length} mappings have a valid shape`);
  if (wilayaMismatch === 0) ok('wilaya-match', 'every mapping matches its order wilaya');
  if (stopDeskUnsupported === 0) ok('stop-desk-support', 'every stop-desk mapping supports stop desk');

  const dhdUnmapped = await orders.countDocuments({
    deliveryCompanyId: 'dhd',
    isDeleted: { $ne: true },
    $or: [{ dhdCommune: null }, { dhdCommune: { $exists: false } }],
  });
  console.log(`\n  active DHD orders without a mapping: ${dhdUnmapped}`);
  console.log(
    dhdUnmapped === 0
      ? '  ok    [coverage] every active DHD order has a commune mapping'
      : '  note  [coverage] these orders cannot dispatch while the feature flag is ON',
  );

  const otherCarriers = await orders.countDocuments({
    dhdCommune: { $type: 'object' },
    deliveryCompanyId: { $nin: ['dhd', null] },
  });
  console.log(`  mappings on non-DHD carriers (inert): ${otherCarriers}`);

  console.log(`\n[VERIFY DHD COMMUNE MAPPING] ${violations.length === 0 ? 'OK' : `${violations.length} violation(s)`}`);
  await mongoose.disconnect();
  process.exit(violations.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('[VERIFY DHD COMMUNE MAPPING] FAILED', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
