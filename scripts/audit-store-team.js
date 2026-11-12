/**
 * Read-only drift report for Team Management.
 *
 * Prints counts and the explained skips (stores without a valid `vendorId`, memberships for
 * missing stores/users, invitations whose store no longer exists) without failing. Use this
 * for an operational snapshot; use `verify-store-team.js` as the pass/fail gate.
 *
 * Run: node scripts/audit-store-team.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const { Types } = mongoose;

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI environment variable is required');
  process.exit(1);
}

function asObjectId(value) {
  if (value instanceof Types.ObjectId) return value;
  if (value && Types.ObjectId.isValid(String(value))) return new Types.ObjectId(String(value));
  return null;
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const stores = await db.collection('stores').find({}).toArray();
  const members = await db.collection('storemembers').find({}).toArray();
  const invitations = await db.collection('storeinvitations').find({}).toArray();

  const storeIds = new Set(stores.map((s) => String(s._id)));
  const roles = {};
  const statuses = {};
  for (const m of members) {
    roles[m.role] = (roles[m.role] ?? 0) + 1;
    statuses[m.status] = (statuses[m.status] ?? 0) + 1;
  }
  const invitationStatuses = {};
  for (const inv of invitations) {
    invitationStatuses[inv.status] = (invitationStatuses[inv.status] ?? 0) + 1;
  }

  const missingVendorId = stores.filter((s) => !asObjectId(s.vendorId));
  const orphanMembers = members.filter((m) => !storeIds.has(String(m.storeId)));
  const orphanInvitations = invitations.filter((inv) => !storeIds.has(String(inv.storeId)));

  console.log('[AUDIT TEAM] Snapshot');
  console.log(`  stores: ${stores.length}`);
  console.log(`  stores without valid vendorId: ${missingVendorId.length}`);
  for (const s of missingVendorId) console.log(`    - ${s._id} (vendorId=${s.vendorId})`);
  console.log(`  memberships: ${members.length} ${JSON.stringify(roles)} ${JSON.stringify(statuses)}`);
  console.log(`  orphan memberships: ${orphanMembers.length}`);
  for (const m of orphanMembers) console.log(`    - ${m._id} store=${m.storeId}`);
  console.log(
    `  invitations: ${invitations.length} ${JSON.stringify(invitationStatuses)}`,
  );
  console.log(`  orphan invitations: ${orphanInvitations.length}`);
  for (const inv of orphanInvitations) console.log(`    - ${inv._id} store=${inv.storeId}`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[AUDIT TEAM] FAILED:', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
