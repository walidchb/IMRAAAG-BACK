require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

/**
 * DHD / ECOTRACK delivery status sync, Phase D7 — read-only verification.
 *
 * Live mode proves the deployed data against the rules the application actually applies:
 * indexes, tenant scoping, the frozen status/signal catalogue, timeline ordering, terminal /
 * return-watch / conflict state, order consistency, dark-advance safety, and the absence of a
 * credential in any record field. It never writes to MongoDB and never prints a secret.
 *
 * Offline mode (`--offline`) runs the same mapper against the synthetic D0 fixtures, so the
 * command is useful before credentials exist.
 *
 * Requires `npm run build` first.
 *
 * Run: node scripts/verify-dhd-status-sync.js [--offline]
 */

const OFFLINE = process.argv.includes('--offline');
const MONGO_URI = process.env.MONGODB_URI;

if (!OFFLINE && !MONGO_URI) {
  console.error('MONGODB_URI required (or pass --offline)');
  process.exit(1);
}

let mapper;
let profile;
let parcelStatusSchema;
let leaseSchema;
let constants;
let carrier;
try {
  mapper = require('../dist/modules/delivery/delivery-companies/handlers/dhd/dhd-status.mapper');
  ({ DHD_STATUS_PROFILE: profile } = require(
    '../dist/modules/delivery/delivery-companies/handlers/dhd/dhd-status.profile',
  ));
  ({ DeliveryParcelStatusSchema: parcelStatusSchema } = require(
    '../dist/modules/delivery/schemas/delivery-parcel-status.schema',
  ));
  ({ SyncLeaseSchema: leaseSchema } = require('../dist/modules/delivery/schemas/sync-lease.schema'));
  constants = require('../dist/common/constants/delivery-status.const');
  carrier = require('../dist/modules/delivery/delivery-status/carrier/carrier-signal');
} catch (error) {
  console.error('Could not load the compiled sources. Run `npm run build` first.');
  console.error(error.message);
  process.exit(1);
}

const COMPANY_ID = profile.companyId;
const FEATURE_ON = String(process.env.DHD_STATUS_SYNC_ENABLED ?? '').toLowerCase() === 'true';
const UTC_OFFSET = process.env.DHD_STATUS_UTC_OFFSET || '+01:00';
const NORMALIZED = new Set(carrier.NORMALIZED_STATUSES);
const SIGNALS = new Set(carrier.CARRIER_ORDER_SIGNALS);
const SIGNAL_SOURCES = new Set(['state', 'situation', 'override', 'none']);
const TRACKED_ORDER_STATUSES = new Set(constants.DELIVERY_STATUS_TRACKED_ORDER_STATUSES);
const CONFLICT_CODES = new Set(constants.DELIVERY_STATUS_CONFLICT_CODE_VALUES);
/** The delivered band, after which the return watch applies. */
const DELIVERY_COMPLETE_STATUSES = new Set(['delivered', 'cash_collected', 'settled']);
/** Terminal at the carrier immediately. */
const IMMEDIATELY_TERMINAL_STATUSES = new Set(['cancelled', 'returned']);

const violations = [];

function report(rule, detail) {
  violations.push({ rule, detail });
  console.log(`  FAIL  [${rule}] ${detail}`);
}
function ok(rule, msg) {
  console.log(`  ok    [${rule}] ${msg}`);
}

const CREDENTIAL_PATTERNS = [
  /api[-_]?key/i,
  /apikey/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /authorization/i,
  /bearer\s/i,
  /x-api-key/i,
  /x-api-token/i,
  /access[-_]?token/i,
  /refresh[-_]?token/i,
  /private[-_]?key/i,
  /(^|[._])token$/i,
];

function findCredentials(value, valuePath, found) {
  if (value === null || value === undefined) return found;

  if (typeof value === 'string') {
    for (const pattern of CREDENTIAL_PATTERNS) {
      if (pattern.test(value)) {
        found.push(`${valuePath} = ${value.slice(0, 40)}`);
        break;
      }
    }
    return found;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => findCredentials(item, `${valuePath}[${index}]`, found));
    return found;
  }

  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      for (const pattern of CREDENTIAL_PATTERNS) {
        if (pattern.test(key)) {
          found.push(`${valuePath}.${key}`);
          break;
        }
      }
      findCredentials(nested, `${valuePath}.${key}`, found);
    }
  }

  return found;
}

/** `Order.status` is either a slug string or an embedded `{ slug }` object. */
function orderSlug(order) {
  if (!order?.status) return null;
  if (typeof order.status === 'string') return order.status;
  return order.status.slug ?? null;
}

function newestActivity(activities, utcOffset) {
  let newest = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const entry of Array.isArray(activities) ? activities : []) {
    if (String(entry?.status ?? '').trim().toLowerCase() === 'notification on order') continue;
    const at = mapper.parseDhdInstant(entry?.date, entry?.time, utcOffset)?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (newest === null || at >= newestAt) {
      newest = entry;
      newestAt = at;
    }
  }
  return newest;
}

/** The raw label that `mapDhdParcel` used: the parcel state, else the newest activity. */
function rawCarrierLabel(record, utcOffset) {
  const raw = record.rawSituation || {};
  if (typeof raw.status === 'string' && raw.status.trim()) return raw.status;
  const newest = newestActivity(raw.activity, utcOffset);
  if (newest && typeof newest.status === 'string' && newest.status.trim()) return newest.status;
  return record.carrierStateDescription || record.carrierStateName || '';
}

/** Recompute the normalized status from the stored raw labels under the store's overrides. */
function expectedStatus(record, overrides) {
  return mapper.normalizeDhdStatus(rawCarrierLabel(record, UTC_OFFSET), overrides);
}

/** Recompute the order signal under the store's signal overrides. */
function expectedSignal(record, signalOverrides) {
  const raw = record.rawSituation || {};
  return mapper.detectDhdOrderSignal(
    {
      tracking: record.parcelId,
      status: rawCarrierLabel(record, UTC_OFFSET),
      activity: Array.isArray(raw.activity) ? raw.activity : [],
    },
    [],
    signalOverrides,
    { utcOffset: UTC_OFFSET },
  );
}

function loadFixture() {
  const fixturePath = path.resolve(__dirname, 'fixtures/dhd-status/synthetic-fixtures.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  if (fixture.synthetic !== true) {
    throw new Error(`${fixturePath} is not marked synthetic`);
  }
  return fixture;
}

function runOffline() {
  const fixture = loadFixture();
  console.log(`[VERIFY DHD STATUS SYNC] Offline fixtures. Provider: ${COMPANY_ID}.\n`);

  for (const vector of fixture.parcels) {
    const status = mapper.normalizeDhdStatus(vector.status);
    if (status !== vector.expectedStatus) {
      report('offline-status', `"${vector.status}" normalized to "${status}", expected "${vector.expectedStatus}"`);
    }
    const detected = mapper.detectDhdOrderSignal(
      { tracking: 'OFFLINE', status: vector.status },
      [],
      null,
      { utcOffset: UTC_OFFSET },
    );
    if (detected.signal !== vector.expectedSignal) {
      report(
        'offline-signal',
        `"${vector.status}" signalled "${detected.signal}" (${detected.source}), expected "${vector.expectedSignal}"`,
      );
    }
  }

  for (const vector of fixture.activities) {
    const status = mapper.normalizeDhdStatus(vector.status);
    if (status !== vector.expectedStatus) {
      report('offline-activity-status', `"${vector.status}" normalized to "${status}", expected "${vector.expectedStatus}"`);
    }
    const detected = mapper.detectDhdOrderSignal(
      { tracking: 'OFFLINE', status: '', activity: [{ status: vector.status, date: '2026-10-23', time: '10:00:00' }] },
      [],
      null,
      { utcOffset: UTC_OFFSET },
    );
    if (detected.signal !== vector.expectedSignal) {
      report(
        'offline-activity-signal',
        `"${vector.status}" signalled "${detected.signal}" (${detected.source}), expected "${vector.expectedSignal}"`,
      );
    }
  }

  if (fixture.rateLimit?.httpStatus !== 429) {
    report('offline-rate-limit', 'the fixture does not describe the documented 429 rate limit');
  }

  const vectors = fixture.parcels.length + fixture.activities.length;
  ok(
    'offline-fixtures',
    `${vectors} vector(s), ${fixture.parcels.length} state(s), ${fixture.activities.length} activity value(s)`,
  );
}

async function runLive() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const collection = db.collection('deliveryparcelstatuses');
  const leaseCollection = db.collection('syncleases');
  const configCollection = db.collection('deliveryconfigs');
  const orderCollection = db.collection('orders');

  console.log(`[VERIFY DHD STATUS SYNC] Connected. Provider: ${COMPANY_ID}. Feature flag: ${FEATURE_ON ? 'ON' : 'OFF'}.\n`);

  const existingCollections = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name),
  );

  for (const [schema, target, label] of [
    [parcelStatusSchema, collection, 'deliveryparcelstatuses'],
    [leaseSchema, leaseCollection, 'syncleases'],
  ]) {
    if (!existingCollections.has(label)) {
      ok('index-present', `${label}: the collection does not exist yet — nothing to check`);
      continue;
    }

    const declared = schema.indexes();
    const existing = await target.indexes();
    const existingKeys = new Set(existing.map((index) => JSON.stringify(index.key)));

    for (const [keys, options] of declared) {
      const key = JSON.stringify(keys);
      if (!existingKeys.has(key)) {
        report('index-present', `${label} is missing the declared index ${key}`);
        continue;
      }
      const found = existing.find((index) => JSON.stringify(index.key) === key);
      if (options?.unique && !found.unique) {
        report('index-unique', `the index ${key} on ${label} is not unique`);
        continue;
      }
      ok('index-present', `${label}: ${key}${options?.unique ? ' (unique)' : ''}`);
    }
  }

  if (existingCollections.has('deliveryparcelstatuses')) {
    const legacyKeys = new Set([
      JSON.stringify({ storeId: 1, parcelId: 1 }),
      JSON.stringify({ storeId: 1, parcelId: -1 }),
    ]);
    const legacy = (await collection.indexes()).find((index) => legacyKeys.has(JSON.stringify(index.key)));
    if (legacy) {
      report(
        'legacy-index',
        `the pre-companyId index ${JSON.stringify(legacy.key)} still exists — drop it before rollout`,
      );
    } else {
      ok('legacy-index', 'no legacy {storeId, parcelId} index');
    }
  }

  if (existingCollections.has('syncleases')) {
    const leaseKey = constants.deliveryStatusLeaseKey(COMPANY_ID);
    const leases = await leaseCollection.find({ key: leaseKey }).toArray();
    if (leases.length > 1) {
      report('lease-singleton', `${leases.length} "${leaseKey}" lease documents exist — expected at most 1`);
    } else {
      ok('lease-singleton', `${leases.length} "${leaseKey}" lease document(s)`);
    }
  }

  const configs = await configCollection.find({}).toArray();
  const configByStore = new Map();
  for (const config of configs) {
    if (!config.storeId) continue;
    const company = (config.companies || {})[COMPANY_ID];
    configByStore.set(String(config.storeId), {
      company,
      paused:
        config.statusSyncEnabled === false ||
        (company && company.statusSyncEnabled === false),
      configured: Boolean(
        company &&
          company.status === 'enabled' &&
          company.credentials &&
          company.credentials.apiToken,
      ),
      overrides: (config.statusStateOverrides || {})[COMPANY_ID] || {},
      signalOverrides: (config.statusSignalOverrides || {})[COMPANY_ID] || {},
    });
  }

  const records = existingCollections.has('deliveryparcelstatuses')
    ? await collection.find({ companyId: COMPANY_ID }).toArray()
    : [];
  console.log(`\n  ${records.length} ${COMPANY_ID} parcel-status record(s)\n`);

  const recordByOrder = new Map();
  let advancedWhileOff = 0;

  for (const record of records) {
    const label = `${record.parcelId} (store ${record.storeId})`;
    const config = configByStore.get(String(record.storeId));
    const overrides = config?.overrides || {};
    const signalOverrides = config?.signalOverrides || {};

    if (!record.storeId) {
      report('store-scope', `${label}: the record carries no storeId`);
    }
    if (record.companyId !== COMPANY_ID) {
      report('company', `${label}: the record belongs to "${record.companyId}", not "${COMPANY_ID}"`);
    }

    if (!NORMALIZED.has(record.deliveryStatus)) {
      report('normalized-catalogue', `${label}: "${record.deliveryStatus}" is not a known normalized status`);
    } else if (record.carrierStateName || record.carrierStateDescription || record.rawSituation) {
      const expected = expectedStatus(record, overrides);
      if (expected !== record.deliveryStatus) {
        report(
          'normalized-status',
          `${label}: the carrier labels normalize to "${expected}" but the record stores "${record.deliveryStatus}"`,
        );
      }
    }

    const timeline = Array.isArray(record.timeline) ? record.timeline : [];
    const ids = timeline.map((entry) => entry.providerEntryId);
    if (new Set(ids).size !== ids.length) {
      report('timeline-duplicates', `${label}: the timeline holds duplicate providerEntryIds`);
    }
    for (let index = 1; index < timeline.length; index += 1) {
      const previous = new Date(timeline[index - 1].at).getTime();
      const current = new Date(timeline[index].at).getTime();
      if (Number.isNaN(previous) || Number.isNaN(current) || current < previous) {
        report('timeline-order', `${label}: the timeline is not ordered at index ${index}`);
        break;
      }
    }

    if (record.orderSignal && !SIGNALS.has(record.orderSignal)) {
      report('signal', `${label}: the signal "${record.orderSignal}" is not in the frozen catalogue`);
    }
    if (record.signalSource && !SIGNAL_SOURCES.has(record.signalSource)) {
      report('signal-source', `${label}: the source "${record.signalSource}" is not one of state/situation/override/none`);
    }
    if (record.orderSignal) {
      const expected = expectedSignal(record, signalOverrides);
      if (expected.signal !== record.orderSignal) {
        report(
          'signal-recompute',
          `${label}: the carrier labels signal "${expected.signal}" (${expected.source}), but the record stores "${record.orderSignal}"`,
        );
      }
      if (record.signalSource && expected.source !== record.signalSource) {
        report(
          'signal-source-recompute',
          `${label}: the carrier labels source "${expected.source}", but the record stores "${record.signalSource}"`,
        );
      }
    }

    if (IMMEDIATELY_TERMINAL_STATUSES.has(record.deliveryStatus)) {
      if (record.terminal !== true) {
        report('terminal', `${label}: "${record.deliveryStatus}" is terminal at the carrier but the record is not terminal`);
      }
    } else if (record.terminal === true && !DELIVERY_COMPLETE_STATUSES.has(record.deliveryStatus)) {
      report('terminal', `${label}: the record is terminal but the carrier status is "${record.deliveryStatus}"`);
    }

    const watch = record.returnWatchUntil ? new Date(record.returnWatchUntil).getTime() : null;
    if (watch !== null && Number.isNaN(watch)) {
      report('return-watch', `${label}: returnWatchUntil is not a usable date`);
    } else if (watch !== null && watch > Date.now()) {
      const status = record.deliveryStatus;
      if (IMMEDIATELY_TERMINAL_STATUSES.has(status)) {
        if (record.terminal !== true) {
          report('return-watch', `${label}: "${status}" is terminal but the record is not terminal while a watch date is still set`);
        }
      } else if (DELIVERY_COMPLETE_STATUSES.has(status)) {
        if (record.terminal === true) {
          report('return-watch', `${label}: the return watch is still running but the record is terminal`);
        }
      } else {
        report('return-watch', `${label}: a future return watch is attached to the non-terminal status "${status}"`);
      }
    }

    if (record.conflict) {
      if (!CONFLICT_CODES.has(record.conflict)) {
        report('conflict-code', `${label}: the conflict "${record.conflict}" is not a known conflict code`);
      }
      const at = record.conflictAt ? new Date(record.conflictAt).getTime() : NaN;
      if (Number.isNaN(at)) {
        report('conflict-at', `${label}: the conflict carries no usable timestamp`);
      }
    } else if (record.conflictAt) {
      report('conflict-at', `${label}: the record carries a conflict timestamp without a conflict code`);
    }

    const storeIds = [record.storeId];
    if (mongoose.Types.ObjectId.isValid(String(record.storeId ?? ''))) {
      storeIds.push(new mongoose.Types.ObjectId(String(record.storeId)));
    }
    const order = await orderCollection.findOne(
      { _id: record.orderId, storeId: { $in: storeIds } },
      {
        projection: {
          orderNo: 1,
          storeId: 1,
          status: 1,
          deliveryParcelId: 1,
          deliveryCompanyId: 1,
          history: 1,
        },
      },
    );
    if (!order) {
      report('order-link', `${label}: the order ${record.orderId} does not resolve in this store`);
    } else {
      recordByOrder.set(String(order._id), record);
      if (order.deliveryParcelId && String(order.deliveryParcelId) !== String(record.parcelId)) {
        report(
          'order-link',
          `${label}: the order points at parcel "${order.deliveryParcelId}", not "${record.parcelId}"`,
        );
      }

      const slug = orderSlug(order);
      if (record.deliveryStatus === 'delivered' && slug && !['dispatched', 'in-transit', 'delivered', 'returned'].includes(slug)) {
        report('order-consistency', `${label}: the carrier delivered the parcel but the order is "${slug}"`);
      }
      if (slug === 'delivered' && !['delivered', 'cash_collected', 'settled', 'returned'].includes(record.deliveryStatus)) {
        report('order-consistency', `${label}: the order is "delivered" but the carrier's status is "${record.deliveryStatus}"`);
      }

      if (!FEATURE_ON) {
        const carrierHistory = (order.history || []).filter(
          (entry) =>
            entry &&
            (entry.user === profile.historyUser || entry.user === profile.systemActor),
        );
        if (carrierHistory.length > 0) {
          report(
            'dark-advance',
            `${label}: the order carries ${carrierHistory.length} carrier-driven history entr(y/ies) while DHD sync is off`,
          );
        }
      }
    }

    if (!FEATURE_ON && record.lastOrderActionAt) {
      advancedWhileOff += 1;
    }

    const credentials = findCredentials(record, 'record', []);
    if (credentials.length > 0) {
      report('no-credential', `${label}: ${credentials.join(', ')}`);
    }
  }

  if (records.length === 0) {
    ok('records', 'there is no DHD parcel-status record to check yet (the poller has not run)');
  } else {
    ok('records', `${records.length} record(s) checked`);
  }

  if (!FEATURE_ON && advancedWhileOff > 0) {
    report(
      'dark-advance',
      `${advancedWhileOff} record(s) carry lastOrderActionAt while DHD sync is off`,
    );
  } else if (!FEATURE_ON) {
    ok('dark-advance', 'no record shows a carrier-driven order action while the feature is off');
  }

  if (!FEATURE_ON) {
    ok('coverage', 'DHD sync is off — orders are not expected to have a record yet (explained skip)');
  } else {
    const orders = await orderCollection
      .find(
        {
          deliveryCompanyId: COMPANY_ID,
          deliveryParcelId: { $type: 'string', $ne: '' },
          isDeleted: { $ne: true },
        },
        {
          projection: {
            orderNo: 1,
            storeId: 1,
            status: 1,
            deliveryParcelId: 1,
            deliveryCompanyId: 1,
          },
        },
      )
      .toArray();

    let covered = 0;
    let skipped = 0;
    for (const order of orders) {
      if (recordByOrder.has(String(order._id))) {
        covered += 1;
        continue;
      }

      const slug = orderSlug(order);
      const config = configByStore.get(String(order.storeId));
      const reasons = [];
      if (!slug || !TRACKED_ORDER_STATUSES.has(slug)) reasons.push(`order status "${slug}" is not polled`);
      if (!config) reasons.push('the store has no delivery config');
      else {
        if (!config.configured) reasons.push('the DHD company is not configured/enabled');
        if (config.paused) reasons.push('the store or provider is paused');
      }

      if (reasons.length > 0) {
        skipped += 1;
        continue;
      }

      report(
        'coverage',
        `order ${order.orderNo ?? order._id} (store ${order.storeId}) has DHD parcel "${order.deliveryParcelId}" but no record`,
      );
    }

    ok('coverage', `${covered} covered; ${skipped} explained skip(s); ${orders.length} DHD order(s) with a parcel`);
  }

  await mongoose.disconnect();
}

async function main() {
  if (OFFLINE) {
    runOffline();
  } else {
    await runLive();
  }

  if (violations.length > 0) {
    console.log(`\n[VERIFY DHD STATUS SYNC] FAILED — ${violations.length} violation(s)`);
    process.exit(1);
  }

  console.log('\n[VERIFY DHD STATUS SYNC] OK — all checks passed');
}

main().catch(async (error) => {
  console.error('[VERIFY DHD STATUS SYNC] FAILED');
  console.error(error);
  try {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
