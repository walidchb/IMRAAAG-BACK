const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/imraaah';

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const dhdCommunes = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../dhdcommunes.json'), 'utf8'
  ));

  const desks = [];
  for (const c of dhdCommunes) {
    if (c.has_stop_desk !== 1 || !c.station_info) continue;

    const wilayaCode = String(c.wilaya_id);
    const hubs = c.station_info.hub_location || [];

    for (const hub of hubs) {
      desks.push({
        nom: c.nom,
        wilayaCode,
        commune: hub.hub_location_commune || c.nom,
        adresse: hub.hub_location_adresse || '',
        phone: hub.hub_location_phone || '',
        mapLink: hub.hub_location_map || '',
        workingDays: c.station_info.hub_working_days || [],
      });
    }
  }

  console.log(`Extracted ${desks.length} DHD desks from ${dhdCommunes.filter(c => c.has_stop_desk === 1).length} communes with stop desks`);

  const db = mongoose.connection.db;
  const collection = db.collection('dhddesks');

  await collection.deleteMany({});
  console.log('Cleared existing dhddesks');

  if (desks.length > 0) {
    const result = await collection.insertMany(desks);
    console.log(`Inserted ${result.insertedCount} dhddesks`);
  }

  // Show summary by wilaya
  const byWilaya = {};
  for (const d of desks) {
    byWilaya[d.wilayaCode] = (byWilaya[d.wilayaCode] || 0) + 1;
  }
  console.log('\nDesks per wilaya:');
  Object.entries(byWilaya)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .forEach(([w, count]) => console.log(`  Wilaya ${w}: ${count} desks`));

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
