/**
 * Migration: split the legacy single `stores.status` into the two authoritative statuses.
 *
 *   ownerStatus: Enabled | Disabled        (seller-controlled)
 *   adminStatus: Active  | Suspended       (IMRAAAH-controlled)
 *   status:      Active/Paused/Closed      (derived compatibility mirror)
 *
 * Mapping for legacy documents:
 *   Active  -> owner Enabled,  admin Active
 *   Paused  -> owner Disabled, admin Active
 *   Closed  -> owner Enabled,  admin Suspended   (admin reactivation restores availability)
 *   missing -> owner Enabled,  admin Active      (never disable a store by accident)
 *
 * The script is idempotent: it only fills missing values, then recomputes the legacy mirror
 * from the two authoritative fields. Run it before enabling the new backend code.
 *
 * Usage:
 *   node scripts/migrate-store-status.js --dry-run   (default)
 *   node scripts/migrate-store-status.js --apply
 *
 * BEFORE RUNNING: take a MongoDB backup (the script also writes a small status backup).
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI environment variable is required');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const dryRun = !apply;

const OWNER_ENABLED = 'Enabled';
const OWNER_DISABLED = 'Disabled';
const ADMIN_ACTIVE = 'Active';
const ADMIN_SUSPENDED = 'Suspended';

function ownerExpr() {
  return {
    $ifNull: [
      '$ownerStatus',
      {
        $cond: [{ $eq: ['$status', 'Paused'] }, OWNER_DISABLED, OWNER_ENABLED],
      },
    ],
  };
}

function adminExpr() {
  return {
    $ifNull: [
      '$adminStatus',
      {
        $cond: [{ $eq: ['$status', 'Closed'] }, ADMIN_SUSPENDED, ADMIN_ACTIVE],
      },
    ],
  };
}

function statusExpr(owner, admin) {
  return {
    $cond: [
      { $eq: [admin, ADMIN_SUSPENDED] },
      'Closed',
      { $cond: [{ $eq: [owner, OWNER_DISABLED] }, 'Paused', 'Active'] },
    ],
  };
}

async function distribution(col) {
  const rows = await col
    .aggregate([
      {
        $group: {
          _id: {
            status: '$status',
            owner: '$ownerStatus',
            admin: '$adminStatus',
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.status': 1, '_id.owner': 1, '_id.admin': 1 } },
    ])
    .toArray();
  return rows
    .map(
      (r) =>
        `${r._id.status ?? '(none)'} / ${r._id.owner ?? '(none)'} / ${
          r._id.admin ?? '(none)'
        } = ${r.count}`,
    )
    .join('\n  ');
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const col = db.collection('stores');

  const total = await col.countDocuments({});
  const missingOwner = await col.countDocuments({
    $or: [{ ownerStatus: { $exists: false } }, { ownerStatus: null }],
  });
  const missingAdmin = await col.countDocuments({
    $or: [{ adminStatus: { $exists: false } }, { adminStatus: null }],
  });

  console.log(`[STORE-STATUS MIGRATION] Connected. Mode: ${dryRun ? 'DRY RUN' : 'APPLY'}`);
  console.log(`[STORE-STATUS MIGRATION] stores=${total}`);
  console.log(`[STORE-STATUS MIGRATION] missing ownerStatus=${missingOwner}, adminStatus=${missingAdmin}`);
  console.log('[STORE-STATUS MIGRATION] before:\n  ' + (await distribution(col)));

  if (dryRun) {
    console.log('[STORE-STATUS MIGRATION] DRY RUN COMPLETE (nothing written)');
    await mongoose.disconnect();
    return;
  }

  const backupName = `stores_status_backup_${Date.now()}`;
  await col
    .aggregate([
      { $project: { _id: 1, status: 1, ownerStatus: 1, adminStatus: 1 } },
      { $out: backupName },
    ])
    .toArray();
  console.log(`[STORE-STATUS MIGRATION] backup written to ${backupName}`);

  const owner = ownerExpr();
  const admin = adminExpr();
  const result = await col.updateMany(
    {},
    [
      {
        $set: {
          ownerStatus: owner,
          adminStatus: admin,
          status: statusExpr(owner, admin),
        },
      },
    ],
  );

  console.log(
    `[STORE-STATUS MIGRATION] matched=${result.matchedCount}, modified=${result.modifiedCount}`,
  );
  console.log('[STORE-STATUS MIGRATION] after:\n  ' + (await distribution(col)));

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[STORE-STATUS MIGRATION] FAILED', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
