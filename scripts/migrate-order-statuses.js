const { connect, connection } = require('mongoose');
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/imraaah';

const STATUS_MAP = {
  Placed: 'placed',
  Confirmed: 'confirmed',
  Shipped: 'dispatched',
  Delivered: 'delivered',
  Cancelled: 'cancelled',
};

async function migrate() {
  await connect(MONGO_URI);

  const db = connection.db;
  const orders = db.collection('orders');

  const oldStatuses = Object.keys(STATUS_MAP);
  const cursor = orders.find({ status: { $in: oldStatuses } });

  let matched = 0;
  let updated = 0;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    matched++;

    const newStatus = STATUS_MAP[doc.status];
    if (!newStatus) continue;

    const newHistory = (doc.history || []).map((entry) => ({
      ...entry,
      status: STATUS_MAP[entry.status] || entry.status,
    }));

    await orders.updateOne(
      { _id: doc._id },
      {
        $set: { status: newStatus, history: newHistory },
      },
    );

    updated++;
  }

  console.log(`Matched ${matched} orders with old statuses, updated ${updated}.`);
  console.log('Mapping applied:', JSON.stringify(STATUS_MAP));

  await connection.close();
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
