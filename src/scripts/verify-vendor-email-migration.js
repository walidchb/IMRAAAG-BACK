/**
 * Read-only verifier for the vendorEmail -> storeId migration (M18).
 * Inspects every live document store-wide and classifies remaining vendorEmail usage.
 *
 * Run: node src/scripts/verify-vendor-email-migration.js
 * Requires: a live MongoDB connection configured in the app (MONGODB_URI).
 *
 * Exit 0 = clean, 1 = findings.
 */

const { MongoClient, Types } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set. Set it before running the verifier.');
  process.exit(2);
}

// Groups whose documents MUST carry a storeId and MUST NOT retain a legacy vendorEmail
// ownership field. These are the M18 cleanup targets.
const OWNERSHIP_COLLECTIONS = [
  // Touched during M18's current pass:
  { name: 'trackingconfigs', storeIdField: 'storeId', legacyField: 'vendorEmail' },
  { name: 'products', storeIdField: 'storeId', legacyField: 'vendorEmail' },
  { name: 'orders', storeIdField: 'storeId', legacyField: 'vendorEmail' },
  { name: 'deliveryconfigs', storeIdField: 'storeId', legacyField: 'vendorEmail' },
  { name: 'deliveryattributions', storeIdField: 'storeId', legacyField: 'vendorEmail' },
  { name: 'deliveryfees', storeIdField: 'storeId', legacyField: 'vendorEmail' },
  // Delivery-desk / territory collections are store-independent reference data; they carry
  // no ownership key and are not part of the vendorEmail migration.
];

const LEGITIMATE_REFERENCES = [
  // Fields that may still mention a vendor email as *contact/business data*, not as the
  // ownership key. They are reported separately and are not errors.
  { collection: 'stores', field: 'vendorEmail' },
];

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db();

  console.log('--- M18 migration verification ---');
  console.log('DB: %s', db.databaseName);

  const findings = [];
  const stats = {};

  for (const group of OWNERSHIP_COLLECTIONS) {
    const col = db.collection(group.name);
    const count = await col.estimatedDocumentCount();
    stats[group.name] = { total: count, withStoreId: 0, withLegacyEmail: 0, storeIdMissingAndLegacy: 0, legacyOnly: 0 };

    const cursor = col.find({}).batchSize(500);
    let hasMore = true;
    while (hasMore) {
      const batch = await cursor.fetchNext();
      if (!batch || batch.length === 0) { hasMore = false; continue; }

      for (const doc of batch) {
        const sid = doc[group.storeIdField];
        const email = doc[group.legacyField];
        const hasStoreId = Types.ObjectId.isValid(sid);
        const hasLegacy = typeof email === 'string' && email.length > 0;

        stats[group.name].withStoreId += hasStoreId ? 1 : 0;
        stats[group.name].withLegacyEmail += hasLegacy ? 1 : 0;

        if (!hasStoreId && hasLegacy) {
          stats[group.name].legacyOnly += 1;
          findings.push({ type: 'LEGACY_ONLY', collection: group.name, id: String(doc._id), email });
        } else if (!hasStoreId && !hasLegacy) {
          stats[group.name].storeIdMissingAndLegacy += 1;
          findings.push({ type: 'OWNER_KEY_MISSING', collection: group.name, id: String(doc._id), hasStoreId, hasLegacy });
        }
      }
    }
    cursor.close();
  }

  // Legitimate-reference scan: any document carrying vendorEmail as contact data.
  for (const ref of LEGITIMATE_REFERENCES) {
    const col = db.collection(ref.collection);
    const count = await col.countDocuments({ [ref.field]: { $type: 'string', $exists: true, $ne: '' } });
    stats[ref.collection] = stats[ref.collection] || {};
    stats[ref.collection].legitimateVendorEmail = count;
    console.log('Legitimate %s.%s references: %d', ref.collection, ref.field, count);
  }

  // Migration-safety scan: for every backfilled ownership document, confirm the legacy email
  // still maps to the same store it was backfilled against. Mismatches indicate either a
  // non-idempotent migration path or an email change after migration, and must be reviewed
  // before any legacy read fallback is removed.
  console.log('');
  console.log('--- Migration-safety scan (backfilled docs vs current store) ---');
  const emailToStore = new Map();
  const storeCursor = db.collection(STORE_SOURCE_NAME).find({}).project({ _id: 1, vendorEmail: 1 });
  let storeMore = true;
  while (storeMore) {
    const batch = await storeCursor.fetchNext();
    if (!batch || batch.length === 0) { storeMore = false; continue; }
    for (const s of batch) {
      if (s._id && Types.ObjectId.isValid(s._id) && typeof s.vendorEmail === 'string' && s.vendorEmail) {
        emailToStore.set(s.vendorEmail.toLowerCase(), String(s._id));
      }
    }
  }
  storeCursor.close();

  const safetyFindings = [];
  for (const group of OWNERSHIP_COLLECTIONS) {
    const col = db.collection(group.name);
    const cursor = col.find({ [group.storeIdField]: { $exists: true } }).batchSize(500);
    let more = true;
    while (more) {
      const batch = await cursor.fetchNext();
      if (!batch || batch.length === 0) { more = false; continue; }
      for (const doc of batch) {
        const storeId = doc[group.storeIdField];
        const legacyEmail = doc[group.legacyField];
        if (!Types.ObjectId.isValid(storeId)) continue;
        const email = typeof legacyEmail === 'string' && legacyEmail.trim().length > 0 ? legacyEmail.toLowerCase() : '';
        if (!email) continue;
        const expectedStoreId = emailToStore.get(email);
        if (expectedStoreId && String(storeId) !== expectedStoreId) {
          safetyFindings.push({ collection: group.name, id: String(doc._id), email, storeId: String(storeId), expectedStoreId });
        }
      }
    }
    cursor.close();
  }

  if (safetyFindings.length === 0) {
    console.log('Migration-safety scan: CLEAN — every legacy-email ownership doc maps to its current store.');
  } else {
    console.log('Migration-safety scan: FINDINGS (%d) — these must be reviewed before removing legacy read fallbacks:', safetyFindings.length);
    for (const f of safetyFindings.slice(0, 200)) {
      console.log('  - %s %s:%s email=%s storedStoreId=%s expectedStoreId=%s', f.collection, f.id, f.email, f.storeId, f.expectedStoreId);
    }
    if (safetyFindings.length > 200) console.log('  ... and %d more', safetyFindings.length - 200);
  }

  // Report ownership-group stats.
  console.log('');
  for (const group of OWNERSHIP_COLLECTIONS) {
    const s = stats[group.name];
    console.log('Collection %s: total=%d withStoreId=%d withLegacyEmail=%d legacyOnly=%d missingOwnerKey=%d',
      group.name, s.total, s.withStoreId, s.withLegacyEmail, s.legacyOnly, s.storeIdMissingAndLegacy);
  }

  console.log('');
  if (findings.length === 0) {
    console.log('Result: CLEAN — every ownership collection has a storeId and no legacy ownership email.');
  } else {
    console.log('Result: FINDINGS (%d):', findings.length);
    for (const f of findings.slice(0, 200)) {
      console.log('  - %s %s:%s (hasStoreId=%s hasLegacy=%s)', f.type, f.collection, f.id, f.hasStoreId, f.hasLegacy);
    }
    if (findings.length > 200) console.log('  ... and %d more', findings.length - 200);
  }

  await client.close();

  const ownershipFindings = findings.length;
  const totalFindings = findings.length + safetyFindings.length;
  if (totalFindings === 0) {
    console.log('');
    console.log('Result: CLEAN — every ownership collection has a storeId and no legacy ownership email.');
  } else {
    console.log('');
    console.log('Result: FINDINGS (%d):', totalFindings);
    if (ownershipFindings > 0) {
      console.log('  Ownership findings (%d):', ownershipFindings);
      for (const f of findings.slice(0, 200)) {
        console.log('    - %s %s:%s (hasStoreId=%s hasLegacy=%s)', f.type, f.collection, f.id, f.hasStoreId, f.hasLegacy);
      }
      if (findings.length > 200) console.log('    ... and %d more', findings.length - 200);
    }
    if (safetyFindings.length > 0) {
      console.log('  Migration-safety findings (%d):', safetyFindings.length);
      for (const f of safetyFindings.slice(0, 200)) {
        console.log('    - %s %s:%s email=%s storedStoreId=%s expectedStoreId=%s', f.collection, f.id, f.email, f.storeId, f.expectedStoreId);
      }
      if (safetyFindings.length > 200) console.log('    ... and %d more', safetyFindings.length - 200);
    }
  }

  await client.close();
  process.exit(totalFindings > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Verifier crashed:', err);
  process.exit(3);
});

const STORE_SOURCE_NAME = 'stores';
