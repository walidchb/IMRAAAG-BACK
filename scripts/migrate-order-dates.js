/**
 * Migration: Normalize Order Date Fields to Date Objects
 *
 * Run: node scripts/migrate-order-dates.js
 *
 * Before running, set MONGODB_URI env var or update the default below.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI environment variable is required');
  process.exit(1);
}

const FIELDS = ['date', 'createdAt', 'confirmedAt', 'dispatchedAt'];
const HISTORY_DATE_PATH = 'history.date';

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const orders = db.collection('orders');

  let totalConverted = 0;
  let totalErrors = 0;

  for (const field of FIELDS) {
    const cursor = orders.find({
      [field]: { $type: 'string' },
    });
    let batch = [];
    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      const val = doc[field];
      const parsed = new Date(val);
      if (isNaN(parsed.getTime())) {
        console.warn(`Skipping ${doc._id}.${field}: unparseable date "${val}"`);
        totalErrors++;
        continue;
      }
      batch.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { [field]: parsed } },
        },
      });
      if (batch.length >= 500) {
        const result = await orders.bulkWrite(batch);
        totalConverted += result.modifiedCount;
        batch = [];
      }
    }
    if (batch.length > 0) {
      const result = await orders.bulkWrite(batch);
      totalConverted += result.modifiedCount;
    }
    console.log(`Converted ${field}: ${totalConverted} documents`);
    totalConverted = 0;
  }

  // Convert history[].date
  const historyCursor = orders.find({
    'history.date': { $type: 'string' },
  });
  let historyBatch = [];
  while (await historyCursor.hasNext()) {
    const doc = await historyCursor.next();
    const updatedHistory = (doc.history || []).map(entry => {
      if (typeof entry.date === 'string') {
        const parsed = new Date(entry.date);
        if (!isNaN(parsed.getTime())) {
          return { ...entry, date: parsed };
        }
        console.warn(`Skipping ${doc._id}.history.date: unparseable "${entry.date}"`);
      }
      return entry;
    });
    historyBatch.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { history: updatedHistory } },
      },
    });
    if (historyBatch.length >= 500) {
      const result = await orders.bulkWrite(historyBatch);
      totalConverted += result.modifiedCount;
      historyBatch = [];
    }
  }
  if (historyBatch.length > 0) {
    const result = await orders.bulkWrite(historyBatch);
    totalConverted += result.modifiedCount;
  }
  console.log(`Converted history.date: ${totalConverted} documents`);

  await mongoose.disconnect();

  const remaining = await orders.countDocuments({
    $or: [
      ...FIELDS.map(f => ({ [f]: { $type: 'string' } })),
      { 'history.date': { $type: 'string' } },
    ],
  });
  console.log(`\nDone. Remaining string dates: ${remaining}. Errors: ${totalErrors}`);
  if (remaining > 0) {
    console.log('Some dates could not be converted. Check warnings above.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
