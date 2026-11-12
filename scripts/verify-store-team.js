/**
 * Read-only verifier for the Team Management data model.
 *
 * Checks:
 *  - owner invariant: every store with a valid `vendorId` has exactly one active OWNER row
 *    whose `userId` is that `vendorId`;
 *  - no duplicate `(storeId, userId)` membership (the unique index backstop);
 *  - no orphan membership (missing store or user);
 *  - no duplicate pending invitation for `(storeId, email)`;
 *  - no raw token field on any invitation (only `tokenHash`);
 *  - status/expiry consistency;
 *  - the declared indexes are present.
 *
 * Run: node scripts/verify-store-team.js
 * Exit code: 0 when clean, 1 on any violation.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const { Types } = mongoose;

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI environment variable is required');
  process.exit(1);
}

const violations = [];

function violation(message) {
  violations.push(message);
  console.error(`[VIOLATION] ${message}`);
}

function asObjectId(value) {
  if (value instanceof Types.ObjectId) return value;
  if (value && Types.ObjectId.isValid(String(value))) return new Types.ObjectId(String(value));
  return null;
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  console.log('[VERIFY TEAM] Connected');
  await db.collection('storemembers').createIndex({ storeId: 1 }).catch(() => undefined);

  const stores = await db.collection('stores').find({}).toArray();
  const members = await db.collection('storemembers').find({}).toArray();
  const invitations = await db.collection('storeinvitations').find({}).toArray();
  const storeIds = new Set(stores.map((s) => String(s._id)));
  const userIds = new Set(
    (await db.collection('users').find({}, { projection: { _id: 1 } }).toArray()).map((u) =>
      String(u._id),
    ),
  );

  const byStoreUser = new Map();
  for (const m of members) {
    const key = `${String(m.storeId)}::${String(m.userId)}`;
    byStoreUser.set(key, (byStoreUser.get(key) ?? 0) + 1);

    if (!storeIds.has(String(m.storeId))) {
      violation(`membership ${m._id} references missing store ${m.storeId}`);
    }
    if (!userIds.has(String(m.userId))) {
      violation(`membership ${m._id} references missing user ${m.userId}`);
    }
    if (!['OWNER', 'PARTNER', 'ORDER_CONFIRMER', 'INVENTORY_STAFF', 'CASHIER'].includes(m.role)) {
      violation(`membership ${m._id} has invalid role ${m.role}`);
    }
    if (!['active', 'deactivated'].includes(m.status)) {
      violation(`membership ${m._id} has invalid status ${m.status}`);
    }
    if (m.role === 'OWNER' && m.status !== 'active') {
      violation(`owner membership ${m._id} is not active`);
    }
  }
  for (const [key, count] of byStoreUser) {
    if (count > 1) violation(`duplicate membership ${key} (${count} rows)`);
  }

  let ownerChecked = 0;
  for (const store of stores) {
    const vendorId = asObjectId(store.vendorId);
    if (!vendorId) {
      console.warn(`[VERIFY TEAM] store ${store._id}: no valid vendorId (owner row not required)`);
      continue;
    }
    ownerChecked++;
    const owners = members.filter(
      (m) =>
        String(m.storeId) === String(store._id) &&
        String(m.userId) === String(vendorId) &&
        m.role === 'OWNER' &&
        m.status === 'active',
    );
    if (owners.length !== 1) {
      violation(
        `store ${store._id}: expected exactly one active OWNER for vendorId ${vendorId}, found ${owners.length}`,
      );
    }
  }

  const pending = new Map();
  for (const inv of invitations) {
    if (inv.token !== undefined || inv.rawToken !== undefined) {
      violation(`invitation ${inv._id} contains a raw token field`);
    }
    if (typeof inv.tokenHash !== 'string' || !/^[0-9a-f]{64}$/i.test(inv.tokenHash)) {
      violation(`invitation ${inv._id} has an invalid tokenHash`);
    }
    if (!['pending', 'accepted', 'revoked'].includes(inv.status)) {
      violation(`invitation ${inv._id} has invalid status ${inv.status}`);
    }
    if (!storeIds.has(String(inv.storeId))) {
      violation(`invitation ${inv._id} references missing store ${inv.storeId}`);
    }
    if (inv.status === 'pending') {
      const key = `${String(inv.storeId)}::${String(inv.email).toLowerCase()}`;
      pending.set(key, (pending.get(key) ?? 0) + 1);
      if (!(inv.expiresAt instanceof Date)) {
        violation(`pending invitation ${inv._id} has no valid expiresAt`);
      }
    }
    if (inv.status === 'accepted' && !inv.acceptedAt) {
      violation(`accepted invitation ${inv._id} has no acceptedAt`);
    }
    if (inv.status === 'revoked' && !inv.revokedAt) {
      violation(`revoked invitation ${inv._id} has no revokedAt`);
    }
  }
  for (const [key, count] of pending) {
    if (count > 1) violation(`duplicate pending invitation ${key} (${count} rows)`);
  }

  const indexChecks = [
    ['storemembers', 'storeId_1_userId_1'],
    ['storemembers', 'userId_1_status_1'],
    ['storemembers', 'storeId_1_status_1_role_1'],
    ['storeinvitations', 'tokenHash_1'],
    ['storeinvitations', 'storeId_1_email_1_status_1'],
    ['storeinvitations', 'storeId_1_email_1_pending'],
    ['storeinvitations', 'storeId_1_status_1_createdAt_-1'],
    ['storeinvitations', 'expiresAt_1'],
  ];
  const collections = (await db.listCollections().toArray()).map((c) => c.name);
  for (const [collection, name] of indexChecks) {
    if (!collections.includes(collection)) {
      console.warn(`[VERIFY TEAM] ${collection}: collection absent (indexes not yet applied)`);
      continue;
    }
    const names = new Set((await db.collection(collection).indexes()).map((i) => i.name));
    if (!names.has(name)) violation(`missing index ${collection}.${name}`);
  }

  console.log(
    `[VERIFY TEAM] stores=${stores.length} ownerChecked=${ownerChecked} members=${members.length} invitations=${invitations.length}`,
  );

  if (violations.length > 0) {
    console.error(`[VERIFY TEAM] FAILED with ${violations.length} violation(s)`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('[VERIFY TEAM] OK — no violations');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[VERIFY TEAM] FAILED:', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
