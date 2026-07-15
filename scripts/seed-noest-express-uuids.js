const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI);

  // Update wilayas: noestexpress_uuid = code
  const wilayaRes = await mongoose.connection.db.collection('wilayas').updateMany(
    {},
    [{ $set: { noestexpress_uuid: '$code' } }]
  );
  console.log(`Wilayas updated: ${wilayaRes.modifiedCount}`);

  // Update communes: noestexpress_uuid = post_code
  const communeRes = await mongoose.connection.db.collection('communes').updateMany(
    {},
    [{ $set: { noestexpress_uuid: '$post_code' } }]
  );
  console.log(`Communes updated: ${communeRes.modifiedCount}`);

  // Verify
  const wilayaCount = await mongoose.connection.db.collection('wilayas').countDocuments({ noestexpress_uuid: { $exists: true, $ne: null } });
  const communeCount = await mongoose.connection.db.collection('communes').countDocuments({ noestexpress_uuid: { $exists: true, $ne: null } });
  console.log(`Wilayas with noestexpress_uuid: ${wilayaCount}`);
  console.log(`Communes with noestexpress_uuid: ${communeCount}`);

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
