const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const MONGO_URI = 'mongodb://***REMOVED***:***REMOVED***@ac-wd9znsx-shard-00-00.on0pbcb.mongodb.net:27017,ac-wd9znsx-shard-00-01.on0pbcb.mongodb.net:27017,ac-wd9znsx-shard-00-02.on0pbcb.mongodb.net:27017/?ssl=true&replicaSet=atlas-bb0bfr-shard-0&authSource=admin&appName=cluster-imraaah-dev';

async function main() {
  await mongoose.connect(MONGO_URI);

  const desksPath = path.resolve(__dirname, '../stopdesksecom.json');
  const rawDesks = JSON.parse(fs.readFileSync(desksPath, 'utf-8'));
  console.log(`Loaded ${rawDesks.length} Ecom Delivery stopdesks`);

  const desks = rawDesks.map(d => ({
    code_stopdesk: d.code_stopdesk,
    nom_bureau: d.nom_bureau,
    wilayaCode: String(d.id_wilaya),
    commune: d.commune,
    adresse: d.adresse || null,
    adresse_maps: d.adresse_maps || null,
    tel_contact: d.tel_contact,
    ecomId: d.id,
  }));

  // Clear existing
  await mongoose.connection.db.collection('ecomdesks').deleteMany({});
  console.log('Cleared existing ecomdesks');

  // Insert
  const result = await mongoose.connection.db.collection('ecomdesks').insertMany(desks);
  console.log(`Inserted ${result.insertedCount} ecomdesks`);

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
