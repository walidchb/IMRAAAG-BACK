require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Ecom Delivery status sync, Phase E7 — live read-only verification.
 *
 * Proves what the plan promises before Ecom is enabled for a store:
 *
 *   1. every Ecom order that has a parcel has a record, or an explained skip;
 *   2. every record is store-scoped and belongs to `ecom-delivery`;
 *   3. no record carries a credential in any field;
 *   4. the timeline is ordered and free of duplicate `providerEntryId`s;
 *   5. the stored normalized status is in the frozen catalogue and matches its raw carrier labels;
 *   6. terminal / return-watch state is consistent;
 *   7. no order was advanced by Ecom while the feature is off;
 *   8. the declared indexes exist, and no legacy unique `{storeId, parcelId}` index survives.
 *
 * It is **read-only**: it never writes to MongoDB, never creates an index, and never prints a
 * credential. It exits non-zero on any violation.
 *
 * Requires `npm run build` first: every rule is read from the **compiled** mapper/schema, so the
 * script proves the rules the application actually applies.
 *
 * Run: node scripts/verify-ecom-status-sync.js
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

let mapper;
let profile;
let parcelStatusSchema;
let leaseSchema;
let constants;
let carrier;
try {
  mapper = require('../dist/modules/delivery/delivery-companies/handlers/ecom/ecom-status.mapper');
  ({ ECOM_STATUS_PROFILE: profile } = require(
    '../dist/modules/delivery/delivery-companies/handlers/ecom/ecom-status.profile',
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
const FEATURE_ON = String(process.env.ECOM_STATUS_SYNC_ENABLED ?? '').toLowerCase() === 'true';
const NORMALIZED = new Set(carrier.NORMALIZED_STATUSES);
const SIGNALS = new Set(carrier.CARRIER_ORDER_SIGNALS);
const SIGNAL_SOURCES = new Set(['state', 'situation', 'override', 'none']);
const TRACKED_ORDER_STATUSES = new Set(constants.DELIVERY_STATUS_TRACKED_ORDER_STATUSES);
const CONFLICT_CODES = new Set(constants.DELIVERY_STATUS_CONFLICT_CODE_VALUES);
/** A successful hand-over: the record becomes terminal only after the return watch. */
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
  /x-api-token/i,
  /access[-_]?token/i,
  /refresh[-_]?token/i,
  /private[-_]?key/i,
  /(^|[._])token$/i,
];

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

/** `Order.status` is either a slug string or an embedded `{ slug }` object. */
function orderSlug(order) {
  if (!order?.status) return null;
  if (typeof order.status === 'string') return order.status;
  return order.status.slug ?? null;
}

/**
 * Recompute the normalized status from the stored raw labels exactly as `mapEcomParcel` does:
 * logistic state first, situation fallback, cancel/return winning on either axis.
 */
function expectedStatus(record, overrides) {
  const raw = record.rawSituation || {};
  const logistic = mapper.normalizeEcomStatus(
    raw.etat_logistique ?? record.carrierStateDescription ?? record.carrierStateName,
    overrides,
    raw.id_etat_logistique,
  );
  const situation = mapper.normalizeEcomStatus(
    raw.situation,
    overrides,
    raw.id_situation,
  );

  if (logistic === 'returned' || logistic === 'cancelled') return logistic;
  if (situation === 'returned' || situation === 'cancelled') return situation;
  return logistic !== 'unknown' ? logistic : situation;
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const collection = db.collection('deliveryparcelstatuses');
  const leaseCollection = db.collection('syncleases');
  const configCollection = db.collection('deliveryconfigs');
  const orderCollection = db.collection('orders');

  console.log(`[VERIFY ECOM STATUS SYNC] Connected. Provider: ${COMPANY_ID}. Feature flag: ${FEATURE_ON ? 'ON' : 'OFF'}.\n`);

  const existingCollections = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name),
  );

  // 1. Declared indexes must exist. The script never creates them.
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

  // 2. The pre-companyId unique index must be gone: it would block two providers that happen
  //    to report the same carrier parcel id in one store.
  if (existingCollections.has('deliveryparcelstatuses')) {
    const legacyKeys = new Set([
      JSON.stringify({ storeId: 1, parcelId: 1 }),
      JSON.stringify({ storeId: 1, parcelId: -1 }),
    ]);
    const indexes = await collection.indexes();
    const legacy = indexes.find((index) => legacyKeys.has(JSON.stringify(index.key)));
    if (legacy) {
      report(
        'legacy-index',
        `the pre-companyId index ${JSON.stringify(legacy.key)} still exists — drop it before rollout`,
      );
    } else {
      ok('legacy-index', 'no legacy {storeId, parcelId} index');
    }
  }

  // 3. One lease per provider.
  if (existingCollections.has('syncleases')) {
    const leaseKey = constants.deliveryStatusLeaseKey(COMPANY_ID);
    const leases = await leaseCollection.find({ key: leaseKey }).toArray();
    if (leases.length > 1) {
      report('lease-singleton', `${leases.length} "${leaseKey}" lease documents exist — expected at most 1`);
    } else {
      ok('lease-singleton', `${leases.length} "${leaseKey}" lease document(s)`);
    }
  }

  // 4. Per-store configuration: overrides, credentials and pause state.
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
          company.credentials.key &&
          company.credentials.token,
      ),
      overrides: (config.statusStateOverrides || {})[COMPANY_ID] || {},
    });
  }

  // 5. Every Ecom record. Records owned by another provider (ZR Express is live on this
  //    database) are deliberately out of scope for this verifier.
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

    // 5.1 Every record is store-scoped and belongs to this provider.
    if (!record.storeId) {
      report('store-scope', `${label}: the record carries no storeId`);
    }
    if (record.companyId !== COMPANY_ID) {
      report('company', `${label}: the record belongs to "${record.companyId}", not "${COMPANY_ID}"`);
    }

    // 5.2 The normalized status is in the catalogue and matches the raw carrier labels.
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

    // 5.3 Timeline ordering and idempotency.
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

    // 5.4 Signal vocabulary.
    if (record.orderSignal && !SIGNALS.has(record.orderSignal)) {
      report('signal', `${label}: the signal "${record.orderSignal}" is not in the frozen catalogue`);
    }
    if (record.signalSource && !SIGNAL_SOURCES.has(record.signalSource)) {
      report('signal-source', `${label}: the source "${record.signalSource}" is not one of state/situation/override/none`);
    }

    // 5.5 Terminal / return-watch consistency.
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

    // 5.6 Conflict vocabulary.
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

    // 5.7 The owning order is in the same store and still points at this parcel.
    // `deliveryparcelstatuses.storeId` is written as a string by the poller while `orders.storeId`
    // is an ObjectId (both paths are Mixed on Mongoose 9), so compare the resolved values instead
    // of letting the driver compare BSON types.
    const order = await orderCollection.findOne(
      { _id: record.orderId },
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
      report('order-link', `${label}: the order ${record.orderId} does not exist`);
    } else if (String(order.storeId) !== String(record.storeId)) {
      report(
        'order-link',
        `${label}: the order lives in store ${order.storeId}, not ${record.storeId}`,
      );
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
            `${label}: the order carries ${carrierHistory.length} carrier-driven history entr(y/ies) while Ecom sync is off`,
          );
        }
      }
    }

    if (!FEATURE_ON && record.lastOrderActionAt) {
      advancedWhileOff += 1;
    }

    // 5.8 No credential may be stored in any field.
    const credentials = findCredentials(record, 'record', []);
    if (credentials.length > 0) {
      report('no-credential', `${label}: ${credentials.join(', ')}`);
    }
  }

  if (records.length === 0) {
    ok('records', 'there is no parcel-status record to check yet (the poller has not run)');
  } else {
    ok('records', `${records.length} record(s) checked`);
  }

  if (!FEATURE_ON && advancedWhileOff > 0) {
    report(
      'dark-advance',
      `${advancedWhileOff} record(s) carry lastOrderActionAt while Ecom sync is off`,
    );
  } else if (!FEATURE_ON) {
    ok('dark-advance', 'no record shows a carrier-driven order action while the feature is off');
  }

  // 6. Coverage: every Ecom order with a parcel has a record, or an explained skip.
  if (!FEATURE_ON) {
    ok('coverage', 'Ecom sync is off — orders are not expected to have a record yet (explained skip)');
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
        if (!config.configured) reasons.push('the Ecom company is not configured/enabled');
        if (config.paused) reasons.push('the store or provider is paused');
      }

      if (reasons.length > 0) {
        skipped += 1;
        continue;
      }

      report(
        'coverage',
        `order ${order.orderNo ?? order._id} (store ${order.storeId}) has Ecom parcel "${order.deliveryParcelId}" but no record`,
      );
    }

    ok('coverage', `${covered} covered; ${skipped} explained skip(s); ${orders.length} Ecom order(s) with a parcel`);
  }

  await mongoose.disconnect();

  if (violations.length > 0) {
    console.log(`\n[VERIFY ECOM STATUS SYNC] FAILED — ${violations.length} violation(s)`);
    process.exit(1);
  }

  console.log('\n[VERIFY ECOM STATUS SYNC] OK — all checks passed');
}

main().catch((error) => {
  console.error('[VERIFY ECOM STATUS SYNC] FAILED');
  console.error(error);
  process.exit(1);
});
