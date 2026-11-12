/**
 * Migration: create the Team Management indexes.
 *
 * Collections: `storemembers`, `storeinvitations`.
 *
 * Run:
 *   node scripts/migrate-store-team-indexes.js            (dry run, default)
 *   node scripts/migrate-store-team-indexes.js --apply    (create indexes)
 *
 * There are deliberately no TTL indexes on either collection: expiry is enforced logically
 * and a TTL would delete documents rather than merely expire them.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const { Types } = mongoose;

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI environment variable is required');
  process.exit(1);
}

const apply = process.argv.includes('--apply');

const INDEXES = {
  storemembers: [
    { keys: { storeId: 1, userId: 1 }, options: { unique: true, name: 'storeId_1_userId_1' } },
    { keys: { userId: 1, status: 1 }, options: { name: 'userId_1_status_1' } },
    { keys: { storeId: 1, status: 1, role: 1 }, options: { name: 'storeId_1_status_1_role_1' } },
    // Declared by the two @Prop({ index: true }) fields.
    { keys: { storeId: 1 }, options: { name: 'storeId_1' } },
    { keys: { userId: 1 }, options: { name: 'userId_1' } },
  ],
  storeinvitations: [
    { keys: { tokenHash: 1 }, options: { unique: true, name: 'tokenHash_1' } },
    { keys: { storeId: 1, email: 1, status: 1 }, options: { name: 'storeId_1_email_1_status_1' } },
    {
      keys: { storeId: 1, email: 1 },
      options: {
        unique: true,
        name: 'storeId_1_email_1_pending',
        partialFilterExpression: { status: 'pending' },
      },
    },
    { keys: { storeId: 1, status: 1, createdAt: -1 }, options: { name: 'storeId_1_status_1_createdAt_-1' } },
    { keys: { expiresAt: 1 }, options: { name: 'expiresAt_1' } },
    { keys: { storeId: 1 }, options: { name: 'storeId_1' } },
    { keys: { email: 1 }, options: { name: 'email_1' } },
  ],
};

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log(`[TEAM INDEXES] Connected. Apply: ${apply ? 'YES' : 'NO (dry run)'}`);

  for (const [collection, specs] of Object.entries(INDEXES)) {
    const exists = (await db.listCollections().toArray()).some((c) => c.name === collection);
    if (!exists) {
      console.log(`[TEAM INDEXES] ${collection}: collection does not exist yet (nothing to do)`);
      continue;
    }

    const current = await db.collection(collection).indexes();
    const currentNames = new Set(current.map((i) => i.name));
    for (const spec of specs) {
      const name = spec.options.name;
      if (currentNames.has(name)) {
        console.log(`[TEAM INDEXES] ${collection}.${name}: present`);
        continue;
      }
      if (!apply) {
        console.log(`[TEAM INDEXES] ${collection}.${name}: MISSING (would create)`);
        continue;
      }
      await db.collection(collection).createIndex(spec.keys, spec.options);
      console.log(`[TEAM INDEXES] ${collection}.${name}: created`);
    }
  }

  console.log('[TEAM INDEXES] Done.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[TEAM INDEXES] FAILED:', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
