require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const { decryptRecord } = require('../dist/common/encryption.util');

async function checkNoest() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const config = await db.collection('deliveryconfigs').findOne({ storeId: new mongoose.Types.ObjectId('6abd12d59676e6a09f1e7ad2') });
  const creds = decryptRecord(config?.companies?.noest?.credentials || {}, process.env.DELIVERY_ENCRYPTION_KEY || '');

  const tracking = '5RD-35A-21785334';
  const url = `https://app.noest-dz.com/api/public/get/tracking/history/${tracking}?user_guid=${creds.guid}`;

  console.log('Testing:', url);
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${creds.apiToken}`, 'Accept': 'application/json' }
  });

  console.log(`Status: ${res.status}`);
  const text = await res.text();
  console.log(`Response: ${text}`);

  await mongoose.disconnect();
}

checkNoest().catch(console.error);
