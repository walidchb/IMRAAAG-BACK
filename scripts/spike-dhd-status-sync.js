#!/usr/bin/env node

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

require('ts-node').register({ transpileOnly: true });

const mapper = require(path.join(
  __dirname,
  '../src/modules/delivery/delivery-companies/handlers/dhd/dhd-status.mapper',
));
const encryption = require(path.join(__dirname, '../src/common/encryption.util'));

const FIXTURES = require(path.join(
  __dirname,
  'fixtures/dhd-status/synthetic-fixtures.json',
));
const MONGO_URI = process.env.MONGODB_URI;
const ENCRYPTION_KEY = process.env.DELIVERY_ENCRYPTION_KEY || '';
const DEFAULT_BASE = process.env.DHD_STATUS_API_BASE || process.env.DHD_API_BASE || '';
const TIMEOUT_MS = 15000;
const ALLOWED_READ_PATHS = [
  '/api/v1/get/trackings/info',
  '/api/v1/get/orders/status',
  '/api/v1/get/tracking/info',
];

function parseArgs(argv) {
  const args = {
    offline: false,
    json: false,
    store: null,
    tracking: null,
    token: null,
    base: null,
    auth: null,
    out: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--offline') args.offline = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--store') args.store = argv[++i];
    else if (arg === '--tracking') args.tracking = argv[++i];
    else if (arg === '--token') args.token = argv[++i];
    else if (arg === '--base') args.base = argv[++i];
    else if (arg === '--auth') args.auth = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(
    [
      'Usage: node scripts/spike-dhd-status-sync.js [options]',
      '',
      '  --offline            validate the frozen DHD contract without network or database',
      '  --store <id|email>   read the store DHD apiToken from MongoDB and probe it',
      '  --token <apiToken>   probe with a token instead of a database store',
      '  --tracking <value>   read one tracking status and history',
      '  --base <url>         override the DHD status base URL',
      '  --auth bearer|query  override the auth transport',
      '  --json               machine-readable output',
      '  --out <file>         also write the report as JSON',
      '',
      'Live mode is read-only. It never creates or edits an order or a parcel.',
    ].join('\n'),
  );
  process.exit(0);
}

const report = {
  startedAt: new Date().toISOString(),
  mode: args.offline ? 'offline' : 'live',
  offline: null,
  store: null,
  probe: null,
  findings: [],
  problems: [],
};

function log(line = '') {
  if (!args.json) console.log(line);
}

function finding(id, severity, message, detail) {
  const entry = { id, severity, message };
  if (detail !== undefined) entry.detail = detail;
  report.findings.push(entry);
  if (!args.json) {
    const tag = severity === 'ok' ? 'ok   ' : severity === 'warn' ? 'warn ' : 'BLOCK';
    console.log(`  ${tag} [${id}] ${message}`);
  }
}

function problem(message, detail) {
  report.problems.push(detail === undefined ? { message } : { message, detail });
  if (!args.json) console.log(`  BLOCK  ${message}`);
}

function assertReadOnlyPath(url) {
  const parsed = new URL(url);
  if (!ALLOWED_READ_PATHS.includes(parsed.pathname)) {
    throw new Error(`Refusing to call a non-allowlisted DHD endpoint: ${parsed.pathname}`);
  }
}

function statusVectors() {
  return FIXTURES.parcels.map((row) => ({
    name: row.status,
    parcel: {
      tracking: 'SPIKE-DHD',
      reference: 'SPIKE-ORDER',
      status: row.status,
      activity: [
        {
          date: '2026-10-21',
          time: '09:30:00',
          status: row.status,
          station: 'Alger',
        },
      ],
    },
    expectedStatus: row.expectedStatus,
    expectedSignal: row.expectedSignal,
  }));
}

function activityVectors() {
  return FIXTURES.activities.map((row) => ({
    name: row.status,
    parcel: {
      tracking: 'SPIKE-DHD',
      status: '',
      activity: [{ date: '2026-10-21', time: '09:30:00', status: row.status }],
    },
    expectedStatus: row.expectedStatus,
    expectedSignal: row.expectedSignal,
  }));
}

function runOffline() {
  log('[SPIKE DHD STATUS SYNC] Offline contract validation. No network, no database.\n');

  const problems = mapper.validateDhdCatalogue();
  if (problems.length > 0) {
    for (const value of problems) problem(value);
  } else {
    finding('catalogue', 'ok', 'status and activity catalogues are internally consistent');
  }

  const vectors = [...statusVectors(), ...activityVectors()];
  let failed = 0;
  for (const vector of vectors) {
    const mapped = mapper.mapDhdParcel(vector.parcel);
    const detected = mapper.detectDhdOrderSignal(vector.parcel);
    const statusOk = mapped.deliveryStatus === vector.expectedStatus;
    const signalOk = detected.signal === vector.expectedSignal;
    if (!statusOk) {
      failed += 1;
      problem(`${vector.name}: expected ${vector.expectedStatus}, got ${mapped.deliveryStatus}`);
    }
    if (!signalOk) {
      failed += 1;
      problem(`${vector.name}: expected signal ${vector.expectedSignal}, got ${detected.signal}`);
    }
  }
  if (failed === 0) {
    finding('vectors', 'ok', `${vectors.length} status/activity vectors mapped as frozen`);
  }

  const iso = mapper.parseDhdInstant('2026-10-21', '10:15:00');
  if (iso?.toISOString() !== '2026-10-21T09:15:00.000Z') {
    problem(`offset-free DHD timestamp was not read as Africa/Algiers: ${iso?.toISOString()}`);
  } else {
    finding('timestamp', 'ok', 'offset-free DHD time is stored as UTC with the +01:00 default');
  }

  const suspended = mapper.dhdSituationFlags('Suspendu');
  if (!suspended.includes('postponed')) {
    problem('Suspendu did not produce the postponed flag');
  } else {
    finding('flags', 'ok', 'Suspendu produces the postponed flag');
  }

  const history = mapper.mapDhdHistoryEntries('SPIKE-DHD', [
    { date: '2026-10-20', time: '08:00:00', status: 'Picked', station: 'Alger' },
    { date: '2026-10-21', time: '09:30:00', status: 'En livraison', station: 'Alger' },
  ]);
  if (history.length !== 2 || history[1].fromState !== 'picked') {
    problem('history mapping did not preserve oldest-first transition order');
  } else {
    finding('history', 'ok', 'history is oldest-first with stable transition ids');
  }

  report.offline = {
    vectors: vectors.length,
    failed,
    statuses: FIXTURES.parcels.length,
    activities: FIXTURES.activities.length,
    rateLimit: FIXTURES.rateLimit,
    catalogueProblems: problems,
  };
}

async function loadStoreToken(store) {
  if (!MONGO_URI) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(MONGO_URI);

  const filter = /^[a-fA-F0-9]{24}$/.test(store)
    ? { $or: [{ storeId: new mongoose.Types.ObjectId(store) }, { _id: new mongoose.Types.ObjectId(store) }] }
    : { vendorEmail: store };
  const config = await mongoose.connection.db.collection('deliveryconfigs').findOne(filter);
  if (!config) throw new Error('No delivery configuration matches the store');

  const company = config.companies?.dhd;
  if (!company || company.status === 'disabled') {
    throw new Error('The store has no enabled DHD configuration');
  }
  const credentials = encryption.decryptRecord(company.credentials || {}, ENCRYPTION_KEY);
  const apiToken = String(credentials.apiToken || '').trim();
  if (!apiToken) throw new Error('The store has no DHD apiToken');

  return {
    apiToken,
    storeId: config.storeId ? String(config.storeId) : null,
    vendorEmail: config.vendorEmail || null,
    overrides: config.statusStateOverrides?.dhd || {},
    signalOverrides: config.statusSignalOverrides?.dhd || {},
  };
}

async function dhdRead(apiToken, base, authMode, endpoint, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (value !== null && value !== undefined && String(value) !== '') {
      params.set(key, value);
    }
  }
  const headers = { Accept: 'application/json' };
  if (authMode === 'query') params.set('api_token', apiToken);
  else headers.Authorization = `Bearer ${apiToken}`;

  const url = `${String(base).replace(/\/+$/, '')}${endpoint}?${params.toString()}`;
  assertReadOnlyPath(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers), text, json };
  } finally {
    clearTimeout(timer);
  }
}

async function runLive() {
  log('[SPIKE DHD STATUS SYNC] Live read-only probe. No writes.\n');

  const base = args.base || DEFAULT_BASE || 'https://platform.dhd-dz.com';
  const authMode = args.auth || process.env.DHD_STATUS_AUTH_MODE || 'bearer';
  if (!['bearer', 'query'].includes(authMode)) {
    throw new Error(`Unsupported --auth value: ${authMode}`);
  }

  let apiToken = args.token;
  if (args.store) {
    const store = await loadStoreToken(args.store);
    apiToken = apiToken || store.apiToken;
    report.store = {
      storeId: store.storeId,
      vendorEmail: store.vendorEmail,
      hasOverrides: Object.keys(store.overrides).length > 0,
      hasSignalOverrides: Object.keys(store.signalOverrides).length > 0,
      tokenFingerprint: crypto.createHash('sha256').update(store.apiToken).digest('hex').slice(0, 16),
    };
    finding('credentials', 'ok', 'resolved the store-first DHD credentials');
  }
  if (!apiToken) throw new Error('Provide --token or --store');

  const tenant = crypto.createHash('sha256').update(apiToken).digest('hex').slice(0, 16);
  finding('base', 'ok', `status base is ${base}`, { authMode, tenant });

  if (!args.tracking) {
    finding(
      'probe',
      'warn',
      'no --tracking supplied; base URL and auth cannot be proven without a test parcel',
    );
    report.probe = { base, authMode, tenant, tracking: null };
    return;
  }

  const status = await dhdRead(apiToken, base, authMode, '/api/v1/get/trackings/info', {
    'trackings[]': [args.tracking],
  });
  if (status.status === 401 || status.status === 403) {
    problem(`DHD rejected the ${authMode} credentials with HTTP ${status.status}`);
  } else if (status.status === 429) {
    problem('DHD rate-limited the probe with HTTP 429', FIXTURES.rateLimit);
  } else if (!status.ok) {
    problem(`DHD status probe failed with HTTP ${status.status}`, {
      message: status.json?.message ?? status.text?.slice(0, 200),
    });
  } else {
    finding('status', 'ok', `DHD status probe answered HTTP ${status.status}`);
  }

  const history = await dhdRead(apiToken, base, authMode, '/api/v1/get/tracking/info', {
    tracking: args.tracking,
  });
  if (!history.ok) {
    finding('history', 'warn', `DHD history probe answered HTTP ${history.status}`);
  } else {
    const activity = history.json?.activity ?? history.json?.data?.activity;
    finding(
      'history',
      Array.isArray(activity) ? 'ok' : 'warn',
      Array.isArray(activity)
        ? `history contains ${activity.length} activity row(s)`
        : 'history response has no activity array',
    );
  }

  report.probe = {
    base,
    authMode,
    tenant,
    tracking: args.tracking,
    status: { httpStatus: status.status, keys: status.json && typeof status.json === 'object' ? Object.keys(status.json) : [] },
    history: {
      httpStatus: history.status,
      keys: history.json && typeof history.json === 'object' ? Object.keys(history.json) : [],
      activityRows: Array.isArray(history.json?.activity ?? history.json?.data?.activity)
        ? (history.json?.activity ?? history.json?.data?.activity).length
        : 0,
    },
  };
}

async function main() {
  if (args.offline) runOffline();
  else await runLive();

  report.finishedAt = new Date().toISOString();
  report.ok = report.problems.length === 0;

  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2));
  }

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('');
    console.log(
      report.ok
        ? `[SPIKE DHD STATUS SYNC] OK - ${report.findings.length} finding(s), 0 problems.`
        : `[SPIKE DHD STATUS SYNC] BLOCKED - ${report.problems.length} problem(s).`,
    );
  }
}

main()
  .catch((err) => {
    problem(err instanceof Error ? err.message : String(err));
    if (args.json) console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });
