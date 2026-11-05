#!/usr/bin/env node
/*
 * Noest order-label live proof (test store only).
 *
 * Drives the real HTTP endpoint with a locally minted vendor token (the seed vendor password is not
 * stored for this account), generates labels in every UI format, downloads the authenticated
 * artifacts and verifies their page boxes. It never prints a credential or client data, and every
 * artifact expires with the 24 h R2 lifecycle.
 *
 * Run: node scripts/verify-noest-labels-live.js
 *      node scripts/verify-noest-labels-live.js --store=<storeId> --orders=<id,id>
 */

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const API = process.env.API_BASE || 'http://localhost:3000/api';
const STORE_ID = (process.argv.find((v) => v.startsWith('--store=')) || '').split('=')[1] || '6abd12d59676e6a09f1e7ad2';
const ORDERS_ARG = (process.argv.find((v) => v.startsWith('--orders=')) || '').split('=')[1] || '';
const MM_TO_PT = 72 / 25.4;
const OUT_DIR = path.join(process.env.TEMP || '.', 'noest-label-proof');

const problems = [];
const notes = [];

function header(title) {
  console.log(`\n=== ${title} ===`);
}

function ok(message) {
  console.log(`  ok    ${message}`);
}

function note(message) {
  notes.push(message);
  console.log(`  note  ${message}`);
}

function fail(message) {
  problems.push(message);
  console.log(`  FAIL  ${message}`);
}

function closeTo(actual, expected, tolerance = 1) {
  return Math.abs(actual - expected) <= tolerance;
}

function sha(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

async function pageInfo(bytes) {
  const { PDFDocument } = require('pdf-lib');
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = pdf.getPages();
  return {
    pageCount: pages.length,
    widthPt: pages[0]?.getWidth(),
    heightPt: pages[0]?.getHeight(),
  };
}

function assertPdf(bytes, label, expectedMm) {
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    fail(`${label}: response is not a PDF`);
    return null;
  }
  return pageInfo(bytes).then((info) => {
    const expectedW = expectedMm.width * MM_TO_PT;
    const expectedH = expectedMm.height * MM_TO_PT;
    if (info.pageCount !== expectedMm.pages) {
      fail(`${label}: expected ${expectedMm.pages} page(s), got ${info.pageCount}`);
    } else if (!closeTo(info.widthPt, expectedW) || !closeTo(info.heightPt, expectedH)) {
      fail(
        `${label}: expected ${expectedMm.width}x${expectedMm.height}mm, ` +
          `got ${(info.widthPt / MM_TO_PT).toFixed(1)}x${(info.heightPt / MM_TO_PT).toFixed(1)}mm`,
      );
    } else {
      ok(
        `${label}: ${info.pageCount} page(s), ${expectedMm.width.toFixed(1)}x${expectedMm.height.toFixed(1)}mm, ` +
          `${bytes.length} bytes, sha256 ${sha(bytes)}`,
      );
    }
    return info;
  });
}

async function requestJson(method, endpoint, token, body) {
  const response = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, text, json };
}

let lastGenerateAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generate(token, ids, format, grouping) {
  // POST /orders/labels is throttled to 6/min; keep every proof call below that ceiling so a
  // rate-limit response can never be mistaken for a carrier failure.
  const wait = 10500 - (Date.now() - lastGenerateAt);
  if (wait > 0) await sleep(wait);
  lastGenerateAt = Date.now();

  const { response, text, json } = await requestJson('POST', '/orders/labels', token, {
    ids,
    format,
    grouping,
  });
  if (response.status === 429) {
    fail(`generate ${format}/${grouping}: rate limited (sleeping is not enough; rerun later)`);
    return null;
  }
  if (!response.ok || !json) {
    fail(`generate ${format}/${grouping}: HTTP ${response.status} ${text.slice(0, 200)}`);
    return null;
  }
  return json;
}

async function download(token, downloadUrl) {
  const response = await fetch(`${API.replace(/\/api$/, '')}${downloadUrl}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { response, bytes };
}

async function main() {
  const { Types } = require('mongoose');
  const mongoose = require('mongoose');
  const jwt = require('jsonwebtoken');
  const { default: buildConfiguration } = require('../dist/config/configuration');

  const configuration = buildConfiguration();
  if (!configuration.jwt?.secret) {
    fail('JWT_SECRET is not configured');
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const db = mongoose.connection.db;
    const store = await db.collection('stores').findOne({ _id: new Types.ObjectId(STORE_ID) });
    if (!store) {
      fail(`store ${STORE_ID} was not found`);
      return;
    }
    const vendor = await db.collection('users').findOne({ email: store.vendorEmail });
    if (!vendor) {
      fail(`vendor ${store.vendorEmail} was not found`);
      return;
    }

    const token = jwt.sign(
      { sub: String(vendor._id), email: vendor.email, role: vendor.role },
      configuration.jwt.secret,
    );

    header('1. Availability');
    const availability = await requestJson('GET', '/orders/labels/availability', token);
    if (!availability.response.ok || !availability.json) {
      fail(`availability: HTTP ${availability.response.status}`);
      return;
    }
    console.log(`  enabled=${availability.json.enabled}`);
    console.log(`  carriers=${(availability.json.carriers || []).join(', ') || '(none)'}`);
    if (!availability.json.enabled) fail('label printing is not enabled for this store');
    if (!(availability.json.carriers || []).includes('noest')) {
      fail('noest is missing from the availability carriers (running backend is stale?)');
      return;
    }
    ok('noest is advertised by the real availability endpoint');

    header('2. Orders');
    let orders;
    if (ORDERS_ARG) {
      orders = await db
        .collection('orders')
        .find({ orderNo: { $in: ORDERS_ARG.split(',').map((v) => v.trim()) } })
        .project({ orderNo: 1, status: 1, deliveryParcelId: 1, deliveryCompanyId: 1 })
        .toArray();
    } else {
      orders = await db
        .collection('orders')
        .find({
          storeId: { $in: [new Types.ObjectId(STORE_ID), STORE_ID] },
          deliveryCompanyId: 'noest',
          'status.slug': 'dispatched',
          deliveryParcelId: { $type: 'string', $ne: '' },
          isDeleted: { $ne: true },
        })
        .sort({ createdAt: -1 })
        .limit(2)
        .project({ orderNo: 1, status: 1, deliveryParcelId: 1, deliveryCompanyId: 1 })
        .toArray();
    }
    if (orders.length === 0) {
      fail('no dispatched Noest order with a parcel id was found');
      return;
    }
    for (const order of orders) {
      console.log(
        `  ${order.orderNo}  ${order.status?.slug ?? order.status}  ${order.deliveryCompanyId}  ${order.deliveryParcelId}`,
      );
    }
    const ids = orders.map((order) => String(order._id));

    fs.mkdirSync(OUT_DIR, { recursive: true });

    header('3. Single label, every format');
    const formats = [
      ['10x13', { width: 100, height: 130, pages: 1 }],
      ['10x15', { width: 100, height: 150, pages: 1 }],
      ['a4_1up', { width: 210, height: 297, pages: 1 }],
      ['native', { width: 210, height: 297, pages: 1 }],
    ];
    for (const [format, expected] of formats) {
      const job = await generate(token, [ids[0]], format, 'combined');
      if (!job) continue;
      if (job.summary.printed !== 1 || job.summary.failed !== 0) {
        fail(
          `${format}: expected printed=1 failed=0, got printed=${job.summary.printed} failed=${job.summary.failed}`,
        );
        continue;
      }
      for (const warning of job.warnings || []) {
        note(`${format}: ${warning.code} ${warning.scale ? `(scale ${warning.scale})` : ''}`);
      }
      if (!job.downloadUrl) {
        fail(`${format}: no download URL (artifact storage failed?)`);
        continue;
      }
      const { response, bytes } = await download(token, job.downloadUrl);
      if (!response.ok) {
        fail(`${format}: download HTTP ${response.status}`);
        continue;
      }
      fs.writeFileSync(path.join(OUT_DIR, `noest-${format}.pdf`), bytes);
      await assertPdf(bytes, `single ${format}`, expected);
    }

    const fourUp = await generate(token, [ids[0]], 'a4_4up', 'combined');
    if (fourUp?.downloadUrl) {
      const { response, bytes } = await download(token, fourUp.downloadUrl);
      if (response.ok) {
        fs.writeFileSync(path.join(OUT_DIR, 'noest-a4_4up.pdf'), bytes);
        await assertPdf(bytes, 'single a4_4up', { width: 210, height: 297, pages: 1 });
      } else {
        fail(`a4_4up: download HTTP ${response.status}`);
      }
    }

    if (ids.length >= 2) {
      header('4. Batch');
      const batch = await generate(token, ids, '10x15', 'combined');
      if (batch) {
        console.log(
          `  requested=${batch.summary.requested} printed=${batch.summary.printed} failed=${batch.summary.failed} skipped=${batch.summary.skipped}`,
        );
        if (batch.summary.printed !== ids.length || batch.summary.failed !== 0) {
          fail('batch: not every Noest order printed');
        } else if (batch.downloadUrl) {
          const { response, bytes } = await download(token, batch.downloadUrl);
          if (response.ok) {
            fs.writeFileSync(path.join(OUT_DIR, 'noest-batch.pdf'), bytes);
            await assertPdf(bytes, 'batch 10x15', {
              width: 100,
              height: 150,
              pages: ids.length,
            });
          } else {
            fail(`batch download HTTP ${response.status}`);
          }
        }
      }

      const perCarrier = await generate(token, ids, '10x15', 'per_carrier');
      if (perCarrier) {
        if (!perCarrier.downloadUrl) {
          fail('per_carrier: no ZIP download URL');
        } else {
          const { response, bytes } = await download(token, perCarrier.downloadUrl);
          const isZip = bytes.subarray(0, 2).toString('ascii') === 'PK';
          const hasManifest = bytes.includes(Buffer.from('manifest.json'));
          const hasPdf = bytes.includes(Buffer.from('noest-labels.pdf'));
          if (!response.ok || !isZip) {
            fail(`per_carrier: expected a ZIP, HTTP ${response.status}`);
          } else if (!hasManifest || !hasPdf) {
            fail('per_carrier: ZIP is missing manifest.json or noest-labels.pdf');
          } else {
            fs.writeFileSync(path.join(OUT_DIR, 'noest-per-carrier.zip'), bytes);
            ok(`per_carrier ZIP: ${bytes.length} bytes, manifest + noest-labels.pdf, sha256 ${sha(bytes)}`);
          }
        }
      }
    } else {
      note('only one order is available; batch/per-carrier checks were skipped');
    }

    header('5. Skipped pre-dispatch order stays isolated');
    const preDispatch = await db.collection('orders').findOne({
      storeId: { $in: [new Types.ObjectId(STORE_ID), STORE_ID] },
      'status.slug': 'placed',
      isDeleted: { $ne: true },
    });
    if (!preDispatch) {
      note('no placed order is available for the skip check');
    } else {
      const job = await generate(token, [String(preDispatch._id), ids[0]], '10x15', 'combined');
      if (job) {
        console.log(
          `  requested=${job.summary.requested} printed=${job.summary.printed} failed=${job.summary.failed} skipped=${job.summary.skipped}`,
        );
        if (job.summary.printed !== 1 || job.summary.skipped !== 1) {
          fail('pre-dispatch order was not reported as skipped while the dispatched one printed');
        } else {
          ok('one dispatched label printed and the placed order was skipped');
        }
      }
    }

    header('6. Foreign-store download is refused');
    const otherStore = await db
      .collection('stores')
      .findOne({ _id: { $ne: new Types.ObjectId(STORE_ID) }, vendorEmail: { $exists: true } });
    const otherVendor = otherStore
      ? await db.collection('users').findOne({ email: otherStore.vendorEmail })
      : null;
    if (!otherVendor) {
      note('no second store/vendor is available for the tenancy check');
    } else {
      const otherToken = jwt.sign(
        { sub: String(otherVendor._id), email: otherVendor.email, role: otherVendor.role },
        configuration.jwt.secret,
      );
      const job = await generate(token, [ids[0]], '10x15', 'combined');
      if (job?.downloadUrl) {
        const { response } = await download(otherToken, job.downloadUrl);
        if (response.ok) {
          fail('a foreign store could download this label artifact');
        } else {
          ok(`foreign-store download refused with HTTP ${response.status}`);
        }
      }
      const otherAvailability = await requestJson('GET', '/orders/labels/availability', otherToken);
      if (otherAvailability.json?.enabled === true) {
        ok('a second store reports label printing as enabled (global switch)');
      } else {
        fail('a second store reports label printing as disabled while the global flag is on');
      }
    }

    header('7. Response contains no credential material');
    const last = await requestJson('POST', '/orders/labels', token, {
      ids: [ids[0]],
      format: '10x15',
      grouping: 'combined',
    });
    const serialized = JSON.stringify(last.json || {});
    const leaked = ['apiToken', 'Bearer ', 'noest-guid', 'userGuid'].filter((needle) =>
      serialized.includes(needle),
    );
    if (leaked.length > 0) fail(`response leaks credential material: ${leaked.join(', ')}`);
    else ok('no credential field name or bearer material in the response');
  } finally {
    await mongoose.disconnect();
  }

  console.log(`\n  artifacts: ${OUT_DIR}`);
}

(async () => {
  try {
    await main();
  } catch (error) {
    fail(`live proof crashed: ${error.message}`);
  }
  if (problems.length > 0) {
    console.log(`\n[NOEST LABELS LIVE] FAILED (${problems.length} problem(s))`);
    process.exitCode = 1;
  } else {
    console.log(
      `\n[NOEST LABELS LIVE] OK${notes.length ? ` (${notes.length} note(s))` : ''}`,
    );
  }
})();
