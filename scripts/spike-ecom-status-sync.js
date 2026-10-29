#!/usr/bin/env node

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

require('ts-node').register({ transpileOnly: true });

const mapper = require(path.join(
  __dirname,
  '../src/modules/delivery/delivery-companies/handlers/ecom/ecom-status.mapper',
));
const zr = require(path.join(
  __dirname,
  '../src/modules/delivery/delivery-companies/handlers/zr-express/zr-status.mapper',
));

const BACKEND_ROOT = path.resolve(__dirname, '..');
const MONGO_URI = process.env.MONGODB_URI;
const ENCRYPTION_KEY = process.env.DELIVERY_ENCRYPTION_KEY || '';
const ECOM_API_BASE = process.env.ECOM_API_BASE || 'https://ecom-dz.com/api_v2';
const ECOM_COMPANY = 'ecom-delivery';
const TIMEOUT_MS = 15000;

function parseArgs(argv) {
  const args = {
    offline: false,
    json: false,
    tenant: false,
    store: null,
    tracking: null,
    out: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--offline') args.offline = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--tenant') args.tenant = true;
    else if (arg === '--store') args.store = argv[++i];
    else if (arg === '--tracking') args.tracking = argv[++i];
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
      'Usage: node scripts/spike-ecom-status-sync.js [options]',
      '',
      '  --offline            validate the frozen Ecom contract without network or database',
      '  --tenant             probe ECOM_API_KEY / ECOM_API_TOKEN without the database',
      '  --store <id|email>   probe one Ecom-configured store from MongoDB',
      '  --tracking <value>   read one parcel status and history (read-only)',
      '  --json               machine-readable output',
      '  --out <file>         also write the report as JSON',
      '',
      'Live mode never writes to Ecom or MongoDB. It only calls /test, /situations,',
      '/etats-logistiques, POST /colis/statuts and GET /colis/{tracking}.',
    ].join('\n'),
  );
  process.exit(0);
}

const report = {
  startedAt: new Date().toISOString(),
  mode: args.offline ? 'offline' : 'live',
  offline: null,
  store: null,
  catalogs: null,
  tracking: null,
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

const ALLOWED_READ_PATHS = [
  { method: 'GET', path: '/test' },
  { method: 'GET', path: '/situations' },
  { method: 'GET', path: '/etats-logistiques' },
  { method: 'POST', path: '/colis/statuts' },
  { method: 'GET', path: /^\/colis\/[A-Za-z0-9_-]+$/ },
];

function assertReadOnlyCall(method, url) {
  const parsed = new URL(url);
  const prefix = '/api_v2';
  const endpoint = parsed.pathname.startsWith(prefix)
    ? parsed.pathname.slice(prefix.length)
    : parsed.pathname;
  const allowed = ALLOWED_READ_PATHS.some((rule) => {
    if (rule.method !== method) return false;
    return typeof rule.path === 'string' ? rule.path === endpoint : rule.path.test(endpoint);
  });
  if (!allowed) {
    throw new Error(`Refusing to call a non-allowlisted Ecom endpoint: ${method} ${endpoint}`);
  }
}

const quotaHeaders = new Map();

async function ecomRead(credentials, method, endpoint, body) {
  const url = `${ECOM_API_BASE}${endpoint}`;
  assertReadOnlyCall(method, url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'X-API-Key': credentials.key,
        'X-API-Token': credentials.token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    for (const [key, value] of response.headers.entries()) {
      const lower = key.toLowerCase();
      if (
        lower.includes('quota') ||
        lower.includes('retry-after') ||
        lower.includes('ratelimit') ||
        lower === 'x-api-version'
      ) {
        quotaHeaders.set(key, value);
      }
    }

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    return {
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      text,
      json,
    };
  } finally {
    clearTimeout(timer);
  }
}

function offlineSignalVectors() {
  return [
    {
      name: 'current delivered',
      parcel: {
        tracking: 'T1',
        situation: 'Livrée',
        etat_logistique: 'Livrée',
        date_action: '2026-06-10 16:45:00+00:00',
      },
      history: null,
      expected: 'delivered',
    },
    {
      name: 'current in transit',
      parcel: {
        tracking: 'T2',
        situation: 'EnCours',
        etat_logistique: 'Au Bureau',
        date_action: '2026-06-10 12:00:00+00:00',
      },
      history: null,
      expected: 'in_transit',
    },
    {
      name: 'newer history return',
      parcel: {
        tracking: 'T3',
        situation: 'EnCours',
        etat_logistique: 'Au Bureau',
        date_action: '2026-06-10 10:00:00+00:00',
      },
      history: [
        {
          date: '2026-06-10 12:00:00+00:00',
          ville: 16,
          situation: 'Retournée',
          commentaire: null,
        },
      ],
      expected: 'returned',
    },
    {
      name: 'current cancellation',
      parcel: {
        tracking: 'T4',
        situation: 'Commande annulée',
        etat_logistique: 'Commande annulée',
        date_action: '2026-06-10 12:00:00+00:00',
      },
      history: null,
      expected: 'cancelled',
    },
    {
      name: 'older cancellation ignored',
      parcel: {
        tracking: 'T5',
        situation: 'Livrée',
        etat_logistique: 'Livrée',
        date_action: '2026-06-10 18:00:00+00:00',
      },
      history: [
        {
          date: '2026-06-10 12:00:00+00:00',
          ville: 16,
          situation: 'Commande annulée',
          commentaire: null,
        },
      ],
      expected: 'delivered',
    },
    {
      name: 'unknown label',
      parcel: {
        tracking: 'T6',
        situation: 'Nouvelle situation',
        etat_logistique: 'Nouvel état',
        date_action: '2026-06-10 12:00:00+00:00',
      },
      history: null,
      expected: 'none',
    },
    {
      name: 'Récupérer unresolved',
      parcel: {
        tracking: 'T7',
        situation: 'EnCours',
        etat_logistique: 'Récupérer',
        date_action: '2026-06-10 12:00:00+00:00',
      },
      history: null,
      expected: 'none',
    },
    {
      name: 'financial corroboration',
      parcel: {
        tracking: 'T8',
        situation: 'Nouvelle situation',
        etat_logistique: 'Nouvel état',
        date_action: '2026-06-10 12:00:00+00:00',
        encaisser: true,
      },
      history: null,
      expected: 'delivered',
    },
  ];
}

function runOffline() {
  log('[SPIKE ECOM STATUS SYNC] Offline contract validation. No network, no database.\n');

  const problems = mapper.validateEcomCatalogue();
  const vectors = offlineSignalVectors();
  const vectorResults = [];

  for (const vector of vectors) {
    const detection = mapper.detectEcomOrderSignal(vector.parcel, vector.history);
    vectorResults.push({
      name: vector.name,
      expected: vector.expected,
      actual: detection.signal,
      source: detection.source,
    });
    if (detection.signal !== vector.expected) {
      problems.push(
        `signal vector "${vector.name}" expected "${vector.expected}" but got "${detection.signal}"`,
      );
    }
  }

  const planChecks = [
    ['dispatched', 'in_transit', 'in-transit', ['in-transit']],
    ['dispatched', 'delivered', 'delivered', ['in-transit', 'delivered']],
    ['in-transit', 'delivered', 'delivered', ['delivered']],
    ['confirmed', 'cancelled', 'cancelled', ['cancelled']],
    ['dispatched', 'returned', 'returned', ['returned']],
    ['delivered', 'cancelled', null, []],
  ];
  const planResults = [];

  for (const [current, signal, target, steps] of planChecks) {
    const plan = zr.planCarrierOrderAction(current, signal);
    planResults.push({ current, signal, target: plan.target, steps: plan.steps });
    if (plan.target !== target || plan.steps.join(',') !== steps.join(',')) {
      problems.push(
        `plan vector (${current}, ${signal}) expected ${target ?? 'no-op'} [${steps.join(', ')}] but got ${plan.target ?? 'no-op'} [${plan.steps.join(', ')}]`,
      );
    }
  }

  const history = [
    {
      date: '2026-06-09 09:12:00+00:00',
      ville: 16,
      situation: 'En Préparation',
      commentaire: 'Création Api_v2',
    },
    {
      date: '2026-06-09 14:30:00+00:00',
      ville: 16,
      situation: 'Au Bureau',
      commentaire: null,
    },
    {
      date: '2026-06-10 16:45:00+00:00',
      ville: 16,
      situation: 'Livrée',
      commentaire: 'Remis au client',
    },
  ];
  const first = mapper.mapEcomHistoryEntries('ECBGE309', history);
  const second = mapper.mapEcomHistoryEntries('ECBGE309', history);

  if (first.length !== history.length) {
    problems.push(`timeline mapping expected ${history.length} entries but got ${first.length}`);
  }
  if (first[1].providerEntryId !== second[1].providerEntryId) {
    problems.push('timeline providerEntryId is not deterministic for identical input');
  }
  if (first[1].providerEntryId.length !== 40) {
    problems.push('timeline providerEntryId is not the expected 40-character hash');
  }
  if (first[2].toStatus !== 'delivered') {
    problems.push(`timeline delivered entry normalized to "${first[2].toStatus}"`);
  }

  report.offline = {
    rules: mapper.ECOM_STATUS_RULES.length,
    unresolved: mapper.ECOM_UNRESOLVED_LABELS,
    signalVectors: vectorResults,
    planVectors: planResults,
    timeline: first.map((entry) => ({
      providerEntryId: entry.providerEntryId,
      toState: entry.toState,
      toStatus: entry.toStatus,
    })),
    problems,
  };

  log(`  status rules:                     ${mapper.ECOM_STATUS_RULES.length}`);
  log(`  unresolved labels:                ${mapper.ECOM_UNRESOLVED_LABELS.join(', ')}`);
  log(`  signal vectors checked:           ${vectorResults.length}`);
  log(`  plan vectors checked:             ${planResults.length}`);
  log(`  timeline entries checked:         ${first.length}`);
  log('');

  if (problems.length === 0) {
    finding('offline-contract', 'ok', 'The offline Ecom contract is internally consistent.');
  } else {
    for (const item of problems) problem(`contract: ${item}`);
  }

  return problems.length === 0 ? 0 : 1;
}

function decryptCredentials(rawCredentials) {
  const { decryptRecord } = require(path.join(BACKEND_ROOT, 'dist/common/encryption.util'));
  return decryptRecord(rawCredentials || {}, ENCRYPTION_KEY);
}

function fingerprint(key, token) {
  return crypto.createHash('sha256').update(`${key}:${token}`).digest('hex').slice(0, 16);
}

async function findEcomStores() {
  const db = mongoose.connection.db;
  const configs = await db
    .collection('deliveryconfigs')
    .find(
      { [`companies.${ECOM_COMPANY}.credentials`]: { $exists: true } },
      {
        projection: {
          storeId: 1,
          vendorEmail: 1,
          [`companies.${ECOM_COMPANY}.credentials`]: 1,
          [`companies.${ECOM_COMPANY}.status`]: 1,
          [`companies.${ECOM_COMPANY}.statusSyncEnabled`]: 1,
        },
      },
    )
    .toArray();

  const stores = [];
  for (const config of configs) {
    const company = (config.companies || {})[ECOM_COMPANY] || {};
    let credentials;
    try {
      credentials = decryptCredentials(company.credentials);
    } catch {
      continue;
    }
    if (!credentials.key || !credentials.token) continue;
    stores.push({
      storeId: config.storeId ? String(config.storeId) : null,
      vendorEmail: config.vendorEmail || null,
      status: company.status || 'unknown',
      statusSyncEnabled: company.statusSyncEnabled !== false,
      key: credentials.key,
      token: credentials.token,
      fingerprint: fingerprint(credentials.key, credentials.token),
    });
  }
  return stores;
}

async function findOwnTracking(store) {
  const db = mongoose.connection.db;
  const filter = {
    deliveryCompanyId: ECOM_COMPANY,
    deliveryParcelId: { $exists: true, $nin: [null, ''] },
  };
  if (store.storeId || store.vendorEmail) {
    filter.$or = [
      ...(store.storeId ? [{ storeId: store.storeId }] : []),
      ...(store.vendorEmail ? [{ vendorEmail: store.vendorEmail }] : []),
    ];
  }
  const order = await db
    .collection('orders')
    .find(
      filter,
      { projection: { orderNo: 1, deliveryParcelId: 1, status: 1, storeId: 1, vendorEmail: 1 } },
    )
    .sort({ _id: -1 })
    .limit(1)
    .next();
  return order
    ? {
        orderNo: order.orderNo || null,
        tracking: order.deliveryParcelId,
        orderStatus: order.status && order.status.slug ? order.status.slug : null,
      }
    : null;
}

async function probeCatalog(credentials) {
  const result = { situations: null, etatsLogistiques: null };
  const probes = [
    ['situations', '/situations'],
    ['etatsLogistiques', '/etats-logistiques'],
  ];

  for (const [key, endpoint] of probes) {
    const response = await ecomRead(credentials, 'GET', endpoint);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        problem(`Ecom rejected the credentials on GET ${endpoint} (HTTP ${response.status}).`);
      }
      finding(
        key,
        'warn',
        `GET ${endpoint} returned HTTP ${response.status}.`,
        (response.text || '').slice(0, 400),
      );
      result[key] = { status: response.status, ok: false };
      continue;
    }

    const entries = Array.isArray(response.json) ? response.json : [];
    const labels = entries
      .map((entry) => entry && entry.libelle)
      .filter((label) => typeof label === 'string');
    const unknown = labels.filter((label) => mapper.normalizeEcomStatus(label) === 'unknown');
    const unresolved = labels.filter(
      (label) => mapper.normalizeEcomStatus(label) === 'unknown' && mapper.ecomStatusRule(label),
    );

    result[key] = {
      status: response.status,
      ok: true,
      count: labels.length,
      labels,
      unknown,
      unresolved,
    };

    finding(key, unknown.length ? 'warn' : 'ok', `GET ${endpoint} returned ${labels.length} label(s).`);
    if (unknown.length) {
      finding(
        `${key}-unknown`,
        'warn',
        `Unmapped labels: ${unknown.join(', ')}.`,
        'Add only after the carrier confirms their meaning.',
      );
    }
    if (unresolved.length) {
      finding(
        `${key}-unresolved`,
        'warn',
        `Explicitly unresolved labels: ${unresolved.join(', ')}.`,
      );
    }
  }

  return result;
}

async function probeTracking(credentials, tracking) {
  const result = {
    tracking,
    status: null,
    detail: null,
    normalized: null,
    signal: null,
    history: null,
    plan: null,
  };

  const statusResponse = await ecomRead(credentials, 'POST', '/colis/statuts', {
    trackings: [tracking],
  });
  result.status = {
    status: statusResponse.status,
    ok: statusResponse.ok,
    error: statusResponse.ok ? null : (statusResponse.text || '').slice(0, 400),
  };

  if (!statusResponse.ok) {
    if (statusResponse.status === 401 || statusResponse.status === 403) {
      problem(
        `Ecom rejected the credentials on POST /colis/statuts (HTTP ${statusResponse.status}).`,
      );
    }
    finding('status', 'warn', `POST /colis/statuts returned HTTP ${statusResponse.status}.`);
    return result;
  }

  const parcel =
    (Array.isArray(statusResponse.json?.trackings) && statusResponse.json.trackings[0]) || null;
  if (!parcel) {
    finding('status', 'warn', 'POST /colis/statuts returned no tracking entry.');
    return result;
  }
  if (parcel.trouve === false) {
    finding('status', 'warn', `Tracking ${tracking} was not found for this account.`);
    return result;
  }

  const detailResponse = await ecomRead(
    credentials,
    'GET',
    `/colis/${encodeURIComponent(tracking)}`,
  );
  const detail = detailResponse.ok ? detailResponse.json : null;
  const history = detail && Array.isArray(detail.historique) ? detail.historique : [];
  const mapped = mapper.mapEcomParcel(parcel);
  const detection = mapper.detectEcomOrderSignal(parcel, history);
  const timeline = mapper.mapEcomHistoryEntries(tracking, history);
  const plan = zr.planCarrierOrderAction('dispatched', detection);

  result.status = {
    status: statusResponse.status,
    ok: true,
    keys: Object.keys(parcel).sort(),
    situation: parcel.situation ?? null,
    id_situation: parcel.id_situation ?? null,
    etat_logistique: parcel.etat_logistique ?? null,
    id_etat_logistique: parcel.id_etat_logistique ?? null,
    date_action: parcel.date_action ?? null,
    encaisser: parcel.encaisser ?? null,
    recouvert: parcel.recouvert ?? null,
    trouve: parcel.trouve ?? null,
  };
  result.detail = {
    status: detailResponse.status,
    ok: detailResponse.ok,
    error: detailResponse.ok ? null : (detailResponse.text || '').slice(0, 400),
    historyCount: history.length,
  };
  result.normalized = {
    deliveryStatus: mapped.deliveryStatus,
    terminal: mapped.terminal,
    carrierStateId: mapped.carrierStateId,
    carrierStateName: mapped.carrierStateName,
    deliveryType: mapped.deliveryType,
  };
  result.signal = detection;
  result.history = timeline.map((entry) => ({
    providerEntryId: entry.providerEntryId,
    at: entry.at,
    fromState: entry.fromState,
    toState: entry.toState,
    fromStatus: entry.fromStatus,
    toStatus: entry.toStatus,
    comment: entry.comment,
    hubCity: entry.hubCity,
  }));
  result.plan = plan;

  finding(
    'status',
    'ok',
    `Tracking ${tracking} -> ${mapped.deliveryStatus}, signal ${detection.signal} (${detection.source}).`,
  );
  if (mapped.carrierStateDescription === 'Récupérer') {
    finding(
      'recuperer',
      'warn',
      'The live parcel is in Récupérer; its meaning is still unresolved and it produces no order signal.',
    );
  }
  if (history.length === 0) {
    finding('history', 'warn', 'The parcel detail returned no history.');
  } else {
    finding('history', 'ok', `The parcel detail returned ${history.length} history entrie(s).`);
  }

  return result;
}

function reportQuotaHeaders() {
  report.quotaHeaders = Object.fromEntries(quotaHeaders.entries());
  if (quotaHeaders.size === 0) {
    finding(
      'quota',
      'warn',
      'No quota or Retry-After headers were observed. Keep the conservative 20 calls/min budget.',
    );
  } else {
    finding('quota', 'ok', `Observed headers: ${JSON.stringify(report.quotaHeaders)}`);
  }
}

async function runLive() {
  let credentials;
  let store;
  let selectedTracking = args.tracking || process.env.ECOM_TRACKING || null;

  if (args.tenant) {
    const key = process.env.ECOM_API_KEY;
    const token = process.env.ECOM_API_TOKEN;
    if (!key || !token) {
      console.error('ECOM_API_KEY and ECOM_API_TOKEN are required for --tenant');
      process.exit(1);
    }
    credentials = { key, token };
    store = {
      storeId: null,
      vendorEmail: null,
      status: 'direct-tenant',
      statusSyncEnabled: true,
      fingerprint: fingerprint(key, token),
    };
    log('[SPIKE ECOM STATUS SYNC] Tenant probe. Read-only, no database.\n');
  } else {
    if (!MONGO_URI) {
      console.error('MONGODB_URI is required unless --tenant is used');
      process.exit(1);
    }

    await mongoose.connect(MONGO_URI);
    log('[SPIKE ECOM STATUS SYNC] Live probe. Read-only.\n');

    const stores = await findEcomStores();
    log(`  stores with ${ECOM_COMPANY} credentials: ${stores.length}`);

    if (stores.length === 0) {
      finding(
        'credentials',
        'block',
        `No store has usable "${ECOM_COMPANY}" credentials, so the live probe cannot run.`,
        {
          hint: 'Configure Ecom Delivery credentials for a store, or set ECOM_API_KEY / ECOM_API_TOKEN and use --tenant.',
          searchedCollection: 'deliveryconfigs',
        },
      );
      await mongoose.disconnect();
      return 2;
    }

    store = args.store
      ? stores.find(
          (candidate) =>
            candidate.storeId === args.store || candidate.vendorEmail === args.store,
        )
      : stores.find((candidate) => candidate.status === 'enabled') || stores[0];

    if (!store) {
      finding('credentials', 'block', `No store matched --store ${args.store}.`);
      await mongoose.disconnect();
      return 2;
    }

    credentials = { key: store.key, token: store.token };
  }

  report.store = {
    storeId: store.storeId,
    vendorEmail: store.vendorEmail,
    status: store.status,
    statusSyncEnabled: store.statusSyncEnabled,
    fingerprint: store.fingerprint,
  };

  const test = await ecomRead(credentials, 'GET', '/test');
  if (!test.ok && (test.status === 401 || test.status === 403)) {
    problem(`Ecom rejected the credentials on GET /test (HTTP ${test.status}).`);
  }
  finding(
    'test',
    test.ok ? 'ok' : 'warn',
    `GET /test returned HTTP ${test.status}.`,
    test.ok ? undefined : (test.text || '').slice(0, 400),
  );

  report.catalogs = await probeCatalog(credentials);

  if (!selectedTracking && store.storeId !== null) {
    const own = await findOwnTracking(store);
    selectedTracking = own?.tracking ?? null;
    if (own) {
      log(`  using order ${own.orderNo} tracking ${own.tracking}\n`);
    }
  } else if (!selectedTracking && store.vendorEmail) {
    const own = await findOwnTracking(store);
    selectedTracking = own?.tracking ?? null;
    if (own) {
      log(`  using order ${own.orderNo} tracking ${own.tracking}\n`);
    }
  }

  if (!selectedTracking) {
    finding(
      'tracking',
      'warn',
      'No test tracking was supplied or found. Status and history probes were skipped.',
    );
  } else {
    report.tracking = await probeTracking(credentials, selectedTracking);
  }

  reportQuotaHeaders();

  if (MONGO_URI && mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  return report.problems.length ? 1 : 0;
}

(async () => {
  let exitCode = 0;
  try {
    exitCode = args.offline ? runOffline() : await runLive();
  } catch (error) {
    problem(`spike failed: ${error && error.message ? error.message : String(error)}`);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.error(error);
    try {
      await mongoose.disconnect();
    } catch {
      void 0;
    }
    process.exit(1);
  }

  report.finishedAt = new Date().toISOString();
  report.exitCode = exitCode;

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8');
    if (!args.json) console.log(`\n  report written to ${args.out}`);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    log('');
    log(`  problems: ${report.problems.length}`);
    log(`  findings: ${report.findings.length}`);
  }

  process.exit(exitCode);
})();
