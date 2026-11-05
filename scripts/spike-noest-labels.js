#!/usr/bin/env node
/*
 * Noest delivery-label spike (READ-ONLY).
 *
 * The offline pass validates the frozen contract and the query encoding. The live pass resolves a
 * real store's Noest credentials, downloads one label and prints sanitized metadata only: status,
 * content type, byte size, PDF magic bytes, page count and page box, hash prefix and elapsed time.
 *
 * It never writes to MongoDB, never prints a credential, and never writes the PDF unless
 * --save=<path> is passed explicitly.
 *
 * Usage:
 *   node scripts/spike-noest-labels.js --offline
 *   node scripts/spike-noest-labels.js --live [--store=<storeId>] [--order=<orderId|orderNo>]
 *                                       [--parcel=<tracking>] [--save=<path>]
 */

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const BASE_URL = (process.env.NOEST_LABEL_API_BASE || 'https://app.noest-dz.com').replace(/\/+$/, '');
const LABEL_PATH = '/api/public/get/order/label';
const TIMEOUT_MS = 30000;
const MAX_BYTES = 10 * 1024 * 1024;

const OFFLINE = process.argv.includes('--offline') || !process.argv.includes('--live');
const LIVE = process.argv.includes('--live');

const args = Object.fromEntries(
  process.argv
    .filter((value) => value.startsWith('--') && value.includes('='))
    .map((value) => {
      const [key, ...rest] = value.slice(2).split('=');
      return [key, rest.join('=')];
    }),
);

const problems = [];
const notes = [];

function ok(label) {
  console.log(`  ok    ${label}`);
}

function fail(message) {
  problems.push(message);
  console.log(`  FAIL  ${message}`);
}

function note(message) {
  notes.push(message);
  console.log(`  note  ${message}`);
}

function header(title) {
  console.log(`\n=== ${title} ===`);
}

function labelUrl(tracking) {
  const params = new URLSearchParams({ tracking });
  return `${BASE_URL}${LABEL_PATH}?${params.toString()}`;
}

function mm(pt) {
  return (pt / (72 / 25.4)).toFixed(1);
}

function hashPrefix(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

function isPdf(bytes) {
  return bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-';
}

async function inspectPdf(bytes) {
  const { PDFDocument } = require('pdf-lib');
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = pdf.getPages();
  if (pages.length === 0) return null;
  const first = pages[0];
  return {
    pageCount: pages.length,
    widthPt: first.getWidth(),
    heightPt: first.getHeight(),
    widthMm: mm(first.getWidth()),
    heightMm: mm(first.getHeight()),
  };
}

/* ------------------------------------------------------------------ *
 * Offline contract checks
 * ------------------------------------------------------------------ */

function runOffline() {
  header('1. Frozen contract');
  console.log(`  base      ${BASE_URL}`);
  console.log(`  endpoint  GET ${LABEL_PATH}`);
  console.log(`  auth      Authorization: Bearer <api_token>`);
  console.log(`  query     tracking`);
  console.log(`  timeout   ${TIMEOUT_MS} ms per request`);
  console.log(`  max size  ${MAX_BYTES} bytes`);

  if (BASE_URL === 'https://app.noest-dz.com') ok('default base URL matches noest api doc.md');
  else note(`base URL overridden by NOEST_LABEL_API_BASE (${BASE_URL})`);

  header('2. Query encoding');
  const encoded = labelUrl('A B/1+2');
  if (encoded.endsWith('?tracking=A+B%2F1%2B2')) ok('URLSearchParams encodes spaces, slashes and plus signs');
  else fail(`unexpected encoded URL: ${encoded}`);
  if (!encoded.includes('user_guid')) ok('label URL carries no user_guid by default');

  header('3. Fixture');
  const fixture = path.resolve(__dirname, '../test/fixtures/order-labels/noest-label.pdf');
  if (!fs.existsSync(fixture)) {
    note('test/fixtures/order-labels/noest-label.pdf is absent (expected until N0 capture)');
  } else {
    const bytes = fs.readFileSync(fixture);
    if (!isPdf(bytes)) {
      fail('fixture does not start with %PDF-');
    } else {
      ok(`fixture is a PDF (${bytes.length} bytes, sha256 ${hashPrefix(bytes)})`);
      inspectPdf(bytes)
        .then((info) => {
          if (!info) fail('fixture has no pages');
          else
            ok(
              `fixture page box ${info.widthPt.toFixed(1)}x${info.heightPt.toFixed(1)} pt ` +
                `(${info.widthMm}x${info.heightMm} mm), pages=${info.pageCount}`,
            );
        })
        .catch((error) => fail(`fixture is not a readable PDF: ${error.message}`));
    }
  }

  console.log(
    `\n[NOEST LABELS SPIKE] offline problems=${problems.length}` +
      (notes.length ? `, notes=${notes.length}` : ''),
  );
}

/* ------------------------------------------------------------------ *
 * Live probe
 * ------------------------------------------------------------------ */

function decryptCredentials(raw, key) {
  try {
    const { decryptRecord } = require('../dist/common/encryption.util');
    return decryptRecord(raw, key);
  } catch {
    return raw;
  }
}

function objectId(value) {
  try {
    const { Types } = require('mongoose');
    return Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : null;
  } catch {
    return null;
  }
}

async function resolveConfig(collection, storeId) {
  if (storeId) {
    const oid = objectId(storeId);
    if (oid) {
      const found = await collection.findOne({ storeId: oid });
      if (found) return { config: found, matchedBy: 'storeId' };
    }
  }
  const withNoest = await collection
    .find({ 'companies.noest': { $exists: true } })
    .sort({ updatedAt: -1 })
    .limit(10)
    .toArray();
  if (withNoest.length === 0) return { config: null, matchedBy: null };
  if (withNoest.length > 1) {
    note(`${withNoest.length} stores have Noest config; using the most recently updated one`);
  }
  return { config: withNoest[0], matchedBy: 'companies.noest' };
}

async function pickOrder(collection, store, orderRef, parcelArg) {
  if (parcelArg) {
    return {
      orderNo: orderRef || '(explicit parcel)',
      tracking: String(parcelArg).trim(),
      status: '(explicit parcel)',
    };
  }

  const filter = { deliveryCompanyId: 'noest', isDeleted: { $ne: true } };
  const tenantId = store?.storeId;
  if (tenantId) filter.storeId = { $in: [tenantId, String(tenantId)] };
  if (orderRef) {
    filter.$or = [{ orderNo: orderRef }, { _id: objectId(orderRef) || orderRef }];
  } else {
    filter.deliveryParcelId = { $type: 'string', $ne: '' };
    filter['status.slug'] = { $in: ['dispatched', 'in-transit', 'delivered', 'returned'] };
  }

  const order = await collection.findOne(filter, {
    sort: { createdAt: -1 },
    projection: { orderNo: 1, status: 1, storeId: 1, deliveryParcelId: 1 },
  });
  if (!order) return null;
  return {
    orderNo: order.orderNo,
    tracking: String(order.deliveryParcelId || '').trim(),
    status: typeof order.status === 'string' ? order.status : order.status?.slug,
    orderId: String(order._id),
  };
}

async function runLive() {
  const { default: buildConfiguration } = require('../dist/config/configuration');
  const configuration = buildConfiguration();
  const encryptionKey = configuration.deliveryEncryptionKey || process.env.DELIVERY_ENCRYPTION_KEY || '';

  header('1. Configuration');
  console.log(`  ORDER_LABELS_ENABLED=${process.env.ORDER_LABELS_ENABLED ?? '(unset)'}`);
  console.log(`  encryptionKey=${encryptionKey ? 'set' : '(unset - credentials read as stored)'}`);
  console.log(`  base=${BASE_URL}`);

  const mongoose = require('mongoose');
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    fail('MONGODB_URI is required for --live');
    return;
  }

  await mongoose.connect(uri);
  try {
    const db = mongoose.connection.db;
    const configs = db.collection('deliveryconfigs');
    const orders = db.collection('orders');

    header('2. Store credentials');
    const resolved = await resolveConfig(configs, args.store);
    if (!resolved.config) {
      fail('no delivery config contains companies.noest');
      return;
    }
    const store = resolved.config;
    console.log(`  storeId      ${String(store.storeId ?? '(none)')}`);
    console.log(`  vendorEmail  ${store.vendorEmail ?? '(none)'}`);
    console.log(`  matchedBy    ${resolved.matchedBy}`);
    console.log(`  noest status ${store.companies?.noest?.status ?? '(none)'}`);

    const raw = store.companies?.noest?.credentials || {};
    const creds = decryptCredentials(raw, encryptionKey);
    const apiToken = creds.apiToken || creds.apiKey;
    const userGuid = creds.guid || creds.userGuid;
    if (!apiToken) {
      fail('Noest apiToken is missing');
      return;
    }
    console.log(`  apiToken     ${apiToken ? 'present' : 'missing'}`);
    console.log(`  userGuid     ${userGuid ? 'present' : 'missing'}`);

    header('3. Order / parcel');
    const order = await pickOrder(orders, store, args.order, args.parcel);
    if (!order) {
      fail('no dispatched Noest order with a parcel id was found');
      return;
    }
    console.log(`  orderNo      ${order.orderNo}`);
    console.log(`  status       ${order.status}`);
    console.log(`  tracking     ${order.tracking || '(empty)'}`);
    if (!order.tracking) {
      fail('the order has no deliveryParcelId');
      return;
    }

    header('4. Label request');
    const url = labelUrl(order.tracking);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const startedAt = Date.now();
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: 'application/pdf',
        },
        signal: controller.signal,
      });
    } catch (error) {
      fail(
        error?.name === 'AbortError'
          ? `request timed out after ${TIMEOUT_MS} ms`
          : `request failed: ${error.message}`,
      );
      return;
    } finally {
      clearTimeout(timer);
    }
    const elapsedMs = Date.now() - startedAt;

    console.log(`  status        ${response.status}`);
    console.log(`  content-type  ${response.headers.get('content-type') || '(none)'}`);
    console.log(`  disposition   ${response.headers.get('content-disposition') || '(none)'}`);
    console.log(`  retry-after   ${response.headers.get('retry-after') || '(none)'}`);
    console.log(`  elapsed       ${elapsedMs} ms`);

    const declared = Number.parseInt(response.headers.get('content-length') || '', 10);
    const bytes = Buffer.from(await response.arrayBuffer());
    console.log(`  bytes         ${bytes.length}${Number.isFinite(declared) ? ` (declared ${declared})` : ''}`);

    if (!response.ok) {
      const preview = bytes
        .subarray(0, 160)
        .toString('utf8')
        .replace(/\s+/g, ' ')
        .trim();
      console.log(`  body preview  ${preview ? preview : '(empty)'}`);
      fail(`label endpoint answered HTTP ${response.status}`);
      return;
    }

    if (!isPdf(bytes)) {
      fail('response is not a PDF (missing %PDF- magic bytes)');
      return;
    }
    ok(`PDF received (sha256 ${hashPrefix(bytes)})`);

    if (bytes.length > MAX_BYTES) fail(`PDF exceeds the ${MAX_BYTES}-byte cap`);

    header('5. PDF geometry');
    try {
      const info = await inspectPdf(bytes);
      if (!info) {
        fail('PDF has no pages');
      } else {
        console.log(
          `  page box      ${info.widthPt.toFixed(1)} x ${info.heightPt.toFixed(1)} pt ` +
            `(${info.widthMm} x ${info.heightMm} mm)`,
        );
        console.log(`  page count    ${info.pageCount}`);
      }
    } catch (error) {
      fail(`PDF could not be parsed: ${error.message}`);
    }

    if (args.save) {
      const target = path.resolve(args.save);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
      console.log(`  saved         ${target}`);
    }

    header('6. Credential probe');
    console.log('  user_guid was not sent; the request succeeded with Bearer only.');
  } finally {
    await mongoose.disconnect();
  }
}

(async () => {
  if (OFFLINE) runOffline();
  if (LIVE) {
    try {
      await runLive();
    } catch (error) {
      fail(`live probe crashed: ${error.message}`);
    }
  }
  if (problems.length > 0) {
    console.log(`\n[NOEST LABELS SPIKE] FAILED (${problems.length} problem(s))`);
    process.exitCode = 1;
  } else if (!LIVE) {
    console.log('[NOEST LABELS SPIKE] OK');
  } else {
    console.log('\n[NOEST LABELS SPIKE] OK');
  }
})();
