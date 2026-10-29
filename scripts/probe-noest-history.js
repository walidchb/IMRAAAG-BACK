require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const { decryptRecord } = require('../dist/common/encryption.util');

async function checkNoest() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const config = await db.collection('deliveryconfigs').findOne({ storeId: new mongoose.Types.ObjectId('6abd12d59676e6a09f1e7ad2') });
  const creds = decryptRecord(config?.companies?.noest?.credentials || {}, process.env.DELIVERY_ENCRYPTION_KEY || '');

  const tracking = '5RD-35A-21785334';
  const endpoints = [
    `/api/public/get/tracking/info?tracking=${tracking}`,
    `/api/public/get/tracking/info/${tracking}`,
    `/api/public/get/trackings/info?trackings[]=${tracking}`,
    `/api/public/get/tracking/history?tracking=${tracking}`,
    `/api/public/get/tracking/history`,
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch(`https://app.noest-dz.com${ep}`, {
        headers: { 'Authorization': `Bearer ${creds.apiToken}`, 'Accept': 'application/json' }
      });
      console.log(`${ep} -> status: ${res.status}`);
      if (res.status === 200) {
        const text = await res.text();
        console.log(`Response: ${text.slice(0, 300)}`);
      }
    } catch (e) {
      console.log(`${ep} -> error: ${e.message}`);
    }
  }

  await mongoose.disconnect();
}

checkNoest().catch(console.error);
