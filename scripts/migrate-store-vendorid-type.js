// One-off data repair for `stores.vendorId` rows stored as a BSON **string**.
//
// Background
// ----------
// `Store.vendorId` is declared as an ObjectId. Mongoose casts on every write it
// performs, so `StoresService.create()` produces a real ObjectId. But a raw-driver
// write (`db.collection().updateOne()`) bypasses Mongoose casting and leaves the value
// as a string. Some rows were created that way.
//
// MongoDB compares by BSON type, so `findOne({ vendorId: ObjectId(id) })` does NOT match
// a row holding the same 24 hex characters as a string. This is not theoretical: it
// caused a real 404 (`STORE_NOT_FOUND`) on `GET /api/tracking/config`, locking a vendor
// out of their own Meta/TikTok pixel settings.
//
// `StoresService.vendorIdFilter()` now matches both shapes so this can never lock a
// vendor out again. This script fixes the underlying data so the collection is
// type-homogeneous and the unique `vendorId_1` index means what it says.
//
// It is idempotent, and dry-run by default semantics: nothing is written without
// --apply.
//
// Usage:  node scripts/migrate-store-vendorid-type.js [--dry-run]
//         (needs MONGODB_URI in .env)

require('dotenv').config({ path: '.env', quiet: true });
const mongoose = require('mongoose');

const COLLECTION = 'stores';
const HEX24 = /^[0-9a-fA-F]{24}$/;

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set. Copy it into .env first.');
    process.exit(1);
  }

  // Default is a dry run. Writing requires an explicit --apply, so this can never
  // modify the database by accident.
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--apply-invalid');

  await mongoose.connect(process.env.MONGODB_URI);
  const col = mongoose.connection.db.collection(COLLECTION);

  try {
    const all = await col.find({}).toArray();

    const typed = all.filter((s) => typeof s.vendorId === 'string');
    const correct = all.filter((s) => s.vendorId instanceof mongoose.Types.ObjectId);
    const missing = all.filter((s) => s.vendorId === undefined || s.vendorId === null);

    console.log(`${COLLECTION}: ${all.length} store(s)`);
    console.log(`  vendorId is ObjectId : ${correct.length}`);
    console.log(`  vendorId is string   : ${typed.length}   <- repaired by this script`);
    console.log(`  vendorId missing     : ${missing.length}`);

    // Only rows that are a well-formed 24 hex string can be converted without guessing.
    // A malformed value is reported and skipped rather than guessed at.
    const repairable = typed.filter((s) => HEX24.test(s.vendorId));
    const unparseable = typed.filter((s) => !HEX24.test(s.vendorId));

    if (unparseable.length) {
      console.log('\n[!] vendorId is a string but not a valid ObjectId. Skipping:');
      for (const s of unparseable) {
        console.log(`    _id=${s._id} storeName=${JSON.stringify(s.storeName)} vendorId=${JSON.stringify(s.vendorId)}`);
      }
      if (!force) {
        console.log('    Fix these by hand, then re-run. Not touching them.');
      }
    }

    if (!repairable.length) {
      console.log('\nNothing to do.');
      return;
    }

    // A string and an ObjectId with the same hex are different keys to the unique
    // index, so a converted row can collide with an existing ObjectId row. Detect that
    // before writing rather than after.
    const byHex = new Map();
    for (const s of correct) byHex.set(s.vendorId.toHexString(), s._id.toString());

    const conflicts = [];
    const plan = [];
    for (const s of repairable) {
      const hex = s.vendorId.toLowerCase();
      const existing = byHex.get(hex);
      if (existing && existing !== s._id.toString()) {
        conflicts.push({ store: s, existingId: existing });
        continue;
      }
      plan.push({ store: s, hex });
    }

    if (conflicts.length) {
      console.log('\n[!] These rows would collide with an existing ObjectId vendorId (two stores, one vendor):');
      for (const c of conflicts) {
        console.log(`    store _id=${c.store._id} vendorId=${c.store.vendorId} <-> existing store _id=${c.existingId}`);
      }
      console.log('    Left untouched. Two stores for one vendor is a data decision, not a cast.');
    }

    console.log(`\n${plan.length} row(s) would be converted to ObjectId:`);
    for (const p of plan) {
      console.log(`    _id=${p.store._id} storeName=${JSON.stringify(p.store.storeName)} ${p.store.vendorId} -> ObjectId(${p.hex})`);
    }

    if (!apply) {
      console.log('\n[dry-run] nothing written. Re-run with --apply to convert them.');
      return;
    }

    let written = 0;
    for (const p of plan) {
      const res = await col.updateOne(
        // Match on the exact string form so this cannot touch an already-converted row.
        { _id: p.store._id, vendorId: p.store.vendorId },
        { $set: { vendorId: new mongoose.Types.ObjectId(p.hex) } },
      );
      if (res.modifiedCount === 1) {
        written += 1;
      } else {
        console.log(`    ! _id=${p.store._id} not modified - skipped`);
      }
    }

    console.log(`\nConverted ${written} row(s).`);

    const after = await col.find({}).toArray();
    const stillString = after.filter((s) => typeof s.vendorId === 'string');
    console.log(`Verify: ${stillString.length} string vendorId remaining.`);
    if (stillString.length) {
      for (const s of stillString) {
        console.log(`    _id=${s._id} vendorId=${JSON.stringify(s.vendorId)}`);
      }
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
