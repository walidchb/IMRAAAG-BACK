/**
 * Seed script: Insert 8 delivery companies into the deliverycompanies collection.
 * Run: node scripts/seed-delivery-companies.js
 */
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;

const companies = [
  {
    slug: 'zr-express',
    name: 'ZR Express',
    displayName: 'ZR Express',
    logoPath: '/assets/logos/zr-express.jpg',
    credentialFields: [
      { key: 'apiKey', label: 'API Key', fieldType: 'password' },
      { key: 'tenantId', label: 'Tenant ID', fieldType: 'text' },
    ],
    hasHandler: true,
    hasPickupPoints: true,
    hasFeeSync: true,
    feeFetchCredentials: { apiKey: 'apiKey', tenantId: 'tenantId' },
    isActive: true,
  },
  {
    slug: 'maystro',
    name: 'Maystro delivery',
    displayName: 'Maystro Delivery',
    logoPath: '/assets/logos/maystro.jpg',
    credentialFields: [
      { key: 'codeAutorisation', label: "Code d'autorisation", fieldType: 'password' },
    ],
    hasHandler: false,
    hasPickupPoints: false,
    hasFeeSync: false,
    feeFetchCredentials: {},
    isActive: true,
  },
  {
    slug: 'ecotrack',
    name: 'Ecotrack',
    displayName: 'Ecotrack',
    logoPath: '/assets/logos/ecotrack.jpg',
    credentialFields: [
      { key: 'lienCompte', label: 'Lien Compte', fieldType: 'text' },
      { key: 'apiToken', label: 'API Token', fieldType: 'password' },
    ],
    hasHandler: false,
    hasPickupPoints: false,
    hasFeeSync: false,
    feeFetchCredentials: {},
    isActive: true,
  },
  {
    slug: 'yalidine',
    name: 'Yalidine',
    displayName: 'Yalidine',
    logoPath: '/assets/logos/yalidine.jpg',
    credentialFields: [
      { key: 'apiToken', label: 'API Token', fieldType: 'password' },
      { key: 'apiIdCle', label: 'API ID Clé', fieldType: 'text' },
      { key: 'wilaya', label: 'Wilaya', fieldType: 'text' },
    ],
    hasHandler: false,
    hasPickupPoints: false,
    hasFeeSync: false,
    feeFetchCredentials: {},
    isActive: true,
  },
  {
    slug: 'ecom-delivery',
    name: 'Ecom delivery',
    displayName: 'Ecom Delivery',
    logoPath: '/assets/logos/ecom.jpg',
    credentialFields: [
      { key: 'key', label: 'Key', fieldType: 'password' },
      { key: 'token', label: 'Token', fieldType: 'password' },
    ],
    hasHandler: true,
    hasPickupPoints: true,
    hasFeeSync: true,
    feeFetchCredentials: { apiKey: 'key', apiToken: 'token' },
    isActive: true,
  },
  {
    slug: 'noest',
    name: 'Noest',
    displayName: 'Noest Express',
    logoPath: '/assets/logos/noest.jpg',
    credentialFields: [
      { key: 'apiToken', label: 'API Token', fieldType: 'password' },
      { key: 'guid', label: 'GUID', fieldType: 'password' },
    ],
    hasHandler: true,
    hasPickupPoints: true,
    hasFeeSync: true,
    feeFetchCredentials: {},
    isActive: true,
  },
  {
    slug: 'zimou',
    name: 'Zimou express',
    displayName: 'Zimou Express',
    logoPath: '/assets/logos/zimou.jpg',
    credentialFields: [
      { key: 'apiIdCle', label: 'API ID Clé', fieldType: 'password' },
    ],
    hasHandler: false,
    hasPickupPoints: false,
    hasFeeSync: false,
    feeFetchCredentials: {},
    isActive: true,
  },
  {
    slug: 'elogistia',
    name: 'Elogistia',
    displayName: 'Elogistia',
    logoPath: '/assets/logos/elogistia.jpg',
    credentialFields: [
      { key: 'apiIdCle', label: 'API ID Clé', fieldType: 'password' },
    ],
    hasHandler: false,
    hasPickupPoints: false,
    hasFeeSync: false,
    feeFetchCredentials: {},
    isActive: true,
  },
  {
    slug: 'dhd',
    name: 'DHD',
    displayName: 'DHD',
    logoPath: '/assets/logos/dhd.jpg',
    credentialFields: [
      { key: 'apiToken', label: 'API Token', fieldType: 'password' },
    ],
    hasHandler: false,
    hasPickupPoints: true,
    hasFeeSync: true,
    feeFetchCredentials: { apiToken: 'apiToken' },
    isActive: true,
  },
];

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const db = mongoose.connection.db;
  const collection = db.collection('deliverycompanies');

  const existing = await collection.countDocuments();
  console.log(`Existing companies in DB: ${existing}`);

  if (existing > 0) {
    console.log('Companies already seeded. Dropping and re-seeding...');
    await collection.deleteMany({});
  }

  const docs = companies.map(c => ({
    ...c,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));

  const result = await collection.insertMany(docs);
  console.log(`Inserted ${result.insertedCount} delivery companies`);

  await collection.createIndex({ slug: 1 }, { unique: true });
  console.log('Created unique index on slug');

  const finalCount = await collection.countDocuments();
  console.log(`Final count: ${finalCount}`);
  console.log('Seeding completed successfully!');

  await mongoose.disconnect();
}

main().catch(err => { console.error('Seeding failed:', err); process.exit(1); });