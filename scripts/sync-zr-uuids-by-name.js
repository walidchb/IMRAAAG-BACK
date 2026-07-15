const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const MONGO_URI = process.env.MONGODB_URI;

const communeSchema = new mongoose.Schema({
  post_code: { type: String, required: true },
  name: { type: String, required: true },
  ar_name: String,
  wilaya_code: { type: String, required: true },
  zrexpress_uuid: String,
}, { timestamps: true });

const Commune = mongoose.model('Commune', communeSchema);

function normalize(str) {
  if (!str) return '';
  return str.replace(/\s+/g, ' ').trim().toLowerCase();
}

function buildNormalizedIndex(items, keyFn) {
  const map = new Map();
  items.forEach(item => {
    const key = normalize(keyFn(item));
    if (key) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    }
  });
  return map;
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  // Load test communes
  const testRaw = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../test.communes.json'), 'utf8'
  ));
  const testCommunes = testRaw.map(c => ({
    post_code: c.post_code,
    name: c.name,
    ar_name: c.ar_name,
    wilaya_code: c.wilaya_code,
  }));
  console.log(`Loaded ${testCommunes.length} communes from test.communes.json`);

  // Load ZR Express data
  const zrData = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../zr-express-territories.json'), 'utf8'
  ));
  const zrCommunes = zrData.filter(t => t.level === 'commune');
  const zrWilayas = zrData.filter(t => t.level === 'wilaya');
  console.log(`Loaded ${zrCommunes.length} communes from ZR Express data`);

  // Build ZR wilaya code map: parentId -> wilaya code
  const wilayaIdToCode = new Map();
  zrWilayas.forEach(w => wilayaIdToCode.set(w.id, String(w.code)));

  // Build name indexes for ZR communes
  const zrByNameFr = buildNormalizedIndex(zrCommunes, c => c.name);
  const zrByNameAr = buildNormalizedIndex(zrCommunes, c => c.nameArabic || '');

  let updated = 0;
  let notFound = [];
  let matchedByFr = 0;
  let matchedByAr = 0;

  for (const tc of testCommunes) {
    // Check if already has uuid
    const existing = await Commune.findOne({ post_code: tc.post_code }).exec();
    if (existing?.zrexpress_uuid) {
      continue;
    }

    // Try to find matching ZR commune
    let match = null;

    // 1. Try by Fr name + wilaya code
    const frCandidates = zrByNameFr.get(normalize(tc.name)) || [];
    match = frCandidates.find(c => wilayaIdToCode.get(c.parentId) === tc.wilaya_code);
    if (match) {
      matchedByFr++;
    }

    // 2. Try by Ar name + wilaya code
    if (!match) {
      const arCandidates = zrByNameAr.get(normalize(tc.ar_name)) || [];
      match = arCandidates.find(c => wilayaIdToCode.get(c.parentId) === tc.wilaya_code);
      if (match) {
        matchedByAr++;
      }
    }

    // 3. Try by Fr name only (no wilaya filter)
    if (!match) {
      match = frCandidates[0] || null;
      if (match) matchedByFr++;
    }

    if (match) {
      await Commune.updateOne(
        { post_code: tc.post_code },
        { $set: { zrexpress_uuid: match.id } }
      ).exec();
      updated++;
      console.log(`  UPDATED: ${tc.name} (${tc.post_code}) -> ${match.name} (${match.id})`);
    } else {
      notFound.push(tc);
      console.log(`  NOT FOUND: ${tc.name} (${tc.post_code}, wilaya: ${tc.wilaya_code}, ar: ${tc.ar_name})`);
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Updated: ${updated}`);
  console.log(`Not found: ${notFound.length}`);
  console.log(`Matched by French name: ${matchedByFr}`);
  console.log(`Matched by Arabic name: ${matchedByAr}`);

  if (notFound.length > 0) {
    console.log('\n--- Not Found List ---');
    notFound.forEach(c => console.log(`  ${c.name} (${c.post_code}) wilaya: ${c.wilaya_code} ar: ${c.ar_name}`));
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
