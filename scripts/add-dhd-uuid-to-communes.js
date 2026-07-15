const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/imraaah';

function normalize(str) {
  if (!str) return '';
  return str.replace(/\s+/g, ' ').trim().toLowerCase();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length);
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const db = mongoose.connection.db;
  const communesCol = db.collection('communes');

  // Load DHD communes
  const dhdCommunes = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../dhdcommunes.json'), 'utf8'
  ));
  console.log(`Loaded ${dhdCommunes.length} communes from dhdcommunes.json`);

  // Build index of existing communes by post_code
  const allCommunes = await communesCol.find({}).toArray();
  console.log(`Found ${allCommunes.length} communes in DB`);

  const byPostCode = new Map();
  const byNameAndWilaya = new Map();
  for (const c of allCommunes) {
    if (c.post_code) {
      if (!byPostCode.has(c.post_code)) byPostCode.set(c.post_code, []);
      byPostCode.get(c.post_code).push(c);
    }
    const key = `${normalize(c.name)}|${c.wilaya_code}`;
    if (!byNameAndWilaya.has(key)) byNameAndWilaya.set(key, []);
    byNameAndWilaya.get(key).push(c);
  }

  let matchedByPostCode = 0;
  let matchedByName = 0;
  let matchedByFuzzy = 0;
  let notFound = [];
  const bulkOps = [];

  for (const dhd of dhdCommunes) {
    const dhdWilayaCode = String(dhd.wilaya_id);
    const dhdPostCode = (dhd.code_postal || '').trim();

    // Pass 1: match by postal code
    let match = null;
    let method = '';
    const postCodeCandidates = byPostCode.get(dhdPostCode) || [];
    if (postCodeCandidates.length === 1) {
      match = postCodeCandidates[0];
      method = 'postal';
    } else if (postCodeCandidates.length > 1) {
      match = postCodeCandidates.find(c => c.wilaya_code === dhdWilayaCode) || postCodeCandidates[0];
      method = 'postal';
    }

    if (!match) {
      // Pass 2: match by exact name + wilaya code
      const nameKey = `${normalize(dhd.nom)}|${dhdWilayaCode}`;
      const nameCandidates = byNameAndWilaya.get(nameKey) || [];
      if (nameCandidates.length > 0) {
        match = nameCandidates[0];
        method = 'name';
      }
    }

    if (!match) {
      // Pass 3: fuzzy match by name + wilaya code (>=80%)
      const wilayaCommunes = allCommunes.filter(c => c.wilaya_code === dhdWilayaCode);
      let bestSim = 0;
      for (const c of wilayaCommunes) {
        const sim = similarity(dhd.nom, c.name || c.ar_name || '');
        if (sim > bestSim && sim >= 0.8) {
          bestSim = sim;
          match = c;
          method = 'fuzzy';
        }
      }
      if (match) {
        console.log(`  FUZZY: "${dhd.nom}" (${dhdPostCode}) ~ "${match.name}" (${match.post_code}) sim: ${(bestSim * 100).toFixed(0)}%`);
      }
    }

    if (match) {
      if (method === 'postal') matchedByPostCode++;
      else if (method === 'name') matchedByName++;
      else matchedByFuzzy++;
      bulkOps.push({
        updateOne: {
          filter: { _id: match._id },
          update: { $set: { dhd_uuid: dhd.nom } },
        },
      });
      if (bulkOps.length >= 500) {
        await communesCol.bulkWrite(bulkOps, { ordered: false });
        bulkOps.length = 0;
      }
    } else {
      notFound.push(dhd);
    }
  }

  if (bulkOps.length > 0) {
    await communesCol.bulkWrite(bulkOps, { ordered: false });
  }

  console.log('\n--- Summary ---');
  console.log(`Matched by postal code:    ${matchedByPostCode}`);
  console.log(`Matched by exact name:     ${matchedByName}`);
  console.log(`Matched by fuzzy (>=80%):  ${matchedByFuzzy}`);
  console.log(`Not matched:               ${notFound.length}`);
  console.log(`Total DHD communes:        ${dhdCommunes.length}`);

  if (notFound.length > 0) {
    console.log('\n--- Unmatched communes ---');
    notFound.forEach(c => console.log(`  "${c.nom}" (${(c.code_postal || '').trim()}, wilaya ${c.wilaya_id})`));
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
