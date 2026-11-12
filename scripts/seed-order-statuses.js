const { connect, connection } = require('mongoose');
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/imraaah';

const STATUSES = [
  { slug: 'placed',       displayName: 'Placed (COD)',    nameEn: 'Placed (COD)',    nameFr: 'Commandée (COD)',       nameAr: 'تم الطلب (الدفع عند التوصيل)', color: 'amber',   sortOrder: 1 },
  { slug: 'confirmed',    displayName: 'Confirmed',       nameEn: 'Confirmed',       nameFr: 'Confirmée',              nameAr: 'تم التأكيد',                    color: 'blue',    sortOrder: 2 },
  { slug: 'dispatched',   displayName: 'Dispatched',      nameEn: 'Dispatched',      nameFr: 'Expédiée',               nameAr: 'تم التوزيع',                    color: 'gold',    sortOrder: 3 },
  { slug: 'in-transit',   displayName: 'In Transit',      nameEn: 'In Transit',      nameFr: 'En Transit',             nameAr: 'قيد النقل',                     color: 'purple',  sortOrder: 4 },
  { slug: 'delivered',    displayName: 'Delivered',       nameEn: 'Delivered',       nameFr: 'Livrée',                 nameAr: 'تم التوصيل',                    color: 'emerald', sortOrder: 5 },
  { slug: 'cancelled',    displayName: 'Cancelled',       nameEn: 'Cancelled',       nameFr: 'Annulée',                nameAr: 'ملغي',                          color: 'red',     sortOrder: 6 },
  { slug: 'returned',     displayName: 'Returned',        nameEn: 'Returned',        nameFr: 'Retournée',              nameAr: 'مرتجع',                         color: 'rose',    sortOrder: 7 },
];

async function seed() {
  await connect(MONGO_URI);

  const db = connection.db;
  const collection = db.collection('orderstatuses');

  await collection.createIndex({ slug: 1 }, { unique: true });

  for (const status of STATUSES) {
    await collection.updateOne(
      { slug: status.slug },
      { $set: status },
      { upsert: true },
    );
  }

  console.log(`Seeded ${STATUSES.length} order statuses.`);
  await connection.close();
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
