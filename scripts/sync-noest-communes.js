const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const MONGO_URI = 'mongodb://***REMOVED***:***REMOVED***@ac-wd9znsx-shard-00-00.on0pbcb.mongodb.net:27017,ac-wd9znsx-shard-00-01.on0pbcb.mongodb.net:27017,ac-wd9znsx-shard-00-02.on0pbcb.mongodb.net:27017/?ssl=true&replicaSet=atlas-bb0bfr-shard-0&authSource=admin&appName=cluster-imraaah-dev';

const NOEST_BASE = 'https://app.noest-dz.com';
const API_TOKEN = '***REMOVED***';

function normalizeName(name) {
  return name.toLowerCase().trim()
    .replace(/-/g, ' ')
    .replace(/[''`]/g, '')
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ');
}

function normalizeKey(name, wilaya) {
  return `${normalizeName(name)}|${wilaya}`;
}

function collapseName(name) {
  return normalizeName(name).replace(/\s+/g, '');
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint8Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function wordsOverlap(nameA, nameB) {
  const wa = normalizeName(nameA).split(/\s+/).filter(Boolean);
  const wb = normalizeName(nameB).split(/\s+/).filter(Boolean);
  if (wa.length === 0 || wb.length === 0) return 0;
  const setB = new Set(wb);
  const shared = wa.filter(w => setB.has(w)).length;
  return shared / Math.max(wa.length, wb.length);
}

async function fetchNoestCommunes() {
  const response = await fetch(`${NOEST_BASE}/api/public/get/communes`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Accept': 'application/json',
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Noest API error ${response.status}: ${text}`);
  }
  return response.json();
}

async function main() {
  console.log('Fetching communes from Noest Express...');
  const raw = await fetchNoestCommunes();
  const noest = Array.isArray(raw) ? raw : Object.values(raw);
  console.log(`Fetched ${noest.length} communes from Noest Express`);

  // Indexes
  const byNameNormalized = new Map();
  const byPostalCode = new Map();
  const byWilaya = {}; // wilaya_id -> [{nom, collapsed, original}]

  for (const c of noest) {
    const nn = normalizeKey(c.nom, c.wilaya_id);
    if (!byNameNormalized.has(nn)) byNameNormalized.set(nn, []);
    byNameNormalized.get(nn).push(c);

    const pc = c.code_postal || '';
    if (pc) {
      if (!byPostalCode.has(pc)) byPostalCode.set(pc, []);
      byPostalCode.get(pc).push(c);
    }

    const wid = c.wilaya_id;
    if (!byWilaya[wid]) byWilaya[wid] = [];
    byWilaya[wid].push({ nom: c.nom, collapsed: collapseName(c.nom), original: c });
  }

  await mongoose.connect(MONGO_URI);
  const schema = new mongoose.Schema({ name: String, post_code: String, wilaya_code: String, noestexpress_uuid: String });
  const Commune = mongoose.model('Commune', schema);

  const allCommunes = await Commune.find({}).exec();
  console.log(`Total communes in DB: ${allCommunes.length}`);

  let byName = 0, byFuzzy = 0, byPc = 0;
  let notFound = [];
  const bulkOps = [];

  for (const dbc of allCommunes) {
    let match = null;

    // 1. Exact normalized name + wilaya
    const nameKey = normalizeKey(dbc.name, dbc.wilaya_code);
    const nameCandidates = byNameNormalized.get(nameKey);
    if (nameCandidates?.length) {
      match = nameCandidates[0];
      byName++;
    }

    // 2. Fuzzy: Levenshtein on collapsed name + word overlap
    if (!match) {
      const dbCollapsed = collapseName(dbc.name);
      const wilCandidates = byWilaya[Number(dbc.wilaya_code)] || [];
      let best = { dist: Infinity, overlap: 0, match: null };

      for (const wc of wilCandidates) {
        const ld = levenshtein(dbCollapsed, wc.collapsed);
        const threshold = Math.max(3, Math.floor(Math.min(dbCollapsed.length, wc.collapsed.length) / 3));
        const ov = wordsOverlap(dbc.name, wc.nom);

        if (ld <= threshold && (ld < best.dist || (ld === best.dist && ov > best.overlap))) {
          best = { dist: ld, overlap: ov, match: wc.original };
        }

        // Accept if strong word overlap (>= 50%)
        if (ov >= 0.5 && ld <= threshold + 3) {
          best = { dist: ld, overlap: ov, match: wc.original };
        }

        // Accept if one name is fully contained in the other
        if ((dbCollapsed.includes(wc.collapsed) || wc.collapsed.includes(dbCollapsed)) && ld <= threshold + 5) {
          best = { dist: ld, overlap: ov, match: wc.original };
        }
      }

      if (best.match) {
        match = best.match;
        byFuzzy++;
      }
    }

    // 3. Postal code fallback (with name similarity guard)
    if (!match) {
      const pcCandidates = byPostalCode.get(dbc.post_code) || [];
      let candidate = null;
      if (pcCandidates.length === 1) {
        candidate = pcCandidates[0];
      } else if (pcCandidates.length > 1) {
        candidate = pcCandidates.find(c => String(c.wilaya_id) === dbc.wilaya_code);
      }
      if (candidate && candidate.nom.toLowerCase().slice(0, 2) === dbc.name.toLowerCase().trim().slice(0, 2)) {
        match = candidate;
        byPc++;
      }
    }

    if (match) {
      bulkOps.push({
        updateOne: {
          filter: { _id: dbc._id },
          update: { $set: { noestexpress_uuid: match.nom } },
        },
      });
    } else {
      notFound.push(dbc);
    }
  }

  if (bulkOps.length > 0) {
    await Commune.bulkWrite(bulkOps);
  }

  console.log(`\nMatched by exact name: ${byName}`);
  console.log(`Matched by fuzzy (Levenshtein/overlap): ${byFuzzy}`);
  console.log(`Matched by postal code: ${byPc}`);
  console.log(`Total updated: ${bulkOps.length}`);
  console.log(`Not found: ${notFound.length}`);

  if (notFound.length > 0) {
    console.log('\nUnmatched:');
    notFound.forEach(c => console.log(`  ${c.name} (${c.post_code}) w${c.wilaya_code}`));
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
