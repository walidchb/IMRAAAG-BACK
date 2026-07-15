/**
 * Migration script: Convert deliveryfees from per-wilaya docs to single doc per vendor.
 * 
 * BEFORE: 58 docs per vendor (one per wilayaCode)
 * AFTER:  1 doc per vendor with nested fees map
 * 
 * Run: node scripts/migrate-delivery-fees.js
 */
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const db = mongoose.connection.db;
  const collection = db.collection('deliveryfees');

  // Check if there are old-format docs (with wilayaCode field)
  const oldFormatCount = await collection.countDocuments({ wilayaCode: { $exists: true } });
  const newFormatCount = await collection.countDocuments({ fees: { $exists: true } });
  console.log(`Old format docs (per wilaya): ${oldFormatCount}`);
  console.log(`New format docs (single doc): ${newFormatCount}`);

  if (oldFormatCount === 0) {
    console.log('No old-format documents found. Migration not needed.');
    await mongoose.disconnect();
    return;
  }

  // Read all old-format docs
  const oldDocs = await collection.find({ wilayaCode: { $exists: true } }).toArray();
  console.log(`Read ${oldDocs.length} old-format documents`);

  // Group by vendorEmail
  const grouped = new Map();
  for (const doc of oldDocs) {
    const email = doc.vendorEmail;
    if (!email) continue;
    if (!grouped.has(email)) {
      grouped.set(email, {});
    }
    const fees = grouped.get(email);
    fees[doc.wilayaCode] = {
      homeDeliveryFee: doc.homeDeliveryFee ?? 0,
      stopDeskDeliveryFee: doc.stopDeskDeliveryFee ?? 0,
    };
  }
  console.log(`Grouped into ${grouped.size} vendors`);

  // Insert new-format docs
  const newDocs = [];
  for (const [vendorEmail, fees] of grouped.entries()) {
    newDocs.push({
      vendorEmail,
      fees,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  if (newDocs.length > 0) {
    await collection.insertMany(newDocs);
    console.log(`Inserted ${newDocs.length} new-format documents`);
  }

  // Delete old-format docs
  const deleteResult = await collection.deleteMany({ wilayaCode: { $exists: true } });
  console.log(`Deleted ${deleteResult.deletedCount} old-format documents`);

  // Create the new index (drop old index if exists)
  try {
    await collection.dropIndex('vendorEmail_1_wilayaCode_1');
    console.log('Dropped old compound index');
  } catch {
    console.log('Old compound index not found (already dropped)');
  }

  try {
    await collection.createIndex({ vendorEmail: 1 }, { unique: true });
    console.log('Created new unique index on vendorEmail');
  } catch (err) {
    console.error('Failed to create index:', err.message);
  }

  // Verify
  const finalCount = await collection.countDocuments();
  const newFormatFinal = await collection.countDocuments({ fees: { $exists: true } });
  console.log(`\nFinal collection count: ${finalCount}`);
  console.log(`New format docs: ${newFormatFinal}`);
  console.log('Migration completed successfully!');

  await mongoose.disconnect();
}

main().catch(err => { console.error('Migration failed:', err); process.exit(1); });