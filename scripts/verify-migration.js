require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/imraaah';

async function run() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db();
  const orders = db.collection('orders');

  console.log('=== STATUSES IN DB ===');
  const statuses = await db.collection('orderstatuses').find({}).sort({ sortOrder: 1 }).toArray();
  for (const s of statuses) {
    console.log(`  ${s.slug.padEnd(12)} _id=${String(s._id).slice(-8).padEnd(10)} en=${s.nameEn.padEnd(20)} fr=${s.nameFr.padEnd(20)} ar=${s.nameAr}`);
  }

  console.log('\n=== STATUS COUNTS PER ID ===');
  const counts = await orders.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]).toArray();
  for (const c of counts) {
    const slug = c._id ? (statuses.find(s => String(s._id) === String(c._id))?.slug || 'UNKNOWN') : 'MISSING';
    console.log(`  ${slug.padEnd(12)} → ${c.count} orders`);
  }

  // Verify no string statuses remain
  const stringStatuses = await orders.countDocuments({ status: { $type: 'string' } });
  console.log(`\nOrders with STRING status (should be 0): ${stringStatuses}`);

  // Verify no history entries with string statuses
  const stringHistory = await orders.countDocuments({ 'history.status': { $type: 'string' } });
  console.log(`Orders with STRING history status (should be 0): ${stringHistory}`);

  // Check total orders
  const totalOrders = await orders.countDocuments();
  console.log(`Total orders in DB: ${totalOrders}`);

  await client.close();
}
run().catch(e => { console.error(e); process.exit(1); });
