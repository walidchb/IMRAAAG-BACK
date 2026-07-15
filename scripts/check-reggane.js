const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const MONGO_URI = process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI);
  const schema = new mongoose.Schema({ post_code: String, name: String, ar_name: String, zrexpress_uuid: String });
  const Commune = mongoose.model('Commune', schema);

  // Check Reggane and Aoulef in DB
  const communes = await Commune.find({ post_code: { $in: ['01003', '01004'] } }).exec();
  communes.forEach(c => console.log(`DB: ${c.name} (${c.post_code}) uuid: ${c.zrexpress_uuid || 'MISSING'}`));

  // Check in ZR data
  const zrData = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../zr-express-territories.json'), 'utf8'));
  const zrCommunes = zrData.filter(t => t.level === 'commune');

  for (const name of ['Reggane', 'Aoulef']) {
    const found = zrCommunes.find(c => c.name === name);
    if (found) {
      console.log(`ZR: ${found.name} - canSend: ${found.delivery?.canSend}, hasHomeDelivery: ${found.delivery?.hasHomeDelivery}`);
    } else {
      console.log(`ZR: ${name} NOT FOUND in ZR data`);
    }
  }

  // Check all ZR communes with canSend status
  const total = zrCommunes.length;
  const canSendTrue = zrCommunes.filter(c => c.delivery?.canSend === true).length;
  const canSendFalse = zrCommunes.filter(c => c.delivery?.canSend === false).length;
  const canSendUndefined = zrCommunes.filter(c => c.delivery?.canSend === undefined || c.delivery?.canSend === null).length;
  console.log(`\nZR communes total: ${total}`);
  console.log(`canSend=true: ${canSendTrue}`);
  console.log(`canSend=false: ${canSendFalse}`);
  console.log(`canSend=undefined: ${canSendUndefined}`);

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
