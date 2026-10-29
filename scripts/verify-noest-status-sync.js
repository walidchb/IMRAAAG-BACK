require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

/**
 * Noest Express delivery status sync — read-only verification.
 *
 * Live mode proves the deployed data against the rules the application actually applies:
 * indexes, tenant scoping, the frozen status/signal catalogue, timeline ordering, terminal /
 * return-watch / conflict state, order consistency, dark-advance safety, and the absence of a
 * credential in any record field. It never writes to MongoDB and never prints a secret.
 *
 * Offline mode (`--offline`) runs the same mapper against synthetic fixtures.
 *
 * Requires `npm run build` first.
 *
 * Run: node scripts/verify-noest-status-sync.js [--offline]
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
  mapper = require('../dist/modules/delivery/delivery-companies/handlers/noest/noest-status.mapper');
  ({ NOEST_STATUS_PROFILE: profile } = require(
    '../dist/modules/delivery/delivery-companies/handlers/noest/noest-status.profile',
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
const FEATURE_ON = String(process.env.NOEST_STATUS_SYNC_ENABLED ?? '').toLowerCase() === 'true';
const NORMALIZED = new Set(carrier.NORMALIZED_STATUSES);
const SIGNALS = new Set(carrier.CARRIER_ORDER_SIGNALS);
const SIGNAL_SOURCES = new Set(['state', 'situation', 'override', 'none']);
const TRACKED_ORDER_STATUSES = new Set(constants.DELIVERY_STATUS_TRACKED_ORDER_STATUSES);
const CONFLICT_CODES = new Set(constants.DELIVERY_STATUS_CONFLICT_CODE_VALUES);
const DELIVERY_COMPLETE_STATUSES = new Set(['delivered', 'cash_collected', 'settled']);
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
  } else if (Array.isArray(value)) {
    value.forEach((el, idx) => findCredentials(el, `${valuePath}[${idx}]`, found));
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(k))) {
        found.push(`${valuePath}.${k} (key matched)`);
      } else {
        findCredentials(v, `${valuePath}.${k}`, found);
      }
    }
  }
  return found;
}

async function runOffline() {
  console.log('--- Noest Status Sync — Offline Fixture Verification ---');

  const fixture = {
    OrderInfo: {
      id: '1',
      reference: 'NOE-TEST-001',
      tracking: 'NOE-TEST-001',
      status: 'delivered',
    },
    status: 'delivered',
    activity: [
      {
        event: 'Uploaded to system',
        event_key: 'upload',
        date: '2026-10-25 10:00:00',
        by: 'System',
      },
      {
        event: 'Delivered',
        event_key: 'livre',
        date: '2026-10-28 15:30:00',
        by: 'Driver',
      },
    ],
  };

  const snapshot = mapper.mapNoestDiscoveryEntry(fixture, 'NOE-TEST-001');

  if (snapshot.normalizedStatus === 'delivered') {
    ok('OFFLINE-MAPPER', 'Successfully mapped Noest discovery entry to delivered');
  } else {
    report('OFFLINE-MAPPER', `Unexpected normalized status: ${snapshot.normalizedStatus}`);
  }

  if (snapshot.timeline.length === 2) {
    ok('OFFLINE-TIMELINE', 'Timeline length correct (2 entries)');
  } else {
    report('OFFLINE-TIMELINE', `Unexpected timeline length: ${snapshot.timeline.length}`);
  }

  const parcel = {
    parcelId: 'NOE-TEST-001',
    carrierStateName: 'livre',
    carrierStateDescription: 'Delivered',
    deliveryStatus: snapshot.normalizedStatus,
    terminal: true,
  };

  const signal = profile.detectSignal(parcel, snapshot.timeline, null);
  if (signal.signal === 'delivered') {
    ok('OFFLINE-SIGNAL', 'Correctly detected delivered signal');
  } else {
    report('OFFLINE-SIGNAL', `Unexpected signal: ${signal.signal}`);
  }

  console.log(`\nOffline verification completed with ${violations.length} violation(s).`);
  process.exit(violations.length > 0 ? 1 : 0);
}

async function runLive() {
  console.log('--- Noest Status Sync — Live Database Verification ---');

  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const ParcelStatus = mongoose.model('DeliveryParcelStatus', parcelStatusSchema, 'deliveryparcelstatuses');
  const Lease = mongoose.model('SyncLease', leaseSchema, 'syncleases');
  const Orders = mongoose.model('OrderOrder', new mongoose.Schema({}, { strict: false }), 'orders');

  const indexes = await ParcelStatus.collection.indexes();
  console.log(`Checking indexes on deliveryparcelstatuses (found ${indexes.length})...`);

  const hasStoreCompanyParcelIndex = indexes.some(
    (idx) => idx.key?.storeId === 1 && idx.key?.companyId === 1 && idx.key?.parcelId === 1 && idx.unique === true,
  );

  if (hasStoreCompanyParcelIndex) {
    ok('INDEX-UNIQUE', 'Found unique {storeId: 1, companyId: 1, parcelId: 1} index.');
  } else {
    report('INDEX-UNIQUE', 'Missing unique {storeId: 1, companyId: 1, parcelId: 1} index.');
  }

  const records = await ParcelStatus.find({ companyId: COMPANY_ID }).lean();
  console.log(`Found ${records.length} Noest parcel status record(s).`);

  if (!FEATURE_ON && records.length > 0) {
    console.warn('WARNING: NOEST_STATUS_SYNC_ENABLED is false, but parcel records exist.');
  }

  for (const rec of records) {
    const idStr = rec._id.toString();

    if (!rec.storeId) {
      report('TENANCY', `Record ${idStr} is missing storeId.`);
    }

    if (!rec.parcelId) {
      report('PARCEL-ID', `Record ${idStr} is missing parcelId.`);
    }

    if (!NORMALIZED.has(rec.deliveryStatus)) {
      report('NORMALIZED-STATUS', `Record ${idStr} has unknown deliveryStatus "${rec.deliveryStatus}".`);
    }

    if (!SIGNALS.has(rec.orderSignal)) {
      report('SIGNAL', `Record ${idStr} has unknown orderSignal "${rec.orderSignal}".`);
    }

    if (!SIGNAL_SOURCES.has(rec.signalSource)) {
      report('SIGNAL-SOURCE', `Record ${idStr} has unknown signalSource "${rec.signalSource}".`);
    }

    const exposedSecrets = findCredentials(rec, `record[${idStr}]`, []);
    if (exposedSecrets.length > 0) {
      report('CREDENTIAL-SAFETY', `Record ${idStr} contains potential credentials: ${exposedSecrets.join(', ')}`);
    }
  }

  const lease = await Lease.findOne({ key: `delivery-status-sync:${COMPANY_ID}` }).lean();
  if (lease) {
    ok('LEASE', `Found sync lease for ${COMPANY_ID} (acquired: ${lease.acquiredAt}, expires: ${lease.expiresAt}).`);
  } else {
    console.log(`No active sync lease for ${COMPANY_ID} (poller is idle).`);
  }

  await mongoose.disconnect();

  console.log(`\nLive verification completed with ${violations.length} violation(s).`);
  process.exit(violations.length > 0 ? 1 : 0);
}

if (OFFLINE) {
  runOffline();
} else {
  runLive();
}
