const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const MONGO_URI = process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI);
  const schema = new mongoose.Schema({ post_code: String, name: String, zrexpress_uuid: String });
  const Commune = mongoose.model('Commune', schema);

  const zrData = JSON.parse(fs.readFileSync(path.resolve('zr-express-territories.json'), 'utf8'));
  const zrCommunes = zrData.filter(t => t.level === 'commune');

  // Map by Arabic name since those are identical
  const zrByArName = new Map();
  zrCommunes.forEach(zc => {
    if (zc.nameArabic) zrByArName.set(zc.nameArabic, zc);
  });

  const fixes = [
    { post_code: '26071', ar_name: 'سيدي نعمان' },
    { post_code: '31043', ar_name: 'العنصر' },
    { post_code: '40031', ar_name: 'الحامة' },
    { post_code: '44019', ar_name: 'عين السلطان' },
    { post_code: '46006', ar_name: 'العامرية' },
    { post_code: '48019', ar_name: 'أولاد يعيش' },
  ];

  for (const fix of fixes) {
    const zr = zrByArName.get(fix.ar_name);
    if (!zr) {
      console.log(`ZR not found for ar_name: ${fix.ar_name}`);
      continue;
    }
    const result = await Commune.updateOne(
      { post_code: fix.post_code },
      { $set: { zrexpress_uuid: zr.id } }
    ).exec();
    if (result.modifiedCount > 0) {
      console.log(`Updated ${fix.post_code} with uuid ${zr.id} (${zr.name})`);
    } else {
      console.log(`No change for ${fix.post_code}`);
    }
  }

  // Verify
  const codes = fixes.map(f => f.post_code);
  const updated = await Commune.find({ post_code: { $in: codes } }).exec();
  updated.forEach(c => console.log(`  ${c.name} (${c.post_code}) -> ${c.zrexpress_uuid || 'MISSING'}`));

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
