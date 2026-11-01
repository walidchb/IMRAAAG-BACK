#!/usr/bin/env node
/**
 * probe-dhd-communes.js
 *
 * Read-only diagnostic script to probe DHD commune endpoints:
 * 1. Resolves store DHD credentials from MongoDB.
 * 2. Fetches communes for sample wilayas (e.g. 5, 16, 31).
 * 3. Inspects response shape, active flags, stop-desk flags, postal codes, and counts.
 * 4. Never exposes or prints tokens.
 */
const mongoose = require('mongoose');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/imraaah';
const ENCRYPTION_KEY = process.env.DELIVERY_ENCRYPTION_KEY || '';
const DHD_API_BASE = (process.env.DHD_STATUS_API_BASE || process.env.DHD_API_BASE || 'https://platform.dhd-dz.com').replace(/\/+$/, '');

const { decryptRecord } = require('../dist/common/encryption.util');

async function getDhdCredentials() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const config = await db.collection('deliveryconfigs').findOne({
    'companies.dhd.credentials': { $exists: true },
    'companies.dhd.status': { $ne: 'disabled' },
  });

  if (!config) {
    throw new Error('No deliveryconfig found with enabled DHD credentials');
  }

  const rawCreds = config.companies?.dhd?.credentials || {};
  const creds = decryptRecord(rawCreds, ENCRYPTION_KEY);
  const apiToken = (creds.apiToken || '').trim();

  if (!apiToken) {
    throw new Error('Could not decrypt DHD apiToken from store config');
  }

  const fingerprint = crypto.createHash('sha256').update(apiToken).digest('hex').slice(0, 12);
  return { apiToken, fingerprint, storeId: config.storeId, vendorEmail: config.vendorEmail };
}

async function probeWilaya(apiToken, wilayaId) {
  const url = `${DHD_API_BASE}/api/v1/get/communes?wilaya_id=${encodeURIComponent(wilayaId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: 'application/json',
    },
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { status: res.status, error: 'Non-JSON response', sample: text.slice(0, 100) };
  }

  const root = body && typeof body === 'object' && !Array.isArray(body) && 'data' in body ? body.data : body;
  const isArray = Array.isArray(root);
  const entries = isArray ? root : root && typeof root === 'object' ? Object.values(root) : [];

  let activeCount = 0;
  let inactiveCount = 0;
  let stopDeskCount = 0;
  let postalCodeSample = [];

  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    if (item.is_active === 0 || item.is_active === false || item.is_active === '0') {
      inactiveCount++;
    } else {
      activeCount++;
    }
    if (item.has_stop_desk === 1 || item.has_stop_desk === true || item.has_stop_desk === '1') {
      stopDeskCount++;
    }
    if (item.code_postal && postalCodeSample.length < 3) {
      postalCodeSample.push(item.code_postal);
    }
  }

  const firstEntry = entries[0] ? {
    nom: entries[0].nom,
    wilaya_id: entries[0].wilaya_id,
    code_postal: entries[0].code_postal,
    has_stop_desk: entries[0].has_stop_desk,
    is_active: entries[0].is_active,
  } : null;

  return {
    status: res.status,
    envelope: isArray ? 'array' : 'object',
    totalEntries: entries.length,
    activeCount,
    inactiveCount,
    stopDeskCount,
    postalCodeSample,
    firstEntry,
  };
}

async function main() {
  console.log('Connecting to database and resolving DHD credentials...');
  let creds;
  try {
    creds = await getDhdCredentials();
    console.log(`Resolved DHD config for store ${creds.storeId || creds.vendorEmail} (token: sha256:${creds.fingerprint}...)`);
  } catch (err) {
    console.error('Failed to resolve credentials:', err.message);
    process.exit(1);
  }

  const sampleWilayas = ['5', '16', '31'];
  for (const w of sampleWilayas) {
    console.log(`\nProbing wilaya ${w}...`);
    try {
      const result = await probeWilaya(creds.apiToken, w);
      console.log(`Result for wilaya ${w}:`, JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`Error probing wilaya ${w}:`, err.message);
    }
  }

  await mongoose.disconnect();
  console.log('\nProbe complete.');
}

main().catch((err) => {
  console.error('Fatal probe error:', err);
  process.exit(1);
});
