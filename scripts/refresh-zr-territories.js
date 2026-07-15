const fs = require('fs');
const path = require('path');

const ZR_API_KEY = '***REMOVED***';
const ZR_TENANT_ID = '***REMOVED***';
const ZR_API_BASE = 'https://api.zrexpress.app/api/v1.0';

async function fetchAllTerritories() {
  const allItems = [];
  let pageNumber = 1;
  let hasNext = true;

  while (hasNext) {
    console.log(`Fetching page ${pageNumber}...`);
    const response = await fetch(`${ZR_API_BASE}/territories/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Tenant': ZR_TENANT_ID,
        'X-Api-Key': ZR_API_KEY,
      },
      body: JSON.stringify({ pageNumber, pageSize: 1000, orderBy: ['code asc'] }),
    });

    if (!response.ok) {
      throw new Error(`ZR Express API error: ${response.status}`);
    }

    const data = await response.json();
    const items = data.items || [];
    allItems.push(...items);
    console.log(`  Got ${items.length} items, total so far: ${allItems.length}`);

    hasNext = data.hasNext === true;
    pageNumber++;
  }

  return allItems;
}

async function main() {
  console.log('Fetching all territories from ZR Express...');
  const items = await fetchAllTerritories();
  console.log(`Total territories fetched: ${items.length}`);

  const wilayas = items.filter(t => t.level === 'wilaya');
  const communes = items.filter(t => t.level === 'commune');
  console.log(`Wilayas: ${wilayas.length}`);
  console.log(`Communes: ${communes.length}`);

  const outputPath = path.resolve(__dirname, '../zr-express-territories.json');
  fs.writeFileSync(outputPath, JSON.stringify(items, null, 2), 'utf8');
  console.log(`Saved to ${outputPath}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
