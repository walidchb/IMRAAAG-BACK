const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://***REMOVED***:***REMOVED***@ac-wd9znsx-shard-00-00.on0pbcb.mongodb.net:27017,ac-wd9znsx-shard-00-01.on0pbcb.mongodb.net:27017,ac-wd9znsx-shard-00-02.on0pbcb.mongodb.net:27017/?ssl=true&replicaSet=atlas-bb0bfr-shard-0&authSource=admin&appName=cluster-imraaah-dev';

const communeSchema = new mongoose.Schema({ post_code: String, name: String, zrexpress_uuid: String });
const Commune = mongoose.model('Commune', communeSchema);

async function main() {
  await mongoose.connect(MONGO_URI);

  const total = await Commune.countDocuments();
  const withUuid = await Commune.countDocuments({ zrexpress_uuid: { $exists: true, $ne: null } });
  const withoutUuid = await Commune.countDocuments({ $or: [{ zrexpress_uuid: { $exists: false } }, { zrexpress_uuid: null }] });
  console.log('Total communes in DB:', total);
  console.log('With zrexpress_uuid:', withUuid);
  console.log('Without zrexpress_uuid:', withoutUuid);

  // Check the test file communes
  const testData = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../test.communes.json'), 'utf8'));
  const testCodes = new Set(testData.map(t => t.post_code));

  const testInDb = await Commune.find({ post_code: { $in: [...testCodes] } }).exec();
  const testWithUuid = testInDb.filter(c => c.zrexpress_uuid);
  const testWithoutUuid = testInDb.filter(c => !c.zrexpress_uuid);
  console.log('\nTest file communes in DB:', testInDb.length);
  console.log('Test communes WITH uuid:', testWithUuid.length);
  console.log('Test communes WITHOUT uuid:', testWithoutUuid.length);

  // Look at a few without uuid to see if they exist in ZR data
  const zrData = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../zr-express-territories.json'), 'utf8'));
  const zrCommunes = zrData.filter(t => t.level === 'commune');
  const zrWilayas = zrData.filter(t => t.level === 'wilaya');
  const wilayaIdToCode = new Map();
  zrWilayas.forEach(w => wilayaIdToCode.set(w.id, String(w.code)));

  console.log('\n--- Sample of unmatched communes vs ZR data ---');
  let checked = 0;
  for (const dbc of testWithoutUuid) {
    if (checked >= 10) break;
    const zrMatch = zrCommunes.find(zc => 
      zc.name.toLowerCase() === dbc.name.toLowerCase() ||
      (zc.nameArabic && zc.nameArabic === (dbc.ar_name || ''))
    );
    if (zrMatch) {
      console.log(`IN ZR BUT NOT MATCHED: ${dbc.name} (${dbc.post_code}) -> ZR: ${zrMatch.name} (${zrMatch.postalCode}) wilaya: ${wilayaIdToCode.get(zrMatch.parentId)}`);
    } else {
      console.log(`NOT IN ZR: ${dbc.name} (${dbc.post_code})`);
    }
    checked++;
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
