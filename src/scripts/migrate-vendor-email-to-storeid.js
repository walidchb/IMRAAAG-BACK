/**
 * M18 vmigration runner: for every collection in scope, reports how many documents
 * still carry the legacy `vendorEmail` as an ownership field and whether a matching
 * `storeId` already exists.
 *
 * Dry run by default (no writes). Use `--apply` to also backfill `storeId` onto
 * documents that have a matching vendor email and no storeId, using the same
 * 1:1 store↔email mapping from the `stores` collection.
 *
 * Run:
 *   node src/scripts/migrate-vendor-email-to-storeid.js            # report only
 *   node src/scripts/migrate-vendor-email-to-storeid.js --apply    # backfill + report
 */

const { MongoClient, Types } = require('mongodb');
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set. Set it before running.');
  process.exit(2);
}

const APPLY = process.argv.includes('--apply');

// Collections whose ownership is expressed via storeId + legacy vendorEmail.
const OWNERSHIP_GROUPS = [
  { name: 'trackingconfigs',        storeIdField: 'storeId',          legacyField: 'vendorEmail' },
  { name: 'products',              storeIdField: 'storeId',          legacyField: 'vendorEmail' },
  { name: 'orders',                storeIdField: 'storeId',          legacyField: 'vendorEmail' },
  { name: 'deliveryconfigs',       storeIdField: 'storeId',          legacyField: 'vendorEmail' },
  { name: 'deliveryattributions',  storeIdField: 'storeId',          legacyField: 'vendorEmail' },
  { name: 'deliveryfees',          storeIdField: 'storeId',          legacyField: 'vendorEmail' },
];

// Stores collection: source of truth for the store↔email map. One vendorEmail -> one storeId.
const STORE_SOURCE = { name: 'stores', storeIdField: '_id', emailField: 'vendorEmail' };

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db();

  console.log('M18 vendorEmail -> storeId migration — %s mode', APPLY ? 'APPLY (writes)' : 'DRY RUN (report only)');
  console.log('DB: %s', db.databaseName);
  console.log('');

  // 1) Build the store lookup by email from the stores collection.
  const emailToStoreId = new Map();
  const emailCounts = new Map();
  const storeCursor = db.collection(STORE_SOURCE.name).find({}).project({ _id: 1, vendorEmail: 1 });
  let storeMore = true;
  while (storeMore) {
    const batch = await storeCursor.fetchNext();
    if (!batch || batch.length === 0) { storeMore = false; continue; }
    for (const s of batch) {
      if (s._id && Types.ObjectId.isValid(s._id) && typeof s.vendorEmail === 'string' && s.vendorEmail) {
        const e = s.vendorEmail.toLowerCase();
        emailToStoreId.set(e, String(s._id));
        emailCounts.set(e, (emailCounts.get(e) || 0) + 1);
      }
    }
  }
  storeCursor.close();

  const duplicateEmails = [...emailCounts.entries()].filter(([, n]) => n > 1);
  const storeCount = emailToStoreId.size;
  console.log('Stores: %d (unique vendorEmail %d, duplicate emails: %d)', storeCount, emailToStoreId.size, duplicateEmails.length);
  if (duplicateEmails.length) {
    console.log('  Duplicate vendorEmail rows (review manually):');
    for (const [e, n] of duplicateEmails) console.log('    %s -> %d stores', e, n);
  }
  console.log('');

  // 2) For each ownership group, report current state and (in apply mode) backfill storeId.
  const overall = { total: 0, alreadyHasStoreId: 0, legacyOnly: 0, missingBoth: 0, backfilled: 0, skippedAmbiguous: 0, failed: 0 };

  // 2.5) Track the store↔email map the migration is using, so the verifier can confirm it.
  const appliedEmailValues = new Map();

  for (const group of OWNERSHIP_GROUPS) {
    const col = db.collection(group.name);
    const stats = { total: 0, alreadyHasStoreId: 0, legacyOnly: 0, missingBoth: 0, backfilled: 0, skippedAmbiguous: 0, failed: 0 };

    const cursor = col.find({}).batchSize(500);
    let more = true;
    while (more) {
      const batch = await cursor.fetchNext();
      if (!batch || batch.length === 0) { more = false; continue; }

      for (const doc of batch) {
        stats.total++;
        overall.total++;

        const storeId = doc[group.storeIdField];
        const emailRaw = doc[group.legacyField];
        const hasStoreId = Types.ObjectId.isValid(storeId);
        const hasEmail = typeof emailRaw === 'string' && emailRaw.trim().length > 0;

        if (hasStoreId) {
          stats.alreadyHasStoreId++;
          overall.alreadyHasStoreId++;
          continue;
        }

        if (!hasEmail) {
          stats.missingBoth++;
          overall.missingBoth++;
          continue;
        }

        // Legacy-only: has vendorEmail, no storeId.
        const email = emailRaw.toLowerCase();
        const resolved = emailToStoreId.get(email);

        if (resolved == null) {
          // No matching store for this email: ambiguous / orphan. Do not guess.
          stats.skippedAmbiguous++;
          overall.skippedAmbiguous++;
          continue;
        }

        stats.legacyOnly++;
        overall.legacyOnly++;

        if (APPLY) {
          try {
            const set = {};
            set[group.storeIdField] = new Types.ObjectId(resolved);
            await col.updateOne({ _id: doc._id, [group.storeIdField]: { $exists: false } }, { $set: set });
            set[group.storeIdField] = new Types.ObjectId(resolved);
            await col.updateOne({ _id: doc._id, [group.storeIdField]: { $exists: false } }, { $set: set });
            stats.backfilled++;
            overall.backfilled++;

            // Record the ownership email the backfill resolved on so the verifier can
            // confirm the doc still maps to the same store.
            appliedEmailValues.set(String(doc._id), email);
          } catch (err) {
            stats.failed++;
            overall.failed++;
            console.error('  Failed to backfill %s %s: %s', group.name, String(doc._id), err.message);
          }
        }
      }
    }
    cursor.close();

    console.log('Collection %-22s: total=%d alreadyHasStoreId=%d legacyOnly=%d missingBoth=%d backfilled=%d skippedAmbiguous=%d failed=%d',
      group.name, stats.total, stats.alreadyHasStoreId, stats.legacyOnly, stats.missingBoth, stats.backfilled, stats.skippedAmbiguous, stats.failed);
  }

  console.log('');
  console.log('OVERALL: total=%d alreadyHasStoreId=%d legacyOnly=%d missingBoth=%d backfilled=%d skippedAmbiguous=%d failed=%d',
    overall.total, overall.alreadyHasStoreId, overall.legacyOnly, overall.missingBoth, overall.backfilled, overall.skippedAmbiguous, overall.failed);

  if (APPLY && overall.failed > 0) {
    console.log('');
    console.log('WARNING: some backfills failed. Review the failures above before re-running.');
  }
  if (overall.skippedAmbiguous > 0) {
    console.log('');
    console.log('Some documents could not be auto-mapped (no matching store email). These must be reviewed manually.');
  }

  // Emit the applied-email mapping as JSON so the verifier and any rollback path can
  // reproduce or inspect what was written. This is a plain informational artifact, not
  // a write-ahead log — the migration is idempotent and derived from the stores collection.
  if (APPLY) {
    console.log('');
    console.log('--- Applied store↔email mapping (for rollback / verification) ---');
    console.log('Counts by collection and email (legacy doc count -> storeId):');
    const byPhone = new Map< string, Map<string, number>>();
    for (const [docId, email] of appliedEmailValues) {
      const bucket = byPhone.get(email) ?? new Map();
      bucket.set(docId, (bucket.get(docId) || 0) + 1);
      byPhone.set(email, bucket);
    }

    let totalWritten = 0;
    for (const [email, buckets] of byPhone) {
      let writtenInEmail = 0;
      for (const [, count] of buckets) writtenInEmail += count;
      totalWritten += writtenInEmail;
      console.log('  %s  ->  %d doc(s)', email, writtenInEmail);
    }
    console.log('Total backfilled docs (with a matched email): %d', totalWritten);
  }

  await client.close();
  process.exit(overall.failed > 0 ? 3 : 1);
}

main().catch((err) => {
  console.error('Migration script crashed:', err);
  process.exit(4);
});
