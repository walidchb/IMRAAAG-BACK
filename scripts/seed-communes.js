const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://***REMOVED***:***REMOVED***@ac-wd9znsx-shard-00-00.on0pbcb.mongodb.net:27017,ac-wd9znsx-shard-00-01.on0pbcb.mongodb.net:27017,ac-wd9znsx-shard-00-02.on0pbcb.mongodb.net:27017/?ssl=true&replicaSet=atlas-bb0bfr-shard-0&authSource=admin&appName=cluster-imraaah-dev';

const communeSchema = new mongoose.Schema({
  post_code: { type: String, required: true },
  name: { type: String, required: true },
  ar_name: String,
  longitude: String,
  latitude: String,
  wilaya_code: { type: String, required: true },
  zrexpress_uuid: String,
  yalidine_uuid: String,
}, { timestamps: true });

const Commune = mongoose.model('Commune', communeSchema);

async function main() {
  const raw = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../algeria_postcodes.json'), 'utf8'
  ));

  const communeMap = new Map();
  raw.forEach(p => {
    const key = p.commune_id;
    if (!communeMap.has(key)) {
      communeMap.set(key, {
        post_code: p.post_code,
        name: p.commune_name_ascii,
        ar_name: p.commune_name,
        wilaya_code: String(parseInt(p.wilaya_code, 10)),
      });
    }
  });

  const communes = [...communeMap.values()];
  console.log(`Loaded ${communes.length} unique communes`);

  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  await Commune.deleteMany({});
  console.log('Cleared old communes');

  const inserted = await Commune.insertMany(communes);
  console.log(`Inserted ${inserted.length} communes`);

  await mongoose.disconnect();
  console.log('Done');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
