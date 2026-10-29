#!/usr/bin/env node
/*
 * Offline structural validation for shipping-label fixtures and composition.
 *
 * This deliberately does NOT claim live-carrier proof. The fixtures under
 * test/fixtures/order-labels are synthetic; the live L0 gate still needs real
 * ZR/Ecom/DHD credentials and test parcels. Pass --live to see the guard.
 *
 * Usage:
 *   npm run build && node scripts/spike-order-labels.js --offline
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'test', 'fixtures', 'order-labels');
const EXPECTED_PATH = path.join(FIXTURE_DIR, 'expected', 'structural.json');
const DIST = path.join(ROOT, 'dist');

const { LabelComposerService } = require(path.join(
  DIST,
  'modules/order-labels/services/label-composer.service',
));
const { LabelArtifactService } = require(path.join(
  DIST,
  'modules/order-labels/services/label-artifact.service',
));
const {
  A4_CELL_MM,
  A4_GUTTER_MM,
  A4_MARGIN_MM,
  A4_MM,
  MAX_COMFORTABLE_SCALE,
  MIN_COMFORTABLE_SCALE,
  MM_TO_PT,
  ORDER_LABEL_PAGE_MM,
} = require(path.join(DIST, 'modules/order-labels/order-labels.constants'));
const { AppErrorCode } = require(path.join(DIST, 'common/errors/error-codes.enum'));

const problems = [];
const notes = [];
const jobs = [];

function ok(label) {
  jobs.push(label);
}

function fail(message) {
  problems.push(message);
}

function closeTo(actual, expected, tolerance = 0.05) {
  return Math.abs(actual - expected) <= tolerance;
}

function mmToPt(value) {
  return value * MM_TO_PT;
}

async function makePdf(widthMm, heightMm, pages = 1) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    const page = doc.addPage([mmToPt(widthMm), mmToPt(heightMm)]);
    page.drawText(`SYNTHETIC ${index + 1}`, { x: 12, y: heightMm * MM_TO_PT - 24, size: 8, font });
    page.drawRectangle({
      x: 8,
      y: 8,
      width: Math.max(20, mmToPt(widthMm) - 16),
      height: 24,
      borderWidth: 1,
    });
  }
  const bytes = Buffer.from(await doc.save());
  return {
    bytes,
    pageCount: pages,
    pageWidthPt: mmToPt(widthMm),
    pageHeightPt: mmToPt(heightMm),
  };
}

function label(orderNo, rendered, documentOverrides = {}) {
  return {
    orderNo,
    rendered,
    document: {
      orderNo,
      trackingNumber: `TRK-${orderNo}`,
      contentType: 'application/pdf',
      bytes: rendered.bytes,
      ...documentOverrides,
    },
  };
}

async function assertPageSize(bytes, expectedWidthPt, expectedHeightPt, message) {
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages();
  assert.strictEqual(pages.length, 1, `${message}: expected one page`);
  const { width, height } = pages[0].getSize();
  if (!closeTo(width, expectedWidthPt) || !closeTo(height, expectedHeightPt)) {
    fail(
      `${message}: expected ${expectedWidthPt.toFixed(2)}x${expectedHeightPt.toFixed(2)}pt, got ${width.toFixed(2)}x${height.toFixed(2)}pt`,
    );
    return;
  }
  ok(`${message}: ${expectedWidthPt.toFixed(1)}x${expectedHeightPt.toFixed(1)}pt`);
}

async function validateFixtureManifest(expected) {
  for (const [name, meta] of Object.entries(expected.fixtures)) {
    const filePath = path.join(FIXTURE_DIR, name);
    if (!fs.existsSync(filePath)) {
      fail(`fixture missing: ${name}`);
      continue;
    }

    if (meta.kind === 'html') {
      const html = fs.readFileSync(filePath, 'utf8');
      if (!html.includes('SYNTHETIC TEST FIXTURE')) {
        fail(`${name}: missing the synthetic-fixture marker (a live capture must be scrubbed and marked)`);
      }
      if (!/@page\s*\{[^}]*size\s*:/i.test(html)) {
        fail(`${name}: no @page size`);
      }
      if (!html.includes(`${meta.page.widthMm}mm`) || !html.includes(`${meta.page.heightMm}mm`)) {
        fail(`${name}: @page does not declare ${meta.page.widthMm}x${meta.page.heightMm}mm`);
      }
      const labels = (html.match(/data-label=/g) || []).length;
      if (labels !== meta.labels) {
        fail(`${name}: expected ${meta.labels} labels, found ${labels}`);
      }
      for (const tracking of meta.trackings) {
        if (!html.includes(tracking)) fail(`${name}: missing tracking ${tracking}`);
      }
      if (meta.pages) {
        const pages = (html.match(/data-page=/g) || []).length;
        if (pages !== meta.pages) fail(`${name}: expected ${meta.pages} pages, found ${pages}`);
      }
      ok(`fixture ${name}: ${meta.labels} label(s)${meta.pages ? `, ${meta.pages} page(s)` : ''}`);
    } else if (meta.kind === 'pdf') {
      const bytes = fs.readFileSync(filePath);
      if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        fail(`${name}: not a PDF (magic bytes)`);
        continue;
      }
      const doc = await PDFDocument.load(bytes);
      const pages = doc.getPages();
      if (pages.length !== meta.pages) fail(`${name}: expected ${meta.pages} page(s), found ${pages.length}`);
      const { width, height } = pages[0].getSize();
      if (
        !closeTo(width, mmToPt(meta.page.widthMm), 0.5) ||
        !closeTo(height, mmToPt(meta.page.heightMm), 0.5)
      ) {
        fail(`${name}: unexpected page size ${width.toFixed(2)}x${height.toFixed(2)}pt`);
      }
      if (meta.cropBox) {
        const crop = meta.cropBox;
        if (
          crop.xPt < 0 ||
          crop.yPt < 0 ||
          crop.xPt + crop.widthPt > width + 0.5 ||
          crop.yPt + crop.heightPt > height + 0.5
        ) {
          fail(`${name}: crop box falls outside the page`);
        } else if (
          !closeTo(crop.widthPt / MM_TO_PT, crop.widthMm, 0.1) ||
          !closeTo(crop.heightPt / MM_TO_PT, crop.heightMm, 0.1)
        ) {
          fail(`${name}: crop box millimetre size does not match its points`);
        } else {
          ok(
            `fixture ${name}: crop ${crop.widthMm}x${crop.heightMm}mm at (${crop.xPt}, ${crop.yPt})`,
          );
        }
      }
      ok(`fixture ${name}: ${pages.length} page(s), ${meta.page.widthMm}x${meta.page.heightMm}mm`);
    }
  }
}

async function validateComposer() {
  const composer = new LabelComposerService();

  for (const [format, size] of Object.entries(ORDER_LABEL_PAGE_MM)) {
    const rendered = await makePdf(100, 130);
    const result = await composer.compose(format, [label(`ORD-${format}`, rendered)]);
    await assertPageSize(
      result.bytes,
      mmToPt(size.width),
      mmToPt(size.height),
      `${format} exact one-up`,
    );
  }

  const a4Source = await makePdf(A4_MM.width, A4_MM.height);
  const native = await composer.compose('native', [label('ORD-NATIVE', a4Source)]);
  await assertPageSize(native.bytes, mmToPt(A4_MM.width), mmToPt(A4_MM.height), 'native pass-through');

  const a4One = await composer.compose('a4_1up', [label('ORD-A4-1', await makePdf(100, 130))]);
  await assertPageSize(a4One.bytes, mmToPt(A4_MM.width), mmToPt(A4_MM.height), 'a4_1up page');

  const fourLabels = await Promise.all(
    [1, 2, 3, 4].map(async (index) => label(`ORD-4UP-${index}`, await makePdf(100, 130))),
  );
  const fourUp = await composer.compose('a4_4up', fourLabels);
  assert.strictEqual(fourUp.pageCount, 1, 'a4_4up with four labels must use one page');
  const fourUpDoc = await PDFDocument.load(fourUp.bytes);
  await assertPageSize(fourUp.bytes, mmToPt(A4_MM.width), mmToPt(A4_MM.height), 'a4_4up page');
  assert.strictEqual(fourUpDoc.getPageCount(), 1, 'a4_4up PDF page count');
  ok('a4_4up: 4 labels on 1 A4 page');

  const fiveLabels = await Promise.all(
    [1, 2, 3, 4, 5].map(async (index) => label(`ORD-4UP-5-${index}`, await makePdf(100, 130))),
  );
  const fiveUp = await composer.compose('a4_4up', fiveLabels);
  assert.strictEqual(fiveUp.pageCount, 2, 'five labels must spill to a second A4 page');
  ok('a4_4up: 5 labels -> 2 pages');

  const a4CellArea =
    (A4_MM.width - A4_MARGIN_MM * 2 - A4_GUTTER_MM) *
    (A4_MM.height - A4_MARGIN_MM * 2 - A4_GUTTER_MM);
  assert.ok(A4_CELL_MM.width > 0 && A4_CELL_MM.height > 0 && a4CellArea > 0, 'A4 cell math');
  ok(
    `A4 cell: ${A4_CELL_MM.width.toFixed(2)}x${A4_CELL_MM.height.toFixed(2)}mm (margin ${A4_MARGIN_MM}, gutter ${A4_GUTTER_MM})`,
  );

  const scaled = await composer.compose('10x13', [label('ORD-SCALED', await makePdf(100, 150))]);
  const scaleWarning = scaled.warnings.find((warning) => warning.code === 'ORDER_LABEL_SCALE_WARNING');
  if (!scaleWarning) {
    fail('10x15 source into 10x13 must emit ORDER_LABEL_SCALE_WARNING');
  } else if (
    !(scaleWarning.scale >= 0 && scaleWarning.scale < MIN_COMFORTABLE_SCALE && scaleWarning.scale <= MAX_COMFORTABLE_SCALE)
  ) {
    fail(`unexpected scale warning ratio ${scaleWarning.scale}`);
  } else {
    ok(`scale warning: 10x15 -> 10x13 at ${scaleWarning.scale}`);
  }

  const cropWidth = 105;
  const cropHeight = 148.5;
  const sheet = await makePdf(A4_MM.width, A4_MM.height);
  const cropped = await composer.compose('10x13', [
    label('ORD-ZR-SHEET', sheet, {
      sheet: true,
      widthMm: cropWidth,
      heightMm: cropHeight,
      cropBox: {
        x: 0,
        y: mmToPt(A4_MM.height - cropHeight),
        width: mmToPt(cropWidth),
        height: mmToPt(cropHeight),
      },
    }),
  ]);
  await assertPageSize(cropped.bytes, mmToPt(100), mmToPt(130), 'ZR top-left crop -> 10x13');

  const noestCrop = {
    x: 7.5,
    y: 427.714,
    width: 285.837,
    height: 406.676,
  };
  const noestSheet = await makePdf(A4_MM.width, A4_MM.height);
  const noest15 = await composer.compose('10x15', [
    label('ORD-NOEST-15', noestSheet, {
      cropBox: noestCrop,
      widthMm: noestCrop.width / MM_TO_PT,
      heightMm: noestCrop.height / MM_TO_PT,
    }),
  ]);
  await assertPageSize(noest15.bytes, mmToPt(100), mmToPt(150), 'Noest crop -> 10x15');
  if (noest15.warnings.length > 0) {
    fail(
      `Noest crop -> 10x15 should fit without a warning, got ${JSON.stringify(noest15.warnings)}`,
    );
  } else {
    ok('Noest crop -> 10x15 fits without a scale warning');
  }

  const noest13 = await composer.compose('10x13', [
    label('ORD-NOEST-13', noestSheet, {
      cropBox: noestCrop,
      widthMm: noestCrop.width / MM_TO_PT,
      heightMm: noestCrop.height / MM_TO_PT,
    }),
  ]);
  const noest13Warning = noest13.warnings.find(
    (warning) => warning.code === 'ORDER_LABEL_SCALE_WARNING',
  );
  if (!noest13Warning) {
    fail('Noest crop -> 10x13 must warn that the slip is taller than the paper');
  } else {
    ok(`Noest crop -> 10x13 warns at scale ${noest13Warning.scale}`);
  }
}

function validateArtifactKeys() {
  const config = { get: () => undefined };
  const artifact = new LabelArtifactService({}, config);
  const jobId = '01234567-89ab-4cde-8f01-23456789abcd';
  const key = artifact.keyFor('store-abc', jobId, 'labels.pdf');
  const expected = `order-labels/store-abc/${jobId}/labels.pdf`;
  if (key !== expected) fail(`artifact key: expected ${expected}, got ${key}`);
  else ok(`artifact key scoped by store: ${key}`);
  if (artifact.keyFor('store-abc', jobId, 'labels.zip') !== `order-labels/store-abc/${jobId}/labels.zip`) {
    fail('artifact ZIP key is not store-scoped');
  }
}

function validateErrorCoverage(expected) {
  const actual = Object.keys(AppErrorCode)
    .filter((key) => key.startsWith('ORDER_LABEL_'))
    .sort();
  const declared = [...expected.errorCodes].sort();
  const missing = declared.filter((code) => !actual.includes(code));
  const extra = actual.filter((code) => !declared.includes(code));
  if (missing.length) fail(`error codes missing from enum: ${missing.join(', ')}`);
  if (extra.length) fail(`error codes not covered by the offline manifest: ${extra.join(', ')}`);
  if (!missing.length && !extra.length) ok(`error-code coverage: ${actual.length} ORDER_LABEL_* codes`);
}

async function main() {
  const mode = process.argv.includes('--live') ? 'live' : 'offline';
  if (mode === 'live') {
    console.error(
      '[ORDER LABELS] Live proof is gated: set up real ZR/Ecom/DHD credentials and test parcels first.',
    );
    console.error('[ORDER LABELS] This script never mutates orders and does not fake live results.');
    process.exit(2);
  }

  const expected = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));

  await validateFixtureManifest(expected);
  if (!fs.existsSync(path.join(DIST, 'modules/order-labels/services/label-composer.service.js'))) {
    fail('dist is missing; run npm run build first');
  } else {
    await validateComposer();
  }
  validateArtifactKeys();
  validateErrorCoverage(expected);

  for (const entry of jobs) console.log(`  ok  ${entry}`);
  for (const note of notes) console.log(`  note ${note}`);

  if (problems.length > 0) {
    console.error(`\n[ORDER LABELS] ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(
    `\n[ORDER LABELS] OK (${mode}; ${jobs.length} checks). Fixtures are synthetic, not live-carrier proof.`,
  );
}

main().catch((error) => {
  console.error('[ORDER LABELS] Unexpected failure:', error);
  process.exit(1);
});
