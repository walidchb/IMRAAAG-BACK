// One-off cleanup for the fields dropped from TrackingConfig in Phase 2 of
// PLAN_PIXELS_MODULE.md. Browser pixels need only a Pixel ID, so the stored access
// tokens are removed from the live database.
//
// The single document is a placeholder with both pixels disabled, but the tokens are
// removed regardless so no secret remains at rest.
//
// Usage:  node scripts/migrate-drop-tracking-tokens.js [--dry-run]
//         (needs MONGODB_URI in .env)

require('dotenv').config({ path: '.env', quiet: true });
const mongoose = require('mongoose');

const COLLECTION = 'trackingconfigs';
const FIELDS = ['metaAccessToken', 'tikTokAccessToken'];

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set. Copy it into .env first.');
    process.exit(1);
  }

  const dryRun = process.argv.includes('--dry-run');
  await mongoose.connect(process.env.MONGODB_URI);
  const col = mongoose.connection.db.collection(COLLECTION);

  try {
    const total = await col.countDocuments();
    const withTokens = await col.countDocuments({
      $or: FIELDS.map((f) => ({ [f]: { $exists: true, $ne: null } })),
    });

    console.log(`${COLLECTION}: ${total} document(s), ${withTokens} carrying access tokens`);

    if (!withTokens) {
      console.log('Nothing to do.');
      return;
    }

    if (dryRun) {
      console.log('\n[dry-run] documents that would change:');
      const docs = await col
        .find({ $or: FIELDS.map((f) => ({ [f]: { $exists: true, $ne: null } })) })
        .project({ _id: 1, storeId: 1, vendorEmail: 1, metaPixelId: 1, tikTokPixelId: 1, metaPixelEnabled: 1, tikTokPixelEnabled: 1 })
        .toArray();
      for (const d of docs) {
        console.log(`  ${d._id}  store=${d.storeId || '(none)'}  meta=${d.metaPixelId || '-'}/${d.metaPixelEnabled}  tikTok=${d.tikTokPixelId || '-'}/${d.tikTokPixelEnabled}`);
      }
      console.log(`\nWould unset ${FIELDS.join(', ')} on ${withTokens} document(s).`);
      return;
    }

    const res = await col.updateMany(
      { $or: FIELDS.map((f) => ({ [f]: { $exists: true, $ne: null } })) },
      { $unset: { metaAccessToken: '', tikTokAccessToken: '' } },
    );
    console.log(`Unset access tokens on ${res.modifiedCount} document(s).`);

    const remaining = await col.countDocuments({
      $or: FIELDS.map((f) => ({ [f]: { $exists: true } })),
    });
    console.log(`Verification: ${remaining} document(s) still carry a token field.`);
    if (remaining > 0) {
      console.error('Unexpected: some token fields remain.');
      process.exitCode = 1;
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('ERROR', err.message);
  process.exit(1);
});
