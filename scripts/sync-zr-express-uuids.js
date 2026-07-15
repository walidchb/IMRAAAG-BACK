const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;

const ZR_API_KEY = process.env.ZR_API_KEY;
const ZR_TENANT_ID = process.env.ZR_TENANT_ID;
const ZR_API_BASE = process.env.ZR_API_BASE || 'https://api.zrexpress.app/api/v1.0';

const wilayaSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  ar_name: String,
  longitude: String,
  latitude: String,
  zrexpress_uuid: String,
  yalidine_uuid: String,
}, { timestamps: true });

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

const Wilaya = mongoose.model('Wilaya', wilayaSchema);
const Commune = mongoose.model('Commune', communeSchema);

async function fetchZRTerritories() {
  const response = await fetch(`${ZR_API_BASE}/territories/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Tenant': ZR_TENANT_ID,
      'X-Api-Key': ZR_API_KEY,
    },
    body: JSON.stringify({ pageNumber: 1, pageSize: 1000, orderBy: ['code asc'] }),
  });
  if (!response.ok) {
    throw new Error(`ZR Express API error: ${response.status}`);
  }
  const data = await response.json();
  return data.items || [];
}

async function main() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('Connected.');

  console.log('Fetching ZR Express territories...');
  const items = await fetchZRTerritories();
  console.log(`Fetched ${items.length} territories from ZR Express`);

  const zrWilayas = items.filter(t => t.level === 'wilaya');
  const zrCommunes = items.filter(t => t.level === 'commune');
  console.log(`  - ${zrWilayas.length} wilayas`);
  console.log(`  - ${zrCommunes.length} communes`);

  // Update wilayas
  let wilayaUpdated = 0;
  let wilayaNotFound = [];
  for (const zr of zrWilayas) {
    const result = await Wilaya.findOneAndUpdate(
      { code: String(zr.code) },
      { $set: { zrexpress_uuid: zr.id } },
      { new: true },
    ).exec();
    if (result) {
      wilayaUpdated++;
    } else {
      wilayaNotFound.push(zr.code);
    }
  }

  console.log(`Wilayas updated: ${wilayaUpdated}`);
  if (wilayaNotFound.length > 0) {
    console.log(`Wilayas not found in DB: ${wilayaNotFound.join(', ')}`);
  }

  // Update communes
  let communeUpdated = 0;
  let communeMatchedByName = 0;
  let communeNotFound = [];
  for (const zr of zrCommunes) {
    const result = await Commune.findOneAndUpdate(
      { post_code: zr.postalCode },
      { $set: { zrexpress_uuid: zr.id } },
      { new: true },
    ).exec();
    if (result) {
      communeUpdated++;
    } else {
      // Try matching by name + parent wilaya code
      const parent = zrWilayas.find(w => w.id === zr.parentId);
      if (parent) {
        const byName = await Commune.findOneAndUpdate(
          { wilaya_code: String(parent.code), name: zr.name },
          { $set: { zrexpress_uuid: zr.id } },
          { new: true },
        ).exec();
        if (byName) {
          communeMatchedByName++;
        } else {
          communeNotFound.push(`${zr.name} (postalCode: ${zr.postalCode}, parent: ${parent.code})`);
        }
      } else {
        communeNotFound.push(`${zr.name} (postalCode: ${zr.postalCode}, no parent found)`);
      }
    }
  }

  console.log(`Communes updated by post_code: ${communeUpdated}`);
  console.log(`Communes updated by name+wilaya: ${communeMatchedByName}`);
  if (communeNotFound.length > 0) {
    console.log(`Communes not found (${communeNotFound.length}):`);
    communeNotFound.slice(0, 20).forEach(c => console.log(`  - ${c}`));
    if (communeNotFound.length > 20) {
      console.log(`  ... and ${communeNotFound.length - 20} more`);
    }
  }

  console.log('Done.');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
