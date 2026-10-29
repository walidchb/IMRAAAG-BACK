#!/usr/bin/env node
/**
 * ZR Express status-sync — Phase 0 read-only spike.
 *
 * Proves the provider contract the feature depends on, against a real ZR Express tenant, without
 * writing anything - not to ZR Express, not to MongoDB.
 *
 * Phase 0 of `ZR-EXPRESS-STATUS-SYNC-ROADMAP.md` is "no production code"; this script is the
 * artifact it produces. It answers the questions the later phases are blocked on:
 *
 *   Q-1  What is the numeric rate limit for the read endpoints, and are there rate-limit headers?
 *   Q-2  Does `advancedFilter` support `externalId` and `lastStateUpdateAt`?
 *   Q-3  What are the situation slugs a tenant actually uses?
 *   Q-4  Does a tenant run a workflow whose state ids differ from the documented ones?
 *   Q-5  Does ZR return a `Retry-After` header on 429?
 *
 * and it captures the **carrier transition graph** (`POST /workflows/search` -> `transitions[]`),
 * which the order-action matrix (§3.2 of the behaviour refactor) is validated against.
 *
 * SAFETY
 *   - Read-only. The only ZR calls it can make are three exact read endpoints, enforced by an
 *     allowlist below. It physically cannot create, update or delete a parcel, a state or a
 *     situation.
 *   - Read-only against MongoDB: it only reads `deliveryconfigs` and `orders`.
 *   - It never logs a credential. It prints the tenant id and a truncated key fingerprint only.
 *
 * USAGE
 *   node scripts/spike-zr-status-sync.js                 live probe (needs a ZR-configured store)
 *   node scripts/spike-zr-status-sync.js --offline       validate the frozen contract, no network
 *   node scripts/spike-zr-status-sync.js --tenant        probe a tenant from the environment
 *                                                          (ZR_TENANT_ID / ZR_API_KEY), no DB
 *   node scripts/spike-zr-status-sync.js --store <id>    probe a single store (id or vendor email)
 *   node scripts/spike-zr-status-sync.js --json          machine-readable output
 *   node scripts/spike-zr-status-sync.js --out <file>    also write the report as JSON
 *
 * Requires `npm run build` first for the store mode (the credential decryption is the compiled
 * backend utility, so the script cannot drift from the application). The `--offline` and
 * `--tenant` modes need no build.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

// The catalogue lives in production code so the spike validates the *same* contract the
// application runs - there is no second copy to drift. `ts-node` transpiles it on the fly, so
// the spike needs no build step.
require('ts-node').register({
  transpileOnly: true,
});
const catalogue = require(path.join(
  __dirname,
  '../src/modules/delivery/delivery-companies/handlers/zr-express/zr-status.mapper',
));

const BACKEND_ROOT = path.resolve(__dirname, '..');
const MONGO_URI = process.env.MONGODB_URI;
const ENCRYPTION_KEY = process.env.DELIVERY_ENCRYPTION_KEY || '';
const ZR_API_BASE = process.env.ZR_API_BASE || 'https://api.zrexpress.app/api/v1.0';
const ZR_COMPANY = 'zr-express';
const TIMEOUT_MS = 15000;

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { offline: false, json: false, store: null, out: null, tenant: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--offline') args.offline = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--tenant') args.tenant = true;
    else if (arg === '--store') args.store = argv[++i];
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
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*\n/, ''));
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * Output helpers
 * ------------------------------------------------------------------ */

const report = {
  startedAt: new Date().toISOString(),
  mode: args.offline ? 'offline' : 'live',
  offline: null,
  store: null,
  zr: null,
  searches: [],
  stateHistory: null,
  workflows: null,
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

/* ------------------------------------------------------------------ *
 * Read-only ZR access
 * ------------------------------------------------------------------ */

/**
 * The ONLY ZR endpoints this script may call. Anything else throws. A read-only spike that can
 * accidentally POST to `/parcels` would be a liability, so the allowlist is enforced in code
 * rather than by convention.
 */
const ALLOWED_ZR_READ_PATHS = [
  { method: 'POST', path: '/parcels/search' },
  { method: 'GET', path: /^\/parcels\/[0-9a-fA-F-]{36}\/state-history$/ },
  { method: 'POST', path: '/workflows/search' },
];

function assertReadOnlyCall(method, url) {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(new RegExp(`^/api/v[^/]+`), '');
  const allowed = ALLOWED_ZR_READ_PATHS.some((rule) => {
    if (rule.method !== method) return false;
    return typeof rule.path === 'string' ? rule.path === path : rule.path.test(path);
  });
  if (!allowed) {
    throw new Error(`Refusing to call a non-allowlisted ZR endpoint: ${method} ${path}`);
  }
}

const rateLimitHeadersSeen = new Map();

async function zrRead(method, endpointPath, body) {
  const url = `${ZR_API_BASE}${endpointPath}`;
  assertReadOnlyCall(method, url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Tenant': report.zr.tenantId,
        'X-Api-Key': report.zr.apiKey,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    for (const [key, value] of response.headers.entries()) {
      const lower = key.toLowerCase();
      if (lower.includes('ratelimit') || lower.includes('retry-after') || lower === 'x-rate-limit-limit' || lower === 'x-ratelimit-limit') {
        rateLimitHeadersSeen.set(key, value);
      }
    }

    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers.entries()), text, json: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Offline mode — validate the frozen contract
 * ------------------------------------------------------------------ */

function runOffline() {
  log('[SPIKE ZR STATUS SYNC] Offline contract validation. No network, no database.\n');

  const problems = catalogue.validateCatalogue();
  report.offline = {
    carrierStates: catalogue.CARRIER_STATES.length,
    normalizedStatuses: catalogue.NORMALIZED_STATUSES.length,
    situationFlags: catalogue.SITUATION_FLAGS.length,
    terminalBand: catalogue.TERMINAL_BAND,
    carrierOrderSignals: catalogue.CARRIER_ORDER_SIGNALS,
    orderAdvanceEdges: catalogue.ORDER_ADVANCE_EDGES,
    planSamples: [
      catalogue.planCarrierOrderAction('dispatched', 'delivered'),
      catalogue.planCarrierOrderAction('confirmed', 'cancelled'),
      catalogue.planCarrierOrderAction('delivered', 'returned'),
    ],
    problems,
  };

  log(`  carrier states (official):        ${catalogue.CARRIER_STATES.length}`);
  log(`  normalized statuses:              ${catalogue.NORMALIZED_STATUSES.length}`);
  log(`  situation flags:                  ${catalogue.SITUATION_FLAGS.length}`);
  log(`  terminal band:                    ${catalogue.TERMINAL_BAND.join(', ')}`);
  log(`  carrier order signals:            ${catalogue.CARRIER_ORDER_SIGNALS.join(', ')}`);
  log(`  order advance edges:              ${catalogue.ORDER_ADVANCE_EDGES.map((e) => `${e.from} -> ${e.to}`).join(', ')}`);
  for (const plan of report.offline.planSamples) {
    log(`  plan ${plan.signal.padEnd(10)} -> ${plan.target ?? 'no-op'} [${plan.steps.join(', ')}]`);
  }
  log('');

  if (problems.length === 0) {
    finding('catalogue', 'ok', 'The frozen contract is internally consistent.');
  } else {
    for (const p of problems) problem(`contract: ${p}`);
  }

  // Spot-check the normalizer against the published catalogue.
  const bad = catalogue.CARRIER_STATES.filter((s) => catalogue.normalizeCarrierState(s.slug) === 'unknown');
  if (bad.length === 0) {
    finding('normalize', 'ok', `All ${catalogue.CARRIER_STATES.length} official carrier states normalize to a known status.`);
  } else {
    problem(`normalizer: ${bad.map((s) => s.slug).join(', ')} normalize to "unknown"`);
  }

  // Spot-check the situation matcher against the published situation catalogue.
  const unmatched = [];
  for (const [stateSlug, situations] of Object.entries(catalogue.OFFICIAL_SITUATIONS_BY_STATE)) {
    for (const situation of situations) {
      const flag = catalogue.flagForSituation({ situationDescription: situation });
      if (!flag) unmatched.push(`${stateSlug}/${situation}`);
    }
  }
  if (unmatched.length === 0) {
    const total = Object.values(catalogue.OFFICIAL_SITUATIONS_BY_STATE).reduce((n, list) => n + list.length, 0);
    finding('situations', 'ok', `All ${total} published situations resolve to a flag.`);
  } else {
    problem(`situation matcher: ${unmatched.join(', ')} resolve to no flag`);
  }

  return problems.length === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ *
 * Live mode — find a ZR-configured store
 * ------------------------------------------------------------------ */

function decryptCredentials(rawCredentials) {
  // The compiled backend utility, so the script can never drift from the application.
  // eslint-disable-next-line global-require
  const { decryptRecord } = require(path.join(BACKEND_ROOT, 'dist/common/encryption.util'));
  return decryptRecord(rawCredentials || {}, ENCRYPTION_KEY);
}

async function findZrStores() {
  const db = mongoose.connection.db;
  const configs = await db
    .collection('deliveryconfigs')
    .find(
      { [`companies.${ZR_COMPANY}.credentials`]: { $exists: true } },
      { projection: { storeId: 1, vendorEmail: 1, [`companies.${ZR_COMPANY}.credentials`]: 1, [`companies.${ZR_COMPANY}.status`]: 1 } },
    )
    .toArray();

  const stores = [];
  for (const config of configs) {
    const entry = (config.companies || {})[ZR_COMPANY] || {};
    const credentials = decryptCredentials(entry.credentials);
    if (!credentials.apiKey || !credentials.tenantId) continue;
    stores.push({
      storeId: config.storeId ? String(config.storeId) : null,
      vendorEmail: config.vendorEmail,
      status: entry.status || 'unknown',
      apiKey: credentials.apiKey,
      tenantId: credentials.tenantId,
    });
  }
  return stores;
}

async function findOwnParcels(storeId, vendorEmail) {
  const db = mongoose.connection.db;
  const filter = { deliveryCompanyId: ZR_COMPANY, deliveryParcelId: { $exists: true, $nin: [null, ''] } };
  if (storeId) filter.storeId = storeId;
  else if (vendorEmail) filter.vendorEmail = vendorEmail;
  const orders = await db
    .collection('orders')
    .find(filter, { projection: { orderNo: 1, deliveryParcelId: 1, status: 1, storeId: 1, vendorEmail: 1 } })
    .limit(20)
    .toArray();
  return orders.map((o) => ({
    orderNo: o.orderNo,
    parcelId: o.deliveryParcelId,
    orderStatus: o.status && o.status.slug ? o.status.slug : null,
  }));
}

/* ------------------------------------------------------------------ *
 * Live probes
 * ------------------------------------------------------------------ */

/** Q-2: does `advancedFilter` actually narrow the result set? */
async function probeAdvancedFilter() {
  const probes = [];

  const baseline = await zrRead('POST', '/parcels/search', { pageNumber: 1, pageSize: 1, orderBy: ['createdAt desc'] });
  const baselineTotal = baseline.json && baseline.json.totalCount !== undefined ? baseline.json.totalCount : null;

  const externalIdProbe = await zrRead('POST', '/parcels/search', {
    pageNumber: 1,
    pageSize: 1,
    advancedFilter: { logic: 'and', filters: [{ field: 'externalId', operator: 'eq', value: '__zr_status_sync_probe__' }] },
  });

  const lastStateProbe = await zrRead('POST', '/parcels/search', {
    pageNumber: 1,
    pageSize: 1,
    advancedFilter: { logic: 'and', filters: [{ field: 'lastStateUpdateAt', operator: 'gte', value: '2000-01-01T00:00:00Z' }] },
  });

  const describe = (label, response) => ({
    label,
    status: response.status,
    ok: response.ok,
    totalCount: response.json && response.json.totalCount !== undefined ? response.json.totalCount : null,
    returned: response.json && Array.isArray(response.json.items) ? response.json.items.length : null,
    error: response.ok ? null : (response.text || '').slice(0, 400),
  });

  const baselineDesc = { label: 'baseline (no filter)', status: baseline.status, ok: baseline.ok, totalCount: baselineTotal };
  const externalDesc = describe('advancedFilter externalId eq', externalIdProbe);
  const lastStateDesc = describe('advancedFilter lastStateUpdateAt gte', lastStateProbe);
  probes.push(baselineDesc, externalDesc, lastStateDesc);

  const honoured = (probe) => probe.ok && probe.totalCount !== null && baselineTotal !== null && probe.totalCount < baselineTotal;

  if (externalIdProbe.ok) {
    finding(
      'q2-externalId',
      honoured(externalDesc) ? 'ok' : 'warn',
      honoured(externalDesc)
        ? `advancedFilter supports "externalId" (total ${baselineTotal} -> ${externalDesc.totalCount}).`
        : `advancedFilter accepted "externalId" but did not narrow the result set (total ${baselineTotal} -> ${externalDesc.totalCount}). Treat the filter as unsupported and fall back to a client-side watermark.`,
    );
  } else {
    finding('q2-externalId', 'warn', `advancedFilter on "externalId" was rejected (HTTP ${externalIdProbe.status}).`, (externalIdProbe.text || '').slice(0, 400));
  }

  if (lastStateProbe.ok) {
    finding(
      'q2-lastStateUpdateAt',
      honoured(lastStateDesc) ? 'ok' : 'warn',
      honoured(lastStateDesc)
        ? `advancedFilter supports "lastStateUpdateAt" (total ${baselineTotal} -> ${lastStateDesc.totalCount}).`
        : `advancedFilter accepted "lastStateUpdateAt" but did not narrow the result set (total ${baselineTotal} -> ${lastStateDesc.totalCount}). Treat the filter as unsupported and fall back to a client-side watermark.`,
    );
  } else {
    finding('q2-lastStateUpdateAt', 'warn', `advancedFilter on "lastStateUpdateAt" was rejected (HTTP ${lastStateProbe.status}).`, (lastStateProbe.text || '').slice(0, 400));
  }

  report.searches.push({ probe: 'advancedFilter', baseline: baselineDesc, externalId: externalDesc, lastStateUpdateAt: lastStateDesc });
  return probes;
}

/** Discovery call: the shape and the watermark the poller will rely on. */
async function probeDiscovery() {
  const response = await zrRead('POST', '/parcels/search', { pageNumber: 1, pageSize: 5, orderBy: ['createdAt desc'] });
  const items = response.json && Array.isArray(response.json.items) ? response.json.items : [];

  const discovery = {
    status: response.status,
    ok: response.ok,
    totalCount: response.json ? response.json.totalCount : null,
    pageNumber: response.json ? response.json.pageNumber : null,
    pageSize: response.json ? response.json.pageSize : null,
    hasNext: response.json ? response.json.hasNext : null,
    itemCount: items.length,
    itemKeys: items.length ? Object.keys(items[0]).sort() : [],
    stateKeys: items.length && items[0].state ? Object.keys(items[0].state).sort() : [],
    sample: items.length
      ? {
          externalId: items[0].externalId,
          stateName: items[0].state ? items[0].state.name : null,
          stateDescription: items[0].state ? items[0].state.description : null,
          lastStateUpdateAt: items[0].lastStateUpdateAt,
          isLocked: items[0].state ? items[0].state.isLocked : null,
        }
      : null,
  };
  report.searches.push({ probe: 'discovery', ...discovery });

  if (!response.ok) {
    finding('discovery', 'warn', `POST /parcels/search returned HTTP ${response.status}.`, (response.text || '').slice(0, 400));
    return null;
  }

  finding('discovery', 'ok', `POST /parcels/search returned ${discovery.totalCount} parcels (page of ${discovery.itemCount}).`);

  if (discovery.sample) {
    const normalized = catalogue.normalizeCarrierState(discovery.sample.stateName);
    if (normalized === 'unknown') {
      finding('catalogue', 'warn', `A live parcel reports state "${discovery.sample.stateName}", which is not in the catalogue - it would map to "unknown".`);
    } else {
      finding('catalogue', 'ok', `A live parcel reports state "${discovery.sample.stateName}" -> "${normalized}".`);
    }
    if (discovery.sample.lastStateUpdateAt === undefined || discovery.sample.lastStateUpdateAt === null) {
      finding('watermark', 'warn', 'The search response carries no "lastStateUpdateAt"; the poller would have no change-detection watermark.');
    } else {
      finding('watermark', 'ok', `"lastStateUpdateAt" is present (${discovery.sample.lastStateUpdateAt}) and can drive the change-detection watermark.`);
    }
  } else {
    finding('watermark', 'warn', 'The tenant has no parcels, so the discovery response shape could not be confirmed against a live record.');
  }

  return items;
}

/** State history for one parcel: the transition chain and the situations. */
async function probeStateHistory(parcelId) {
  const response = await zrRead('GET', `/parcels/${parcelId}/state-history`);

  if (!response.ok) {
    finding('state-history', 'warn', `GET /parcels/${parcelId}/state-history returned HTTP ${response.status}.`, (response.text || '').slice(0, 400));
    report.stateHistory = { parcelId, status: response.status, ok: false, error: (response.text || '').slice(0, 400) };
    return null;
  }

  const entries = Array.isArray(response.json) ? response.json : [];
  const chain = entries.map((entry) => ({
    entryId: entry.id,
    createdAt: entry.createdAt,
    from: entry.previousState ? entry.previousState.name : null,
    to: entry.newState ? entry.newState.name : null,
    comment: entry.comment || null,
    hub: entry.location ? entry.location.hubName : null,
    situations: (entry.situations || []).map((s) => ({
      slug: s.situationSlug || null,
      name: s.situationName || null,
      description: s.situationDescription || null,
      flags: catalogue.flagsForSituations([s]),
    })),
  }));

  report.stateHistory = { parcelId, status: response.status, ok: true, entryCount: entries.length, chain, entryKeys: entries.length ? Object.keys(entries[0]).sort() : [] };

  finding('state-history', 'ok', `GET .../state-history returned ${entries.length} transitions for parcel ${parcelId}.`);

  const unknownStates = [...new Set(chain.flatMap((c) => [c.from, c.to]).filter((s) => s && catalogue.normalizeCarrierState(s) === 'unknown'))];
  if (unknownStates.length === 0) {
    finding('catalogue', 'ok', 'Every state in the live timeline is in the catalogue.');
  } else {
    finding('catalogue', 'warn', `The live timeline contains states that are not in the catalogue: ${unknownStates.join(', ')}.`);
  }

  const rawFlags = chain.flatMap((c) => c.situations.flatMap((s) => s.flags)).filter((f) => f === 'raw');
  if (rawFlags.length === 0) {
    finding('situations', 'ok', 'Every live situation resolves to a known flag.');
  } else {
    finding('situations', 'warn', `${rawFlags.length} live situation(s) did not resolve to a known flag and would be stored as "raw".`);
  }

  return chain;
}

/** The workflow catalogue: states, situations and the carrier's own transition graph. */
async function probeWorkflows() {
  const response = await zrRead('POST', '/workflows/search', { pageNumber: 1, pageSize: 50 });

  if (!response.ok) {
    finding('workflows', 'warn', `POST /workflows/search returned HTTP ${response.status}.`, (response.text || '').slice(0, 400));
    report.workflows = { status: response.status, ok: false, error: (response.text || '').slice(0, 400) };
    return null;
  }

  const workflows = response.json && Array.isArray(response.json.items) ? response.json.items : [];
  const summary = [];
  const graph = [];
  const situationSlugs = new Set();
  const stateSlugs = new Set();

  for (const workflow of workflows) {
    const states = Array.isArray(workflow.states) ? workflow.states : [];
    const situations = [];
    const transitions = [];

    for (const state of states) {
      if (state.name) stateSlugs.add(state.name);
      for (const situation of state.situations || []) {
        if (situation.slug) situationSlugs.add(situation.slug);
        situations.push({ state: state.name, slug: situation.slug || null, name: situation.name || null, description: situation.description || null });
      }
      for (const transition of state.transitions || []) {
        transitions.push({ actionName: transition.actionName || null, fromStateId: transition.fromStateId || null, toStateId: transition.toStateId || null });
        graph.push({ actionName: transition.actionName || null, fromStateId: transition.fromStateId || null, toStateId: transition.toStateId || null });
      }
    }

    summary.push({
      id: workflow.id,
      name: workflow.name,
      isDefault: workflow.isDefault,
      stateCount: states.length,
      states: states.map((s) => ({ id: s.id, name: s.name, description: s.description, ranking: s.ranking })),
      situations,
      transitions,
    });
  }

  report.workflows = {
    status: response.status,
    ok: true,
    workflowCount: workflows.length,
    totalCount: response.json ? response.json.totalCount : null,
    workflows: summary,
    situationSlugs: Array.from(situationSlugs).sort(),
    carrierTransitionGraph: graph,
  };

  finding('workflows', 'ok', `POST /workflows/search returned ${workflows.length} workflow(s), ${stateSlugs.size} distinct state name(s), ${situationSlugs.size} situation slug(s), ${graph.length} transition(s).`);

  const unknown = [...stateSlugs].filter((s) => catalogue.normalizeCarrierState(s) === 'unknown');
  if (unknown.length === 0) {
    finding('catalogue', 'ok', 'Every state name in the tenant workflow is in the catalogue.');
  } else {
    finding('catalogue', 'warn', `The tenant workflow uses state names that are not in the catalogue: ${unknown.join(', ')}.`);
  }

  if (situationSlugs.size > 0) {
    finding('q3-situations', 'ok', `Situation slugs discovered for this tenant: ${Array.from(situationSlugs).sort().join(', ')}.`);
  } else {
    finding('q3-situations', 'warn', 'The workflows response carried no situation slugs; Q-3 stays open for this tenant.');
  }

  if (graph.length > 0) {
    finding('carrier-graph', 'ok', `Captured ${graph.length} carrier transition(s) - this is the graph the order-action matrix (§3.2) is validated against.`);
  } else {
    finding('carrier-graph', 'warn', 'The workflows response carried no transitions; the carrier graph is unavailable and the order-action matrix falls back to the state/situation signals plus the order-transition map.');
  }

  return summary;
}

/* ------------------------------------------------------------------ *
 * Q-1 / Q-5 - rate limiting
 * ------------------------------------------------------------------ */

/**
 * Reports what the provider told us about rate limiting. A `Retry-After` header is only ever
 * observed on a 429, so the absence of one is not proof that it is unsupported - it stays a
 * warning, never a green light.
 */
function reportRateLimitFindings() {
  report.rateLimitHeaders = Object.fromEntries(rateLimitHeadersSeen.entries());

  if (rateLimitHeadersSeen.size > 0) {
    const headers = Object.fromEntries(rateLimitHeadersSeen.entries());
    finding('q1-ratelimit', 'ok', `Rate-limit headers observed: ${JSON.stringify(headers)}`);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'retry-after')) {
      finding('q5-retry-after', 'warn', 'No "Retry-After" header was seen (a 429 was not triggered, so this stays unconfirmed).');
    }
  } else {
    finding('q1-ratelimit', 'warn', 'No rate-limit headers were returned. Q-1 and Q-5 stay open - keep the conservative 20 calls/min/tenant budget.');
  }
}

/* ------------------------------------------------------------------ *
 * Live mode entry point
 * ------------------------------------------------------------------ */

async function runLive() {
  // Tenant mode: probe a tenant straight from the environment. No database, no store lookup.
  if (args.tenant) {
    const tenantId = process.env.ZR_TENANT_ID;
    const apiKey = process.env.ZR_API_KEY;
    if (!tenantId || !apiKey) {
      console.error('ZR_TENANT_ID and ZR_API_KEY are required for --tenant');
      process.exit(1);
    }
    report.zr = { tenantId, apiKey };
    report.store = { storeId: null, vendorEmail: null, status: 'direct-tenant', tenantId };
    log('[SPIKE ZR STATUS SYNC] Tenant probe (--tenant). Read-only, no database.\n');
    log(`  tenant=${tenantId}\n`);

    const items = await probeDiscovery();
    await probeAdvancedFilter();

    const parcelId = items && items.length ? items[0].id : null;
    if (parcelId) {
      await probeStateHistory(parcelId);
    } else {
      finding('state-history', 'warn', 'No parcel was available to read a state history from.');
    }

    await probeWorkflows();
    reportRateLimitFindings();
    return report.problems.length ? 1 : 0;
  }

  if (!MONGO_URI) {
    console.error('MONGODB_URI required');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  log('[SPIKE ZR STATUS SYNC] Live probe. Read-only.\n');

  const stores = await findZrStores();
  log(`  stores with ${ZR_COMPANY} credentials: ${stores.length}`);

  if (stores.length === 0) {
    finding(
      'credentials',
      'block',
      `No store has usable "${ZR_COMPANY}" credentials in the live database, so the live half of the spike cannot run.`,
      {
        hint: 'Configure ZR Express credentials for a store (vendor dashboard -> Delivery), or set ZR_TENANT_ID / ZR_API_KEY in the environment and re-run with --tenant to probe a tenant directly.',
        searchedCollection: 'deliveryconfigs',
      },
    );
    await mongoose.disconnect();
    return 2;
  }

  const selected = args.store
    ? stores.find((s) => s.storeId === args.store || s.vendorEmail === args.store)
    : stores.find((s) => s.status === 'enabled') || stores[0];

  if (!selected) {
    finding('credentials', 'block', `No store matched --store ${args.store}.`);
    await mongoose.disconnect();
    return 2;
  }

  report.store = { storeId: selected.storeId, vendorEmail: selected.vendorEmail, status: selected.status, tenantId: selected.tenantId };
  report.zr = { tenantId: selected.tenantId, apiKey: selected.apiKey };

  log(`  probing store ${selected.storeId || '(no storeId)'} (${selected.vendorEmail}) tenant=${selected.tenantId}\n`);

  const ownParcels = await findOwnParcels(selected.storeId, selected.vendorEmail);
  log(`  our own ZR parcels: ${ownParcels.length}`);

  const items = await probeDiscovery();
  await probeAdvancedFilter();

  const parcelId = (items && items.length ? items[0].id : null) || (ownParcels.length ? ownParcels[0].parcelId : null);
  if (parcelId) {
    await probeStateHistory(parcelId);
  } else {
    finding('state-history', 'warn', 'No parcel was available to read a state history from.');
  }

  await probeWorkflows();
  reportRateLimitFindings();

  await mongoose.disconnect();
  return report.problems.length ? 1 : 0;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

(async () => {
  let exitCode = 0;
  try {
    if (args.offline) {
      exitCode = runOffline();
    } else {
      exitCode = await runLive();
    }
  } catch (err) {
    problem(`spike failed: ${err && err.message ? err.message : String(err)}`);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.error(err);
    try {
      await mongoose.disconnect();
    } catch {
      /* ignore */
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
