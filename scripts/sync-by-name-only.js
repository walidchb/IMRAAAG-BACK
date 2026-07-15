const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const MONGO_URI = 'mongodb://***REMOVED***:***REMOVED***@ac-wd9znsx-shard-00-00.on0pbcb.mongodb.net:27017,ac-wd9znsx-shard-00-01.on0pbcb.mongodb.net:27017,ac-wd9znsx-shard-00-02.on0pbcb.mongodb.net:27017/?ssl=true&replicaSet=atlas-bb0bfr-shard-0&authSource=admin&appName=cluster-imraaah-dev';

async function main() {
  await mongoose.connect(MONGO_URI);

  const schema = new mongoose.Schema({ post_code: String, name: String, ar_name: String, wilaya_code: String, zrexpress_uuid: String });
  const Commune = mongoose.model('Commune', schema);

  // Load ZR data
  const zrData = JSON.parse(fs.readFileSync(path.resolve('zr-express-territories.json'), 'utf8'));
  const zrCommunes = zrData.filter(t => t.level === 'commune');
  const zrWilayas = zrData.filter(t => t.level === 'wilaya');

  // Build wilaya parentId -> code map
  const wilayaIdToCode = new Map();
  zrWilayas.forEach(w => wilayaIdToCode.set(w.id, String(w.code)));

  // Build ZR name indexes (French name -> communes, Arabic name -> communes)
  const zrByFrName = new Map();
  const zrByArName = new Map();
  zrCommunes.forEach(zc => {
    const frKey = zc.name.toLowerCase().trim();
    if (!zrByFrName.has(frKey)) zrByFrName.set(frKey, []);
    zrByFrName.get(frKey).push(zc);

    if (zc.nameArabic) {
      const arKey = zc.nameArabic.trim();
      if (!zrByArName.has(arKey)) zrByArName.set(arKey, []);
      zrByArName.get(arKey).push(zc);
    }
  });

  // Get all communes without zrexpress_uuid
  const withoutUuid = await Commune.find({
    $or: [{ zrexpress_uuid: { $exists: false } }, { zrexpress_uuid: null }]
  }).exec();

  console.log(`Found ${withoutUuid.length} communes without zrexpress_uuid`);

  let updated = 0;
  let matchedByFr = 0;
  let matchedByAr = 0;
  let notFound = [];

  for (const dbc of withoutUuid) {
    let match = null;

    // 1. Try French name exact match
    const frKey = dbc.name.toLowerCase().trim();
    const frCandidates = zrByFrName.get(frKey) || [];
    if (frCandidates.length === 1) {
      match = frCandidates[0];
      matchedByFr++;
    } else if (frCandidates.length > 1) {
      // Filter by wilaya code
      match = frCandidates.find(c => wilayaIdToCode.get(c.parentId) === dbc.wilaya_code) || null;
      if (match) matchedByFr++;
    }

    // 2. Try Arabic name exact match
    if (!match && dbc.ar_name) {
      const arKey = dbc.ar_name.trim();
      const arCandidates = zrByArName.get(arKey) || [];
      if (arCandidates.length === 1) {
        match = arCandidates[0];
        matchedByAr++;
      } else if (arCandidates.length > 1) {
        match = arCandidates.find(c => wilayaIdToCode.get(c.parentId) === dbc.wilaya_code) || null;
        if (match) matchedByAr++;
      }
    }

    // 3. Try French name fuzzy match (case insensitive, ignore dashes/spaces)
    if (!match) {
      const normalized = dbc.name.toLowerCase().replace(/[^a-z]/g, '');
      for (const [key, candidates] of zrByFrName) {
        if (key.replace(/[^a-z]/g, '') === normalized) {
          if (candidates.length === 1) {
            match = candidates[0];
            matchedByFr++;
          } else {
            match = candidates.find(c => wilayaIdToCode.get(c.parentId) === dbc.wilaya_code) || null;
            if (match) matchedByFr++;
          }
          break;
        }
      }
    }

    if (match) {
      await Commune.updateOne(
        { _id: dbc._id },
        { $set: { zrexpress_uuid: match.id } }
      ).exec();
      updated++;
      console.log(`  OK: ${dbc.name} (${dbc.post_code}) -> ${match.name}`);
    } else {
      notFound.push(dbc);
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Updated: ${updated}`);
  console.log(`  by French name: ${matchedByFr}`);
  console.log(`  by Arabic name: ${matchedByAr}`);
  console.log(`Not found: ${notFound.length}`);

  if (notFound.length > 0 && notFound.length <= 20) {
    notFound.forEach(c => console.log(`  MISS: ${c.name} (${c.post_code}) wilaya: ${c.wilaya_code}`));
  } else if (notFound.length > 0) {
    console.log('First 20 missing:');
    notFound.slice(0, 20).forEach(c => console.log(`  MISS: ${c.name} (${c.post_code}) wilaya: ${c.wilaya_code}`));
    console.log(`  ... and ${notFound.length - 20} more`);
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
