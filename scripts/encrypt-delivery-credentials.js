require('dotenv').config({ path: require('path').resolve(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * Production-readiness H8 — re-encrypt carrier credentials stored in plaintext.
 *
 * `encryptRecord()` is a no-op when `DELIVERY_ENCRYPTION_KEY` is empty, so any credentials
 * saved while the key was unset are sitting in `deliveryconfigs.companies.*.credentials` as
 * plaintext. Once the key is configured, this script encrypts those values in place using the
 * same AES-256-GCM format the application reads (`ivHex:tagHex:cipherHex`).
 *
 * Safe semantics:
 *   - an already-encrypted value (three colon-separated hex parts) is left alone;
 *   - a dry run never writes;
 *   - only `deliveryconfigs` is touched, and only the credential leaves.
 *
 * IMPORTANT: a value can only be re-encrypted with the key the application will use. Set
 * `DELIVERY_ENCRYPTION_KEY` first, and treat any value that already looks encrypted under a
 * *different* key as unreadable (the app cannot decrypt it either).
 *
 * Run: node scripts/encrypt-delivery-credentials.js [--apply]
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

const MONGO_URI = process.env.MONGODB_URI;
const KEY = process.env.DELIVERY_ENCRYPTION_KEY;
const APPLY = process.argv.includes('--apply');

if (!MONGO_URI) {
  console.error('MONGODB_URI required');
  process.exit(1);
}
if (!KEY) {
  console.error('DELIVERY_ENCRYPTION_KEY required (64 hex characters)');
  process.exit(1);
}
if (!/^[0-9a-fA-F]{64}$/.test(KEY)) {
  console.error('DELIVERY_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  process.exit(1);
}

function encryptValue(value) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(KEY, 'hex'), iv);
  let encrypted = cipher.update(String(value), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

function looksEncrypted(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 3 && parts.every((p) => /^[0-9a-fA-F]+$/.test(p));
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const collection = mongoose.connection.db.collection('deliveryconfigs');

  const configs = await collection.find({}).toArray();
  let configsTouched = 0;
  let leavesEncrypted = 0;

  for (const config of configs) {
    const companies = config.companies || {};
    let changed = false;

    for (const [companyId, company] of Object.entries(companies)) {
      const credentials = company && company.credentials;
      if (!credentials || typeof credentials !== 'object') continue;

      const next = {};
      for (const [field, value] of Object.entries(credentials)) {
        if (value == null || value === '') {
          next[field] = value;
          continue;
        }
        if (looksEncrypted(value)) {
          next[field] = value;
          continue;
        }
        next[field] = encryptValue(value);
        leavesEncrypted += 1;
        changed = true;
      }

      if (changed) {
        console.log(
          `[H8] ${String(config._id)} (${config.vendorEmail || 'no email'}) → ${companyId}: encrypted ${Object.keys(next).length} credential field(s)`,
        );
      }
      companies[companyId] = { ...company, credentials: next };
    }

    if (changed) {
      configsTouched += 1;
      if (APPLY) {
        await collection.updateOne(
          { _id: config._id },
          { $set: { companies: companies, updatedAt: new Date() } },
        );
      }
    }
  }

  console.log(
    `[H8] ${APPLY ? 'APPLIED' : 'DRY RUN'}: ${leavesEncrypted} credential value(s) across ${configsTouched} config(s).`,
  );
  if (!APPLY && leavesEncrypted > 0) {
    console.log('[H8] Re-run with --apply to write the encrypted values.');
  }
}

main()
  .catch((err) => {
    console.error('[H8] FAILED:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
