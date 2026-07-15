const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/imraaah';

const UNMATCHED = [
  { nom: "Ouled Zouai", wilaya_id: 4, code_postal: "04036" },
  { nom: "Larbaa", wilaya_id: 5, code_postal: "05042" },
  { nom: "Lemsane", wilaya_id: 5, code_postal: "05088" },
  { nom: "Talkhamt", wilaya_id: 5, code_postal: "05051" },
  { nom: "Ouled Rached", wilaya_id: 10, code_postal: "10081" },
  { nom: "Z'barbar", wilaya_id: 10, code_postal: "10072" },
  { nom: "Abalessa", wilaya_id: 11, code_postal: "11012" },
  { nom: "Beni Khaled", wilaya_id: 13, code_postal: "13077" },
  { nom: "Sebt", wilaya_id: 14, code_postal: "14062" },
  { nom: "Sidi Abderrahmane", wilaya_id: 14, code_postal: "14028" },
  { nom: "Ait Oumalou", wilaya_id: 15, code_postal: "15056" },
  { nom: "El Merssa", wilaya_id: 16, code_postal: "16115" },
  { nom: "Khenag Mayoum", wilaya_id: 21, code_postal: "21063" },
  { nom: "Sidi Khaled", wilaya_id: 22, code_postal: "22031" },
  { nom: "Eulma", wilaya_id: 23, code_postal: "23036" },
  { nom: "Treat", wilaya_id: 23, code_postal: "23022" },
  { nom: "Beni Mezline", wilaya_id: 24, code_postal: "24041" },
  { nom: "Bou Hamdane", wilaya_id: 24, code_postal: "24050" },
  { nom: "Khezara", wilaya_id: 24, code_postal: "24240" },
  { nom: "Ben Badis", wilaya_id: 25, code_postal: "25030" },
  { nom: "Bouaiche", wilaya_id: 26, code_postal: "26054" },
  { nom: "El Ouinet", wilaya_id: 26, code_postal: "26595" },
  { nom: "Sidi Ziane", wilaya_id: 26, code_postal: "26073" },
  { nom: "Safsaf", wilaya_id: 27, code_postal: "27044" },
  { nom: "El Houamed", wilaya_id: 28, code_postal: "28063" },
  { nom: "M'tarfa", wilaya_id: 28, code_postal: "28058" },
  { nom: "Menaa", wilaya_id: 28, code_postal: "28070" },
  { nom: "Sidi Ameur", wilaya_id: 28, code_postal: "28035" },
  { nom: "Ain Fares", wilaya_id: 29, code_postal: "29020" },
  { nom: "Tizi", wilaya_id: 29, code_postal: "29018" },
  { nom: "Ain Beida", wilaya_id: 30, code_postal: "30019" },
  { nom: "Sidi Ameur", wilaya_id: 32, code_postal: "32029" },
  { nom: "Sidi Slimane", wilaya_id: 32, code_postal: "32130" },
  { nom: "El Hamadia", wilaya_id: 34, code_postal: "34017" },
  { nom: "Tesmart", wilaya_id: 34, code_postal: "34060" },
  { nom: "El Kharrouba", wilaya_id: 35, code_postal: "35048" },
  { nom: "Ouled Aissa", wilaya_id: 35, code_postal: "35050" },
  { nom: "Souk El Haad", wilaya_id: 35, code_postal: "35020" },
  { nom: "Larbaa", wilaya_id: 38, code_postal: "38022" },
  { nom: "Sidi Slimane", wilaya_id: 38, code_postal: "38028" },
  { nom: "El Oueldja", wilaya_id: 40, code_postal: "40032" },
  { nom: "Ain Soltane", wilaya_id: 41, code_postal: "41026" },
  { nom: "Sidi Fredj", wilaya_id: 41, code_postal: "41030" },
  { nom: "Sidi Amar", wilaya_id: 42, code_postal: "42020" },
  { nom: "Sidi Lakhdar", wilaya_id: 44, code_postal: "44027" },
  { nom: "Chentouf", wilaya_id: 46, code_postal: "46020" },
  { nom: "Emir Abdelkader", wilaya_id: 46, code_postal: "46037" },
  { nom: "Hassasna", wilaya_id: 46, code_postal: "46021" },
  { nom: "El Ouldja", wilaya_id: 48, code_postal: "48048" },
  { nom: "Souk El Had", wilaya_id: 48, code_postal: "48068" },
];

function normalize(str) {
  if (!str) return '';
  return str.replace(/\s+/g, ' ').trim().toLowerCase();
}

function stripSpecialChars(str) {
  return normalize(str).replace(/[''-]/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
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

function flexibleSimilarity(dhdName, dbName) {
  const raw = similarity(dhdName, dbName);
  const stripped = similarity(stripSpecialChars(dhdName), stripSpecialChars(dbName));
  return Math.max(raw, stripped);
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB\n');

  const db = mongoose.connection.db;
  const communesCol = db.collection('communes');

  const allCommunes = await communesCol.find({}).toArray();
  const byWilaya = new Map();
  for (const c of allCommunes) {
    if (!byWilaya.has(c.wilaya_code)) byWilaya.set(c.wilaya_code, []);
    byWilaya.get(c.wilaya_code).push(c);
  }

  const bulkOps = [];
  let matched = 0;
  let stillUnmatched = [];

  for (const dhd of UNMATCHED) {
    const wCode = String(dhd.wilaya_id);
    const candidates = byWilaya.get(wCode) || [];
    let bestSim = 0;
    let bestMatch = null;

    for (const c of candidates) {
      const sim = flexibleSimilarity(dhd.nom, c.name);
      if (sim > bestSim && sim >= 0.7) {
        bestSim = sim;
        bestMatch = c;
      }
    }

    if (bestMatch) {
      matched++;
      console.log(`MATCHED: "${dhd.nom}" (${dhd.code_postal}, w${wCode}) ~ "${bestMatch.name}" (${bestMatch.post_code}) sim: ${(bestSim * 100).toFixed(0)}%`);
      bulkOps.push({
        updateOne: {
          filter: { _id: bestMatch._id },
          update: { $set: { dhd_uuid: dhd.nom } },
        },
      });
    } else {
      stillUnmatched.push(dhd);
    }
  }

  if (bulkOps.length > 0) {
    await communesCol.bulkWrite(bulkOps, { ordered: false });
  }

  console.log(`\nFlexible matching results:`);
  console.log(`  Matched (70-80% threshold): ${matched}`);
  console.log(`  Still unmatched:            ${stillUnmatched.length}`);

  if (stillUnmatched.length > 0) {
    console.log('\n--- Still unmatched — please review manually ---');
    for (const dhd of stillUnmatched) {
      const wCode = String(dhd.wilaya_id);
      const candidates = byWilaya.get(wCode) || [];
      console.log(`\n  "${dhd.nom}" (${dhd.code_postal}, wilaya ${dhd.wilaya_id})`);
      console.log(`    DB communes in same wilaya:`);
      candidates.slice(0, 10).forEach(c =>
        console.log(`      - "${c.name}" (${c.post_code})${c.ar_name ? ` / ar: ${c.ar_name}` : ''}`)
      );
      if (candidates.length > 10) console.log(`      ... and ${candidates.length - 10} more`);
    }
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
