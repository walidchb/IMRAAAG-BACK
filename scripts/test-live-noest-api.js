require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const { decryptRecord } = require('../dist/common/encryption.util');

async function testNoestApi() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const config = await db.collection('deliveryconfigs').findOne({ storeId: new mongoose.Types.ObjectId('6abd12d59676e6a09f1e7ad2') });
  const rawCreds = config?.companies?.noest?.credentials || {};
  const encKey = process.env.DELIVERY_ENCRYPTION_KEY || '';
  const creds = decryptRecord(rawCreds, encKey);

  console.log('API Token present:', !!creds.apiToken, 'Length:', creds.apiToken?.length);
  console.log('GUID present:', !!creds.guid);

  const trackingNumbers = ['5RD-35A-21785334', '5RD-35A-21793465'];

  console.log('\n--- Testing Discovery Endpoint: POST /api/public/get/trackings/info ---');
  try {
    const res = await fetch('https://app.noest-dz.com/api/public/get/trackings/info', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.apiToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ trackings: trackingNumbers }),
    });

    console.log('Discovery HTTP Status:', res.status, res.statusText);
    const text = await res.text();
    console.log('Discovery Response (first 500 chars):', text.slice(0, 500));
    try {
      const json = JSON.parse(text);
      console.log('Parsed Keys:', Object.keys(json));
      for (const t of trackingNumbers) {
        if (json[t]) {
          console.log(`\nParcel ${t}:`);
          console.log('- Status:', json[t].status);
          console.log('- OrderInfo Status:', json[t].OrderInfo?.status);
          console.log('- Activity Count:', json[t].activity?.length);
          if (json[t].activity?.length > 0) {
            console.log('- Last Activity:', JSON.stringify(json[t].activity[json[t].activity.length - 1]));
          }
        } else {
          console.log(`\nParcel ${t} NOT FOUND in response.`);
        }
      }
    } catch (e) {
      console.log('Failed to parse JSON:', e.message);
    }
  } catch (err) {
    console.error('Discovery Request Error:', err);
  }

  for (const t of trackingNumbers) {
    console.log(`\n--- Testing History Endpoint: GET /api/public/get/tracking/history/${t} ---`);
    try {
      const res = await fetch(`https://app.noest-dz.com/api/public/get/tracking/history/${t}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${creds.apiToken}`,
          'Accept': 'application/json',
        },
      });

      console.log(`History HTTP Status for ${t}:`, res.status, res.statusText);
      const text = await res.text();
      console.log(`History Response for ${t} (first 400 chars):`, text.slice(0, 400));
    } catch (err) {
      console.error(`History Request Error for ${t}:`, err);
    }
  }

  await mongoose.disconnect();
}

testNoestApi().catch(console.error);
