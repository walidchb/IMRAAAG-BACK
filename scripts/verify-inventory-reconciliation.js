require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');
const { inventoryCollectionNames } = require('./lib/inventory-collections');
const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) { console.error('MONGODB_URI required'); process.exit(1); }
const COLLECTIONS = inventoryCollectionNames();
const violations = [];
function report(r,d){ violations.push({rule:r,detail:d}); console.log('  FAIL  ['+r+'] '+d); }
function ok(r,m){ console.log('  ok    ['+r+'] '+m); }
async function main(){
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const c = function(n){ return db.collection(n); };
  console.log('[INVENTORY RECONCILIATION] Connected. Read-only verification.\n');
  const balances = await c(COLLECTIONS.balances).find({}).toArray();
  if(balances.length===0){ console.log('  SKIP  no balances'); await mongoose.disconnect(); process.exit(0); }
  // HI-8 ledger-presence: a balance row with no movement is stock that changed with no
  // record (the pre-HI-8 failure mode). Counting movements once keeps this O(balances).
  const movementCounts = await c(COLLECTIONS.movements).aggregate([
    { $group: { _id: '$variantId', n: { $sum: 1 } } }
  ]).toArray();
  const mvCount = new Map(movementCounts.map(function(r){ return [String(r._id), r.n]; }));
  let m=0; let lp=0; const limit=Math.min(balances.length,500);
  for(let i=0;i<limit;i++){
    const bal = balances[i];
    if(!mvCount.has(String(bal.variantId))){ lp++; report('balance-has-ledger-row', String(bal.variantId)+' has onHand='+bal.onHand+' but no movement row'); }
    const res = await c(COLLECTIONS.movements).aggregate([
      { $match: { variantId: bal.variantId } },
      { $group: { _id: null, sum: { $sum: '$quantityDelta' } } }
    ]).toArray();
    const s = res[0] && res[0].sum ? res[0].sum : 0;
    if(s !== bal.onHand){ m++; report('balance-onhand-matches-movements', String(bal.variantId)+' onHand='+bal.onHand+' sum='+s); }
  }
  if(m===0) ok('balance-onhand-matches-movements','checked '+balances.length);
  if(lp===0) ok('balance-has-ledger-row','every balance has at least one movement row');
  console.log('');
  if(violations.length===0){ console.log('[INVENTORY RECONCILIATION] CLEAN'); await mongoose.disconnect(); process.exit(0); }
  console.log('[INVENTORY RECONCILIATION] '+violations.length+' VIOLATION(S)');
  for(let j=0;j<violations.length;j++){ const v=violations[j]; console.log('  - ['+v.rule+'] '+v.detail); }
  await mongoose.disconnect(); process.exit(1);
}
main().catch(function(e){ console.error('[INVENTORY RECONCILIATION] FAILED', e); process.exit(1); });
