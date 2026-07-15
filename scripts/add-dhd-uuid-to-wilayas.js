const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/imraaah';

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const db = mongoose.connection.db;
  const collection = db.collection('wilayas');

  const result = await collection.updateMany(
    { dhd_uuid: { $exists: false } },
    [{ $set: { dhd_uuid: '$code' } }]
  );

  console.log(`Matched ${result.matchedCount} documents`);
  console.log(`Modified ${result.modifiedCount} documents`);
  console.log('Done: dhd_uuid added to all wilayas with same value as code.');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
