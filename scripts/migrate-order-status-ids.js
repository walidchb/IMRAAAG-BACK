const { connect, connection, Types } = require('mongoose');
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/imraaah';

const LEGACY_SLUG_MAP = {
  placed: 'placed',
  confirmed: 'confirmed',
  dispatched: 'dispatched',
  shipping: 'in-transit',
  delivered: 'delivered',
  cancelled: 'cancelled',
  returned: 'returned',
};

async function migrate() {
  await connect(MONGO_URI);
  const db = connection.db;

  // Build slug → ObjectId map from the statuses collection
  const statusDocs = await db.collection('orderstatuses').find({}).toArray();
  const slugToId = {};
  for (const doc of statusDocs) {
    slugToId[doc.slug] = doc._id;
  }

  console.log('Status slug → ID map:', Object.fromEntries(
    Object.entries(slugToId).map(([k, v]) => [k, String(v)])
  ));

  // Migrate orders
  const ordersCol = db.collection('orders');
  const ordersWithStrings = await ordersCol.find({ status: { $type: 'string' } }).toArray();
  console.log(`Found ${ordersWithStrings.length} orders with string statuses.`);

  for (const order of ordersWithStrings) {
    const newSlug = LEGACY_SLUG_MAP[order.status];
    const newId = newSlug ? slugToId[newSlug] : slugToId[order.status];

    if (!newId) {
      console.warn(`  Skipping order ${order.orderNo}: unknown status "${order.status}"`);
      continue;
    }

    // Migrate history entries
    let newHistory = order.history || [];
    let historyChanged = false;
    newHistory = newHistory.map(entry => {
      if (typeof entry.status === 'string') {
        historyChanged = true;
        const hs = LEGACY_SLUG_MAP[entry.status] || entry.status;
        return { ...entry, status: slugToId[hs] || entry.status };
      }
      return entry;
    });

    const update = {
      $set: {
        status: newId,
      },
    };
    if (historyChanged) {
      update.$set.history = newHistory;
    }

    await ordersCol.updateOne({ _id: order._id }, update);
  }

  console.log(`Migrated ${ordersWithStrings.length} orders.`);

  // Mark the migration
  await connection.close();
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
