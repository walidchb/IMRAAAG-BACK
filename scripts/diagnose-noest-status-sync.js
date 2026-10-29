require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Noest Express delivery status sync — end-to-end diagnostic (READ-ONLY).
 *
 * Traces every stage the feature depends on and prints what the code will actually do:
 *
 *   1. feature flags / effective settings (the `settingsFor(companyId)` prefix)
 *   2. delivery configs that enable `companies.noest` (credentials presence only — no secrets)
 *   3. orders bound to Noest (`deliveryCompanyId: 'noest'`) and their parcel ids
 *   4. parcel-status records for Noest
 *   5. a live discovery call for one tracked parcel + the mapper + the signal detector
 *
 * It never writes to MongoDB. It never prints a credential value.
 *
 * Run: node scripts/diagnose-noest-status-sync.js
 *      node scripts/diagnose-noest-status-sync.js --no-api   (skip the live carrier call)
 */

const NO_API = process.argv.includes('--no-api');
const MONGO_URI = process.env.MONGODB_URI;
const COMPANY = 'noest';

if (!MONGO_URI) {
  console.error('MONGODB_URI is required');
  process.exit(1);
}

function header(title) {
  console.log(`\n=== ${title} ===`);
}

function bool(value) {
  return value === true ? 'true' : value === false ? 'false' : String(value);
}

async function main() {
  let config;
  let mapper;
  let profile;
  try {
    config = require('../dist/config/configuration').default();
    mapper = require('../dist/modules/delivery/delivery-companies/handlers/noest/noest-status.mapper');
    ({ NOEST_STATUS_PROFILE: profile } = require('../dist/modules/delivery/delivery-companies/handlers/noest/noest-status.profile'));
    var { decryptRecord } = require('../dist/common/encryption.util');
  } catch (error) {
    console.error('Could not load compiled sources. Run `npm run build` first.');
    console.error(error.message);
    process.exit(1);
  }

  /* ------------------------------------------------------------------ *
   * 1. Feature flags and the settings prefix the service will use
   * ------------------------------------------------------------------ */
  header('1. Feature flags / effective settings');

  console.log('Env:');
  for (const key of Object.keys(process.env).filter((key) => key.startsWith('NOEST_STATUS_SYNC_'))) {
    console.log(`  ${key}=${process.env[key]}`);
  }
  console.log(`  DELIVERY_STATUS_SYNC_ENABLED=${process.env.DELIVERY_STATUS_SYNC_ENABLED ?? '(unset)'}`);

  // Mirror of DeliveryStatusService.settingsFor(): each provider reads its own block and falls
  // back to the shared `deliveryStatusSync` block. A provider absent from this map is silently
  // never polled when the shared block is off.
  const PREFIX_BY_COMPANY = {
    'zr-express': 'zrStatusSync',
    'ecom-delivery': 'ecomStatusSync',
    dhd: 'dhdStatusSync',
    noest: 'noestStatusSync',
  };

  console.log('\nEffective settings per registered provider:');
  for (const companyId of Object.keys(PREFIX_BY_COMPANY)) {
    const prefix = PREFIX_BY_COMPANY[companyId];
    const own = config[prefix] || {};
    const shared = config.deliveryStatusSync || {};
    const effectiveEnabled = own.enabled ?? shared.enabled ?? false;
    console.log(
      `  ${companyId.padEnd(14)} block=${prefix.padEnd(16)} ` +
        `enabled=${bool(effectiveEnabled)} interval=${own.intervalMinutes ?? shared.intervalMinutes ?? 15}m`,
    );
  }
  console.log(
    '\n  NOTE: DeliveryStatusService.settingsFor() maps exactly these four providers. Any other' +
      '\n  provider falls back to deliveryStatusSync, which is off in this project.',
  );
  const noestOwnEnabled = Boolean(config.noestStatusSync && config.noestStatusSync.enabled);
  const sharedEnabled = Boolean(config.deliveryStatusSync && config.deliveryStatusSync.enabled);
  console.log(
    `\n  noestStatusSync.enabled = ${bool(noestOwnEnabled)}` +
      ` | deliveryStatusSync.enabled = ${bool(sharedEnabled)}` +
      ` | effective Noest poller = ${bool(noestOwnEnabled ?? sharedEnabled)}`,
  );

  /* ------------------------------------------------------------------ *
   * 2. Delivery configs
   * ------------------------------------------------------------------ */
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const encKey = process.env.DELIVERY_ENCRYPTION_KEY || '';

  header('2. Delivery configs that contain companies.noest');
  const configs = await db
    .collection('deliveryconfigs')
    .find({ [`companies.${COMPANY}`]: { $exists: true } })
    .toArray();

  console.log(`Found ${configs.length} config document(s).`);
  const noestStores = [];
  for (const doc of configs) {
    const company = doc.companies?.[COMPANY] || {};
    const creds = decryptRecord(company.credentials || {}, encKey);
    let storeId = doc.storeId ? String(doc.storeId) : null;
    if (!storeId && doc.vendorEmail) {
      const store = await db.collection('stores').findOne({ vendorEmail: doc.vendorEmail });
      if (store) storeId = String(store._id);
    }
    noestStores.push({ storeId, vendorEmail: doc.vendorEmail });
    console.log(
      `  storeId=${storeId ?? '(unresolved)'} vendorEmail=${doc.vendorEmail ?? '-'} ` +
        `company.status=${company.status ?? '-'} company.statusSyncEnabled=${bool(company.statusSyncEnabled)} ` +
        `config.statusSyncEnabled=${bool(doc.statusSyncEnabled)} ` +
        `apiToken=${creds.apiToken || creds.apiKey ? 'present' : 'MISSING'} ` +
        `guid=${creds.guid || creds.userGuid ? 'present' : 'MISSING'}`,
    );
  }
  if (configs.length === 0) {
    console.log('  !! No store has a companies.noest config — resolveStores() will yield nothing.');
  }

  /* ------------------------------------------------------------------ *
   * 3. Orders bound to Noest
   * ------------------------------------------------------------------ */
  header('3. Orders with deliveryCompanyId = noest');
  const orders = db.collection('orders');

  const byCompany = await orders
    .aggregate([{ $group: { _id: '$deliveryCompanyId', count: { $sum: 1 } } }, { $sort: { count: -1 } }])
    .toArray();
  console.log('  All orders by deliveryCompanyId:');
  for (const row of byCompany) console.log(`    ${row._id ?? '(none)'}: ${row.count}`);

  const noestOrders = await orders
    .find({ deliveryCompanyId: COMPANY, isDeleted: { $ne: true } })
    .sort({ createdAt: -1 })
    .toArray();

  const withParcel = noestOrders.filter((order) => order.deliveryParcelId);
  const withoutParcel = noestOrders.filter((order) => !order.deliveryParcelId);
  const TRACKED = ['confirmed', 'dispatched', 'in-transit', 'delivered'];
  const pollable = withParcel.filter((order) => TRACKED.includes(order.status?.slug));

  console.log(
    `\n  Noest orders: ${noestOrders.length} total, ${withParcel.length} with a parcel id, ` +
      `${withoutParcel.length} without, ${pollable.length} pollable (confirmed/dispatched/in-transit/delivered).`,
  );
  console.log('  Newest 20:');
  for (const order of noestOrders.slice(0, 20)) {
    console.log(
      `    ${order.orderNo ?? order._id} status=${order.status?.slug ?? '-'} ` +
        `storeId=${order.storeId ?? '(none)'} parcel=${order.deliveryParcelId ?? '(none)'} ` +
        `deliveryStatus=${order.deliveryStatus ?? '-'} updatedAt=${order.updatedAt?.toISOString?.() ?? '-'}`,
    );
  }
  if (noestOrders.length > 0 && withParcel.length === 0) {
    console.log('  !! No Noest order carries a deliveryParcelId — the poller tracks nothing.');
  }
  if (noestOrders.length === 0) {
    console.log('  !! No order is bound to Noest, so there is nothing to sync.');
  }

  /* ------------------------------------------------------------------ *
   * 4. Parcel-status records
   * ------------------------------------------------------------------ */
  header('4. deliveryparcelstatuses records');
  const records = db.collection('deliveryparcelstatuses');
  const byCompanyRecords = await records
    .aggregate([{ $group: { _id: '$companyId', count: { $sum: 1 } } }, { $sort: { count: -1 } }])
    .toArray();
  console.log('  Records by companyId:');
  for (const row of byCompanyRecords) console.log(`    ${row._id ?? '(none)'}: ${row.count}`);

  const noestRecords = await records.find({ companyId: COMPANY }).sort({ updatedAt: -1 }).toArray();
  console.log(`\n  Noest records: ${noestRecords.length}`);
  for (const rec of noestRecords.slice(0, 20)) {
    console.log(
      `    ${rec.parcelId} orderNo=${rec.orderNo ?? '-'} status=${rec.deliveryStatus ?? '-'} ` +
        `syncState=${rec.syncState ?? '-'} signal=${rec.orderSignal ?? '-'}/${rec.signalSource ?? '-'} ` +
        `lastPolledAt=${rec.lastPolledAt?.toISOString?.() ?? '-'} ` +
        `nextEligiblePollAt=${rec.nextEligiblePollAt?.toISOString?.() ?? '-'} ` +
        `terminal=${bool(rec.terminal)} misses=${rec.consecutiveMisses ?? 0} ` +
        `timeline=${Array.isArray(rec.timeline) ? rec.timeline.length : 0} ` +
        `lastError=${rec.lastError ?? '-'}`,
    );
  }

  const lease = await db.collection('syncleases').findOne({ key: `delivery-status-sync:${COMPANY}` });
  if (!lease) {
    console.log(`\n  Lease delivery-status-sync:${COMPANY}: not created (poller never ran)`);
  } else {
    const expires = lease.expiresAt?.getTime?.() ?? 0;
    const free = !expires || expires <= Date.now();
    console.log(
      `\n  Lease delivery-status-sync:${COMPANY}: ${free ? 'free/released' : 'held'} ` +
        `(owner ${String(lease.owner ?? '-').slice(0, 8)}…, expires ${lease.expiresAt?.toISOString?.() ?? '-'}, ` +
        `updated ${lease.updatedAt?.toISOString?.() ?? '-'})`,
    );
  }

  /* ------------------------------------------------------------------ *
   * 5. Live discovery + mapper + signal for one tracked parcel
   * ------------------------------------------------------------------ */
  header('5. Live discovery + mapper + signal for one tracked parcel');

  if (NO_API) {
    console.log('  Skipped (--no-api).');
  } else if (pollable.length === 0) {
    console.log('  No pollable Noest order with a parcel id — nothing to probe.');
  } else {
    const order = pollable[0];
    const storeId = order.storeId ? String(order.storeId) : null;
    const configDoc = storeId
      ? await db.collection('deliveryconfigs').findOne({ storeId: new mongoose.Types.ObjectId(storeId) })
      : null;
    const creds = decryptRecord(configDoc?.companies?.[COMPANY]?.credentials || {}, encKey);
    const token = creds.apiToken || creds.apiKey;

    console.log(
      `  Order ${order.orderNo} tracking=${order.deliveryParcelId} status=${order.status?.slug}`,
    );
    if (!token) {
      console.log('  !! No API token for this store — the carrier call cannot be made.');
    } else {
      const url = 'https://app.noest-dz.com/api/public/get/trackings/info';
      const body = { trackings: [order.deliveryParcelId] };
      console.log(`  POST ${url} body=${JSON.stringify(body)}`);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`  HTTP ${res.status} ${res.statusText} (${text.length} bytes)`);
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          console.log(`  Non-JSON response (first 200 chars): ${text.slice(0, 200)}`);
        }

        if (json && !json[order.deliveryParcelId]) {
          console.log(`  !! Response has no key for ${order.deliveryParcelId}. Keys: ${Object.keys(json).join(', ') || '(none)'}`);
        }

        if (json && json[order.deliveryParcelId]) {
          const entry = json[order.deliveryParcelId];
          const activity = Array.isArray(entry.activity) ? entry.activity : [];
          console.log(`  Entry: activity=${activity.length} OrderInfo.tracking=${entry.OrderInfo?.tracking ?? '-'}`);
          const last = activity[activity.length - 1];
          if (last) {
            console.log(
              `  Last activity: event_key=${last.event_key ?? '-'} event="${last.event ?? '-'}" date=${last.date ?? '-'} by="${last.by ?? '-'}"`,
            );
          }

          const snapshot = mapper.mapNoestDiscoveryEntry(entry, order.deliveryParcelId);
          console.log(
            `  Mapper: providerState=${snapshot.providerState} normalizedStatus=${snapshot.normalizedStatus} ` +
              `situations=[${snapshot.situations.join(',')}] timeline=${snapshot.timeline.length}`,
          );

          const parcel = {
            parcelId: order.deliveryParcelId,
            carrierStateName: snapshot.timeline[snapshot.timeline.length - 1]?.event ?? null,
            carrierStateDescription: snapshot.timeline[snapshot.timeline.length - 1]?.description ?? null,
            deliveryStatus: snapshot.normalizedStatus,
            terminal: ['delivered', 'cancelled', 'returned'].includes(snapshot.normalizedStatus),
          };
          const signal = profile.detectSignal(parcel, snapshot.timeline, null);
          console.log(`  Signal: ${signal.signal} (source=${signal.source})`);
          console.log(
            `  What the poller would persist: status=${snapshot.normalizedStatus} signal=${signal.signal} ` +
              `timelineEntries=${snapshot.timeline.length}`,
          );
        }
      } catch (error) {
        console.log(`  !! Live call failed: ${error.message}`);
      }
    }
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
