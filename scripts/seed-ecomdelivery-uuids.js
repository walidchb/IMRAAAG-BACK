const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const MONGO_URI = 'mongodb://***REMOVED***:***REMOVED***@ac-wd9znsx-shard-00-00.on0pbcb.mongodb.net:27017,ac-wd9znsx-shard-00-01.on0pbcb.mongodb.net:27017,ac-wd9znsx-shard-00-02.on0pbcb.mongodb.net:27017/?ssl=true&replicaSet=atlas-bb0bfr-shard-0&authSource=admin&appName=cluster-imraaah-dev';

function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[-]/g, ' ')
    .replace(/['']/g, '')
    .replace(/[']/g, '')
    .replace(/[.]/g, '')
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function similarity(a, b) {
  if (a === b) return 1;
  const len = Math.max(a.length, b.length);
  if (len === 0) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / len;
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

async function main() {
  await mongoose.connect(MONGO_URI);

  const ecomPath = path.resolve(__dirname, '../communesecom.json');
  const ecomCommunes = JSON.parse(fs.readFileSync(ecomPath, 'utf-8'));
  console.log(`Loaded ${ecomCommunes.length} Ecom Delivery communes`);

  const byPostalCode = new Map();
  const byNameAndWilaya = new Map();
  const ecomByWilaya = new Map();

  for (const ec of ecomCommunes) {
    const key = String(ec.code_postal);
    if (!byPostalCode.has(key)) byPostalCode.set(key, []);
    byPostalCode.get(key).push(ec);

    const nameKey = `${normalize(ec.commune)}|${ec.id_wilaya}`;
    if (!byNameAndWilaya.has(nameKey)) byNameAndWilaya.set(nameKey, []);
    byNameAndWilaya.get(nameKey).push(ec);

    if (!ecomByWilaya.has(String(ec.id_wilaya))) ecomByWilaya.set(String(ec.id_wilaya), []);
    ecomByWilaya.get(String(ec.id_wilaya)).push(ec);
  }

  const dbCommunes = await mongoose.connection.db.collection('communes').find({}).toArray();
  console.log(`Found ${dbCommunes.length} communes in DB`);

  let matchedByPostal = 0;
  let matchedByName = 0;
  let matchedByFuzzy = 0;
  let unmatched = [];

  for (const dbc of dbCommunes) {
    let ecomName = null;
    let matchType = null;

    // Strategy 1: postal code + wilaya
    const postalMatches = byPostalCode.get(dbc.post_code);
    if (postalMatches) {
      const filtered = postalMatches.filter(ec => String(ec.id_wilaya) === String(dbc.wilaya_code));
      if (filtered.length === 1) {
        ecomName = filtered[0].commune;
        matchType = 'postal';
        matchedByPostal++;
      }
    }

    // Strategy 2: exact normalized name + wilaya
    if (!ecomName) {
      const nameKey = `${normalize(dbc.name)}|${dbc.wilaya_code}`;
      const nameMatches = byNameAndWilaya.get(nameKey);
      if (nameMatches && nameMatches.length === 1) {
        ecomName = nameMatches[0].commune;
        matchType = 'exact_name';
        matchedByName++;
      }
    }

    // Strategy 3: fuzzy match within same wilaya (>= 80% similarity)
    if (!ecomName) {
      const dbNorm = normalize(dbc.name);
      const candidates = ecomByWilaya.get(String(dbc.wilaya_code)) || [];
      let bestScore = 0;
      let bestMatch = null;
      for (const ec of candidates) {
        const ecNorm = normalize(ec.commune);
        const score = similarity(dbNorm, ecNorm);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = ec;
        }
      }
      if (bestScore >= 0.7 && bestMatch) {
        ecomName = bestMatch.commune;
        matchType = `fuzzy(${(bestScore * 100).toFixed(0)}%)`;
        matchedByFuzzy++;
      }
    }

    if (ecomName) {
      await mongoose.connection.db.collection('communes').updateOne(
        { _id: dbc._id },
        { $set: { ecomdelivery_uuid: ecomName } }
      );
    } else {
      unmatched.push({ name: dbc.name, post_code: dbc.post_code, wilaya_code: dbc.wilaya_code });
    }
  }

  console.log(`\nMatched by postal code: ${matchedByPostal}`);
  console.log(`Matched by exact name: ${matchedByName}`);
  console.log(`Matched by fuzzy (>=80%): ${matchedByFuzzy}`);
  console.log(`Unmatched: ${unmatched.length}`);

  if (unmatched.length > 0) {
    console.log('\nStill unmatched:');
    unmatched.forEach(u => console.log(`  ${u.name} (${u.post_code}, wilaya ${u.wilaya_code})`));
  }

  const withUuid = await mongoose.connection.db.collection('communes').countDocuments({ ecomdelivery_uuid: { $exists: true, $ne: null } });
  console.log(`\nTotal communes with ecomdelivery_uuid: ${withUuid}`);

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
