import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from '../modules/users/schemas/user.schema';
import { Store, StoreDocument } from '../modules/stores/schemas/store.schema';
import { StoreStatus } from '../modules/stores/schemas/store-status.enum';
import { Product } from '../modules/products/schemas/product.schema';
import { Role } from '../common/constants/roles.enum';
import * as bcrypt from 'bcrypt';
import * as fs from 'fs';
import * as path from 'path';

const VENDORS = [
  { fullName: 'Karim Bensalem', storeName: 'Artisanat Kabyle', tagline: 'Heritage woven by hand', wilaya: 'Tizi Ouzou', commune: 'Tizi Ouzou', categories: ['Handmade & Artisan', 'Accessories'] },
  { fullName: 'Fatima Zohra Moussaoui', storeName: 'Lune d\'Alger', tagline: 'Elegance with a soul', wilaya: 'Alger', commune: 'Alger Centre', categories: ["Women's Fashion", 'Accessories'] },
  { fullName: 'Ahmed Ould Ammar', storeName: 'Sable et Cuir', tagline: 'Authentic desert craftsmanship', wilaya: 'Adrar', commune: 'Adrar', categories: ['Handmade & Artisan', "Men's Fashion"] },
  { fullName: 'Samira Belkacem', storeName: 'Nour Créations', tagline: 'Modern designs, timeless beauty', wilaya: 'Oran', commune: 'Oran', categories: ["Women's Fashion", 'Accessories'] },
  { fullName: 'Mohamed Lamine Benali', storeName: 'Benali Traditions', tagline: 'Preserving Algerian heritage', wilaya: 'Constantine', commune: 'Constantine', categories: ['Handmade & Artisan', 'Home & Decor'] },
  { fullName: 'Hakima Tizi Ouzou', storeName: 'Tissage d\'Ath Yenni', tagline: 'Silk & silver from the mountains', wilaya: 'Tizi Ouzou', commune: 'Ath Yenni', categories: ['Handmade & Artisan', 'Accessories'] },
  { fullName: 'Rachid Boumedienne', storeName: 'Dzair Craft', tagline: 'Made in Algeria with pride', wilaya: 'Annaba', commune: 'Annaba', categories: ["Men's Fashion", 'Handmade & Artisan'] },
  { fullName: 'Amina Mansouri', storeName: 'Jewels of Tassili', tagline: 'Berber jewellery reimagined', wilaya: 'Tamanrasset', commune: 'Tamanrasset', categories: ['Accessories', 'Handmade & Artisan'] },
  { fullName: 'Sofiane Khelifi', storeName: 'Khelifi Textiles', tagline: 'Fabrics that tell stories', wilaya: 'Sétif', commune: 'Sétif', categories: ['Home & Decor', "Women's Fashion"] },
  { fullName: 'Nadia Chaouch', storeName: 'Parfums d\'Orient', tagline: 'Scents of the Mediterranean', wilaya: 'Bejaia', commune: 'Bejaia', categories: ['Accessories', 'Handmade & Artisan'] },
];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const userModel = app.get<Model<User>>(getModelToken(User.name));
    const storeModel = app.get<Model<Store>>(getModelToken(Store.name));
    const productModel = app.get<Model<Product>>(getModelToken(Product.name));

    console.log('Seeding 10 vendors with stores...\n');

    const results: { email: string; password: string; fullName: string; storeName: string }[] = [];
    const password = 'Vendor123!';

    for (const v of VENDORS) {
      const email = `${slugify(v.fullName)}@store.imraaah`;
      console.log(`  Creating vendor: ${v.fullName} (${email})`);

      const existingUser = await userModel.findOne({ email });
      if (existingUser) {
        console.log(`    User already exists, skipping.`);
        continue;
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const user = await userModel.create({
        email,
        password: hashedPassword,
        fullName: v.fullName,
        phoneNumber: '',
        role: Role.VENDOR,
        isActive: true,
      });
      console.log(`    User created: ${user._id}`);

      const storeSlug = slugify(v.storeName);
      const existingSlug = await storeModel.findOne({ storeSlug });
      const finalSlug = existingSlug ? `${storeSlug}-${Date.now()}` : storeSlug;

      const store = await storeModel.create({
        vendorEmail: email,
        vendorId: user._id,
        storeName: v.storeName,
        storeSlug: finalSlug,
        description: `Welcome to ${v.storeName} — ${v.tagline.toLowerCase()}. Discover unique Algerian craftsmanship curated by ${v.fullName}.`,
        storeLogo: '',
        coverImage: '',
        contactEmail: email,
        contactPhone: '',
        wilaya: v.wilaya,
        commune: v.commune,
        categories: v.categories,
        tagline: v.tagline,
        socialMedia: { instagram: '', facebook: '', tiktok: '' },
        status: StoreStatus.ACTIVE,
        totalProducts: 0,
        totalOrders: 0,
      }) as StoreDocument;
      console.log(`    Store created: ${store.storeName} (${store._id})`);

      results.push({ email, password, fullName: v.fullName, storeName: v.storeName });
    }

    // --- Assign existing products to these vendors ---
    const allProducts = await productModel.find({}).exec();
    console.log(`\n  ${allProducts.length} total products found.`);

    if (allProducts.length > 0 && results.length > 0) {
      const productsPerVendor = Math.floor(allProducts.length / results.length);
      let productIndex = 0;

      for (const r of results) {
        const count = r === results[results.length - 1]
          ? allProducts.length - productIndex
          : productsPerVendor;

        if (count <= 0) break;

        const productIds = allProducts.slice(productIndex, productIndex + count).map(p => p._id);
        productIndex += count;

        await productModel.updateMany(
          { _id: { $in: productIds } },
          { $set: { vendorEmail: r.email } },
        );
        await storeModel.updateOne(
          { vendorEmail: r.email },
          { $set: { totalProducts: count } },
        );
        console.log(`    ${r.storeName}: assigned ${count} products`);
      }
    }

    // --- Write credentials file ---
    const credsPath = path.resolve(__dirname, '../../..', 'vendor-credentials.txt');
    const lines = results.map(r =>
      `Email:    ${r.email}\nPassword: ${password}\nName:     ${r.fullName}\nStore:    ${r.storeName}\n---`
    );
    fs.writeFileSync(credsPath, lines.join('\n\n'), 'utf-8');
    console.log(`\n✅ Credentials written to: ${credsPath}`);
    console.log(`   Password for all: ${password}`);

  } catch (error) {
    console.error('Seeding failed:', error);
  } finally {
    await app.close();
  }
}

bootstrap();
