const mongoose = require('mongoose');
const MONGO_URI = 'mongodb://***REMOVED***:***REMOVED***@ac-wd9znsx-shard-00-00.on0pbcb.mongodb.net:27017,ac-wd9znsx-shard-00-01.on0pbcb.mongodb.net:27017,ac-wd9znsx-shard-00-02.on0pbcb.mongodb.net:27017/?ssl=true&replicaSet=atlas-bb0bfr-shard-0&authSource=admin&appName=cluster-imraaah-dev';

async function main() {
  await mongoose.connect(MONGO_URI);
  const schema = new mongoose.Schema({ post_code: String, name: String, zrexpress_uuid: String });
  const Commune = mongoose.model('Commune', schema);

  const codes = ['26071', '31043', '40031', '44019', '46006', '48019'];
  const communes = await Commune.find({ post_code: { $in: codes } }).exec();
  communes.forEach(c => console.log(`${c.name} (${c.post_code}) -> uuid: ${c.zrexpress_uuid || 'MISSING'}`));

  await mongoose.disconnect();
}
main().catch(err => { console.error(err); process.exit(1); });
