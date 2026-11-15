/**
 * Backfill `confirmedBy` / `dispatchedBy` / `cancelledBy` (and legacy `history[].user`)
 * with the team member who actually performed the action.
 *
 * Why: before the attribution fix, `OrdersService.update()` trusted the client-supplied
 * `createdBy` when writing `confirmedBy` and the history entry. The vendor dashboard echoes
 * the stored order back, so an order confirmed from the edit dialog was credited to its
 * original creator (or the literal `'Vendor'` fallback), not to the acting employee. The
 * order's own history often still has the actor's login email, and the audit trail
 * (`auditlogs`, action `ORDER_STATUS_CHANGE`) always does.
 *
 * Resolution order per action:
 *   1. the latest audit entry for that order + status (`userId`/`actorEmail`), resolved to
 *      `FullName (email)` through the `users` collection;
 *   2. otherwise the order's own history entry for that status, when it names someone.
 *
 * Only missing / `'Vendor'` / empty values are written, so the script is idempotent and never
 * overwrites a correct attribution. History entries are repaired only when they are
 * `'Vendor'`/empty AND an audit entry matches them by status and time (10-minute window).
 *
 * Run:
 *   node scripts/backfill-order-actors.js            # dry run (nothing written)
 *   node scripts/backfill-order-actors.js --apply    # write
 *
 * BEFORE RUNNING: take a MongoDB backup.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI environment variable is required');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const STATUSES = ['confirmed', 'dispatched', 'cancelled'];
const FIELD_FOR = { confirmed: 'confirmedBy', dispatched: 'dispatchedBy', cancelled: 'cancelledBy' };
const MATCH_WINDOW_MS = 10 * 60 * 1000;
const GENERIC = new Set(['', 'vendor', 'system', 'customer']);

const slugOf = (status) => (typeof status === 'string' ? status : status && status.slug) || null;

function isGeneric(value) {
  return typeof value !== 'string' || GENERIC.has(value.trim().toLowerCase());
}

function labelFor(user) {
  if (!user) return null;
  const name = (user.fullName || '').trim();
  const email = (user.email || '').trim();
  if (name && email && name.toLowerCase() !== email.toLowerCase()) return `${name} (${email})`;
  return name || email || null;
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const orders = db.collection('orders');
  const audits = db.collection('auditlogs');
  const users = db.collection('users');

  console.log(`[ORDER-ACTOR BACKFILL] Connected. Apply: ${APPLY ? 'YES' : 'NO (dry run)'}`);

  // Resolve the audit actor's display label once per distinct user.
  const userLabelCache = new Map();
  async function labelForAuditEntry(entry) {
    const key = entry.userId ? String(entry.userId) : entry.actorEmail || '';
    if (!key) return null;
    if (userLabelCache.has(key)) return userLabelCache.get(key);
    let user = null;
    if (entry.userId) {
      user = await users.findOne(
        { _id: entry.userId },
        { projection: { fullName: 1, email: 1 } },
      );
    }
    if (!user && entry.actorEmail) {
      user = await users.findOne(
        { email: entry.actorEmail },
        { projection: { fullName: 1, email: 1 } },
      );
    }
    const label = user
      ? labelFor(user)
      : entry.actorEmail
        ? entry.actorEmail
        : null;
    userLabelCache.set(key, label);
    return label;
  }

  const total = await orders.countDocuments({});
  console.log(`[ORDER-ACTOR BACKFILL] orders=${total}`);

  let scanned = 0;
  let fieldWrites = 0;
  let historyWrites = 0;
  let ordersTouched = 0;

  const cursor = orders.find(
    {},
    { projection: { orderNo: 1, status: 1, history: 1, confirmedBy: 1, dispatchedBy: 1, cancelledBy: 1 } },
  );

  for await (const order of cursor) {
    scanned += 1;
    const history = Array.isArray(order.history) ? order.history : [];
    const auditEntries = await audits
      .find({
        action: 'ORDER_STATUS_CHANGE',
        resourceId: order._id,
      })
      .toArray();

    // Latest audit entry per status (a re-dispatch supersedes an earlier one).
    const latestAudit = new Map();
    for (const entry of auditEntries) {
      const to = entry.details && entry.details.to;
      if (!STATUSES.includes(to)) continue;
      const prev = latestAudit.get(to);
      if (!prev || new Date(entry.createdAt) > new Date(prev.createdAt)) latestAudit.set(to, entry);
    }

    const auditLabels = new Map();
    for (const [status, entry] of latestAudit) {
      const label = await labelForAuditEntry(entry);
      if (label) auditLabels.set(status, label);
    }

    // The last history entry naming someone for each status, as the fallback.
    const historyLabels = new Map();
    for (const entry of history) {
      const slug = slugOf(entry.status);
      if (!STATUSES.includes(slug)) continue;
      if (!isGeneric(entry.user)) historyLabels.set(slug, entry.user);
    }

    const $set = {};
    for (const status of STATUSES) {
      const field = FIELD_FOR[status];
      if (!isGeneric(order[field])) continue;
      const label = auditLabels.get(status) || historyLabels.get(status);
      if (label && label !== order[field]) {
        $set[field] = label;
        fieldWrites += 1;
      }
    }

    // Repair only generic history entries that an audit entry can pin to a moment in time.
    let historyChanged = false;
    const nextHistory = history.map((entry) => {
      const slug = slugOf(entry.status);
      if (!STATUSES.includes(slug) || !isGeneric(entry.user)) return entry;
      const at = entry.date ? new Date(entry.date).getTime() : null;
      if (at == null) return entry;
      let best = null;
      let bestDelta = Infinity;
      for (const candidate of auditEntries) {
        if (!candidate.details || candidate.details.to !== slug) continue;
        const delta = Math.abs(new Date(candidate.createdAt).getTime() - at);
        if (delta < bestDelta) {
          best = candidate;
          bestDelta = delta;
        }
      }
      if (!best || bestDelta > MATCH_WINDOW_MS) return entry;
      const label = auditLabels.get(slug) || null;
      if (!label) return entry;
      historyChanged = true;
      return { ...entry, user: label };
    });

    if (historyChanged) $set.history = nextHistory;

    if (Object.keys($set).length > 0) {
      ordersTouched += 1;
      if (historyChanged) historyWrites += 1;
      const preview = Object.entries($set)
        .filter(([key]) => key !== 'history')
        .map(([key, value]) => `${key}=${value}`)
        .join(', ');
      console.log(
        `  order ${order.orderNo} -> ${preview}${historyChanged ? ' (+ history)' : ''}`,
      );
      if (APPLY) {
        await orders.updateOne({ _id: order._id }, { $set });
      }
    }
  }

  console.log(
    `[ORDER-ACTOR BACKFILL] scanned=${scanned}, orders to update=${ordersTouched}, ` +
      `*By fields=${fieldWrites}, history fixed=${historyWrites}`,
  );
  console.log(
    `[ORDER-ACTOR BACKFILL] ${APPLY ? 'Apply complete.' : 'Dry run only. Re-run with --apply to write.'}`,
  );
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
