require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * ZR Express status sync, Phase 3 — live read-only verification.
 *
 * Roadmap §20.4 asks for a script that lists every `deliveryparcelstatuses` document and
 * asserts the four invariants the platform depends on:
 *
 *   1. the normalized status is consistent with the stored carrier state;
 *   2. the timeline is strictly ordered and free of duplicate `providerEntryId`s;
 *   3. the order status is consistent with the carrier status under the §9.3 rule;
 *   4. no record carries a credential in any field.
 *
 * It is **read-only**: it never writes to MongoDB — not even an index — and it never prints a
 * credential. It exits non-zero on any violation.
 *
 * Requires `npm run build` first: the mapping rules are read from the **compiled** mapper, so
 * the script proves the rules the application actually applies.
 *
 * Run: node scripts/verify-zr-status-sync.js
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

let mapper;
let parcelStatusSchema;
let leaseSchema;
let conflictCodes;
try {
  mapper = require('../dist/modules/delivery/delivery-companies/handlers/zr-express/zr-status.mapper');
  ({ DeliveryParcelStatusSchema: parcelStatusSchema } = require(
    '../dist/modules/delivery/schemas/delivery-parcel-status.schema',
  ));
  ({ SyncLeaseSchema: leaseSchema } = require(
    '../dist/modules/delivery/schemas/sync-lease.schema',
  ));
  ({ DELIVERY_STATUS_CONFLICT_CODE_VALUES: conflictCodes } = require(
    '../dist/common/constants/delivery-status.const',
  ));
} catch (error) {
  console.error('Could not load the compiled sources. Run `npm run build` first.');
  console.error(error.message);
  process.exit(1);
}

const violations = [];

function report(rule, detail) {
  violations.push({ rule, detail });
  console.log(`  FAIL  [${rule}] ${detail}`);
}
function ok(rule, msg) {
  console.log(`  ok    [${rule}] ${msg}`);
}

/** A field name or a value that must never appear in a parcel-status record. */
const CREDENTIAL_PATTERNS = [
  /api[-_]?key/i,
  /apikey/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /authorization/i,
  /bearer\s/i,
  /x-api-key/i,
  /access[-_]?token/i,
  /refresh[-_]?token/i,
  /private[-_]?key/i,
];

/** The carrier states that mean "delivered" — the delivery-trigger band of §9.3. */
const DELIVERY_TRIGGER = 'delivered';

/** The order statuses a delivered carrier status may have produced. */
const ORDER_STATUSES_AFTER_DELIVERY = ['dispatched', 'in-transit', 'delivered'];

function findCredentials(value, path, found) {
  if (value === null || value === undefined) return found;

  if (typeof value === 'string') {
    for (const pattern of CREDENTIAL_PATTERNS) {
      if (pattern.test(value)) {
        found.push(`${path} = ${value.slice(0, 40)}`);
        break;
      }
    }
    return found;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => findCredentials(item, `${path}[${index}]`, found));
    return found;
  }

  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      for (const pattern of CREDENTIAL_PATTERNS) {
        if (pattern.test(key)) {
          found.push(`${path}.${key}`);
          break;
        }
      }
      findCredentials(nested, `${path}.${key}`, found);
    }
  }

  return found;
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const collection = db.collection('deliveryparcelstatuses');
  const leaseCollection = db.collection('syncleases');
  const configCollection = db.collection('deliveryconfigs');
  const orderCollection = db.collection('orders');

  console.log('[VERIFY ZR STATUS SYNC] Connected.\n');

  // 0. A collection that does not exist yet is not a violation — the poller creates it on its
  //    first run. The script stays read-only and simply skips it.
  const existingCollections = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name),
  );

  // 1. The declared indexes must exist on the live collections. The script never creates them.
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

  // 2. The lease is a singleton **per provider** (one document per carrier since the
  //    multi-provider refactor); ZR's own key is the one this verifier owns.
  const zrLeaseKey = 'delivery-status-sync:zr-express';
  const leases = await leaseCollection.find({ key: { $in: [zrLeaseKey, 'delivery-status-sync'] } }).toArray();
  if (leases.length > 1) {
    report('lease-singleton', `${leases.length} ZR lease documents exist — expected at most 1`);
  } else {
    ok('lease-singleton', `at most one ZR lease document (${leases.length})`);
  }

  // 3. The per-store overrides, so the consistency check applies the store's own rules.
  const configs = await configCollection
    .find({ 'companies.zr-express': { $exists: true } })
    .toArray();
  const overridesByStore = new Map();
  for (const config of configs) {
    if (!config.storeId) continue;
    overridesByStore.set(
      String(config.storeId),
      (config.statusStateOverrides || {})['zr-express'] || {},
    );
  }

  // 4. Every ZR parcel-status document. Records owned by the other providers (Noest, Ecom,
  //    DHD) are deliberately out of scope — the same collection is shared since 2026-10-22.
  //    Pre-multi-provider ZR records carry no `companyId`; they are still ZR's.
  const records = await collection
    .find({ $or: [{ companyId: 'zr-express' }, { companyId: { $exists: false } }] })
    .toArray();
  console.log(`\n  ${records.length} ZR parcel-status record(s)\n`);

  let checked = 0;
  for (const record of records) {
    const label = `${record.parcelId} (store ${record.storeId})`;
    const overrides = overridesByStore.get(String(record.storeId)) || {};

    // 4.1 The normalized status must match the stored carrier state.
    if (record.carrierStateName) {
      const expected = mapper.applyStateOverride(record.carrierStateName, overrides);
      const normalized = mapper.normalizeCarrierState(expected, overrides);
      if (normalized !== record.deliveryStatus) {
        report(
          'normalized-status',
          `${label}: the carrier state "${record.carrierStateName}" normalizes to "${normalized}" but the record stores "${record.deliveryStatus}"`,
        );
      }
    }

    // 4.2 The timeline must be ordered and free of duplicates.
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

    // 4.3 The order status must be consistent with the carrier status (§9.3).
    // The projection is an option of `findOne`, not a chained `.project()` — the MongoDB
    // driver v6 removed the chained form, and the crash only showed up once the first
    // parcel-status record existed. The raw collection returns a plain document.
    // `storeId` is compared by value: the record's is a string and the order's an ObjectId.
    const order = await orderCollection.findOne(
      { _id: record.orderId },
      { projection: { status: 1, storeId: 1 } },
    );
    if (!order) {
      report('order-link', `${label}: the order ${record.orderId} does not exist`);
    } else if (String(order.storeId) !== String(record.storeId)) {
      report(
        'order-link',
        `${label}: the order lives in store ${order.storeId}, not ${record.storeId}`,
      );
    } else {
      const orderSlug = order.status?.slug ?? null;
      if (orderSlug === 'delivered' && record.deliveryStatus !== DELIVERY_TRIGGER) {
        report(
          'order-consistency',
          `${label}: the order is "delivered" but the carrier's status is "${record.deliveryStatus}"`,
        );
      }
      if (
        record.deliveryStatus === DELIVERY_TRIGGER &&
        orderSlug &&
        !ORDER_STATUSES_AFTER_DELIVERY.includes(orderSlug)
      ) {
        report(
          'order-consistency',
          `${label}: the carrier delivered the parcel but the order is "${orderSlug}"`,
        );
      }
    }

    // 4.4 No credential may be stored in any field.
    const credentials = findCredentials(record, 'record', []);
    if (credentials.length > 0) {
      report('no-credential', `${label}: ${credentials.join(', ')}`);
    }

    // 4.5 A recorded conflict must carry a known code and a timestamp (§10.4).
    if (record.conflict) {
      if (!conflictCodes.includes(record.conflict)) {
        report(
          'conflict-code',
          `${label}: the conflict "${record.conflict}" is not one of the known conflict codes`,
        );
      }
      const at = record.conflictAt ? new Date(record.conflictAt).getTime() : NaN;
      if (Number.isNaN(at)) {
        report('conflict-at', `${label}: the conflict carries no usable timestamp`);
      }
    } else if (record.conflictAt) {
      report(
        'conflict-at',
        `${label}: the record carries a conflict timestamp without a conflict code`,
      );
    }

    checked += 1;
  }

  if (checked === 0) {
    ok('records', 'there is no parcel-status record to check yet (the poller has not run)');
  } else {
    ok('records', `${checked} record(s) satisfy every invariant`);
  }

  await mongoose.disconnect();

  if (violations.length > 0) {
    console.log(`\n[VERIFY ZR STATUS SYNC] FAILED — ${violations.length} violation(s)`);
    process.exit(1);
  }

  console.log('\n[VERIFY ZR STATUS SYNC] OK — all checks passed');
}

main().catch((error) => {
  console.error('[VERIFY ZR STATUS SYNC] FAILED');
  console.error(error);
  process.exit(1);
});
