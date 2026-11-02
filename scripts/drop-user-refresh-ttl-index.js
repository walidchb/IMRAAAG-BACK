require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');

/**
 * Production-readiness C3 — remove the `refreshTokenExpiresAt` TTL index from `users`.
 *
 * A TTL index expires the whole DOCUMENT, not the field. Because
 * `AuthService.storeRefreshToken()` stamps `refreshTokenExpiresAt` on every login/refresh
 * (+30 days), MongoDB silently deleted every account that had not signed in for about a month
 * after its refresh token expired. The account's orders (keyed by `vendorEmail`) and store
 * row survived, leaving dangling references and an irreversible loss of user data.
 *
 * The declaration was removed from `user.schema.ts`; this script removes the index that is
 * still present in an existing database. Index expiry is enforced in
 * `AuthService.refreshAccessToken()` instead, which clears the stale token fields on read.
 *
 * This script:
 *   1. lists every TTL index on `users` (dry run by default);
 *   2. drops the ones keyed on `refreshTokenExpiresAt` with `--apply`;
 *   3. never deletes a document and never touches any other index.
 *
 * Run: node scripts/drop-user-refresh-ttl-index.js [--apply]
 */

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const COLLECTION = 'users';
const TARGET_KEY = 'refreshTokenExpiresAt';

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const collection = db.collection(COLLECTION);
  const indexes = await collection.indexes();

  const ttlIndexes = indexes.filter(
    (index) => index.expireAfterSeconds !== undefined && Object.keys(index.key).includes(TARGET_KEY),
  );

  console.log(`[C3] ${COLLECTION}: ${indexes.length} index(es) found.`);
  for (const index of indexes) {
    const isTarget = ttlIndexes.some((t) => t.name === index.name);
    console.log(
      `  ${isTarget ? 'TARGET' : 'keep  '} ${index.name} ${JSON.stringify(index.key)}` +
        (index.expireAfterSeconds !== undefined ? ` expireAfterSeconds=${index.expireAfterSeconds}` : ''),
    );
  }

  if (ttlIndexes.length === 0) {
    console.log('[C3] No TTL index on refreshTokenExpiresAt. Nothing to do.');
    return;
  }

  if (!APPLY) {
    console.log(
      `\n[C3] DRY RUN — ${ttlIndexes.length} TTL index(es) would be dropped. Re-run with --apply to remove them.`,
    );
    return;
  }

  for (const index of ttlIndexes) {
    await collection.dropIndex(index.name);
    console.log(`[C3] Dropped ${index.name}.`);
  }

  console.log('[C3] Done. Existing user documents were not modified.');
}

main()
  .catch((err) => {
    console.error('[C3] FAILED:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
