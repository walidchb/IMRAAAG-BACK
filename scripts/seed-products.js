require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;

const productSchema = new mongoose.Schema({
  vendorEmail: { type: String, required: true },
  nameEn: { type: String, required: true },
  nameAr: { type: String, required: true },
  nameFr: { type: String, required: true },
  slug: { type: String, required: true, unique: true, lowercase: true },
  storyEn: String,
  storyAr: String,
  storyFr: String,
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
  subCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'SubCategory' },
  originalPrice: { type: Number, required: true, min: 0 },
  price: { type: Number, required: true, min: 0 },
  stock: { type: Number, required: true, min: 0, default: 0 },
  weight: { type: Number, required: true, min: 0 },
  image: String,
  images: [String],
  status: { type: String, enum: ['Active', 'Draft'], default: 'Active' },
  published: { type: Boolean, default: false },
  variants: [{
    nameEn: String,
    nameAr: String,
    nameFr: String,
    type: { type: String, enum: ['generic', 'color'] },
    options: [{
      nameEn: String,
      nameAr: String,
      nameFr: String,
      value: String,
    }]
  }]
}, { timestamps: true });

const Product = mongoose.model('Product', productSchema);

const products = [
  { nameEn: 'Elegant Floral Dress', nameAr: 'فستان زهري أنيق', nameFr: 'Robe Fleurie Élégante', slug: 'elegant-floral-dress' },
  { nameEn: 'Casual Cotton Top', nameAr: 'بلوزة قطنية كاجوال', nameFr: 'Haut en Coton Décontracté', slug: 'casual-cotton-top' },
  { nameEn: 'Pleated Midi Skirt', nameAr: 'تنورة ميدي مطوية', nameFr: 'Jupe Plissée Mi-longue', slug: 'pleated-midi-skirt' },
  { nameEn: 'Wide Leg Trousers', nameAr: 'بنطلون واسع الساق', nameFr: 'Pantalon Large', slug: 'wide-leg-trousers' },
  { nameEn: 'Classic Black Abaya', nameAr: 'عباية سوداء كلاسيكية', nameFr: 'Abaya Noire Classique', slug: 'classic-black-abaya' },
  { nameEn: 'Premium Jersey Jilbab', nameAr: 'جلباب جيرسي فاخر', nameFr: 'Jilbab en Jersey Premium', slug: 'premium-jersey-jilbab' },
  { nameEn: 'Chic Co-ord Set', nameAr: 'طقم منسق أنيق', nameFr: 'Ensemble Coordonné Chic', slug: 'chic-co-ord-set' },
  { nameEn: 'Everyday Chiffon Hijab', nameAr: 'حجاب شيفون يومي', nameFr: 'Hijab en Mousseline Quotidien', slug: 'everyday-chiffon-hijab' },
  { nameEn: 'Embroidered Khimar', nameAr: 'خمار مطرز', nameFr: 'Khimar Brodé', slug: 'embroidered-khimar' },
  { nameEn: 'Layered Modest Abaya', nameAr: 'عباية محتشمة متعددة الطبقات', nameFr: 'Abaya Modeste Superposée', slug: 'layered-modest-abaya' },
  { nameEn: 'Breathable Sports Hijab', nameAr: 'حجاب رياضي قابل للتنفس', nameFr: 'Hijab de Sport Respirant', slug: 'breathable-sports-hijab' },
  { nameEn: 'High Waist Leggings', nameAr: 'ليجينز عالي الخصر', nameFr: 'Leggings Taille Haute', slug: 'high-waist-leggings' },
  { nameEn: 'Compression Sports Top', nameAr: 'قميص رياضي ضاغط', nameFr: 'Haut de Sport Compression', slug: 'compression-sports-top' },
  { nameEn: 'Lace Balconette Bra', nameAr: 'حمالة صدر دانتيل', nameFr: 'Soutien-gorge Balconette Dentelle', slug: 'lace-balconette-bra' },
  { nameEn: 'Seamless Underwear Set', nameAr: 'طقم ملابس داخلية بدون درز', nameFr: 'Ensemble Sous-vêtements Sans Couture', slug: 'seamless-underwear-set' },
  { nameEn: 'Tummy Control Shapewear', nameAr: 'مشد التحكم في البطن', nameFr: 'Gaine Ventre Plat', slug: 'tummy-control-shapewear' },
  { nameEn: 'Silk Sleepwear Set', nameAr: 'طقم نوم حريري', nameFr: 'Ensemble Nuit en Soie', slug: 'silk-sleepwear-set' },
  { nameEn: 'Leather Crossbody Bag', nameAr: 'حقيبة كروس جلدية', nameFr: 'Sac Bandoulière en Cuir', slug: 'leather-crossbody-bag' },
  { nameEn: 'Gold Hoop Earrings', nameAr: 'أقراط دائرية ذهبية', nameFr: 'Boucles d\'Oreilles Cercles Or', slug: 'gold-hoop-earrings' },
  { nameEn: 'Wide Leather Belt', nameAr: 'حزام جلدي عريض', nameFr: 'Ceinture Cuir Large', slug: 'wide-leather-belt' },
  { nameEn: 'Stretch Stilettos Heels', nameAr: 'كعب عالي ستريتش', nameFr: 'Talons Aiguilles Stretch', slug: 'stretch-stilettos-heels' },
  { nameEn: 'White Canvas Sneakers', nameAr: 'حذاء رياضي كانفاس أبيض', nameFr: 'Baskets en Toile Blanches', slug: 'white-canvas-sneakers' },
  { nameEn: 'Embellished Flat Sandals', nameAr: 'صنادل مسطحة مرصعة', nameFr: 'Sandales Plates Ornées', slug: 'embellished-flat-sandals' },
  { nameEn: 'Ankle Leather Boots', nameAr: 'جزمة جلد كاحل', nameFr: 'Bottes Cheville en Cuir', slug: 'ankle-leather-boots' },
  { nameEn: 'Vitamin C Serum', nameAr: 'سيروم فيتامين سي', nameFr: 'Sérum Vitamine C', slug: 'vitamin-c-serum' },
  { nameEn: 'Matte Liquid Lipstick', nameAr: 'أحمر شفاه سائل غير لامع', nameFr: 'Rouge à Lèvres Liquide Mat', slug: 'matte-liquid-lipstick' },
  { nameEn: 'Argan Oil Hair Mask', nameAr: 'ماسك شعر زيت الأرغان', nameFr: 'Masque Capillaire à l\'Huile d\'Argan', slug: 'argan-oil-hair-mask' },
  { nameEn: 'Rose Perfume Spray', nameAr: 'عطر ورد', nameFr: 'Parfum à la Rose', slug: 'rose-perfume-spray' },
  { nameEn: 'Handmade Embroidered Abaya', nameAr: 'عباية مطرزة يدويًا', nameFr: 'Abaya Brodée à la Main', slug: 'handmade-embroidered-abaya' },
  { nameEn: 'Artisan Embroidered Hijab', nameAr: 'حجاب مطرز حرفي', nameFr: 'Hijab Brodé Artisanal', slug: 'artisan-embroidered-hijab' },
  { nameEn: 'Tailored Blazer', nameAr: 'بليزر مفصل', nameFr: 'Blazer Sur Mesure', slug: 'tailored-blazer' },
  { nameEn: 'Denim Jacket', nameAr: 'جاكيت جينز', nameFr: 'Veste en Jean', slug: 'denim-jacket' },
  { nameEn: 'Knit Cardigan', nameAr: 'كارديغان محبوك', nameFr: 'Cardigan Tissé', slug: 'knit-cardigan' },
  { nameEn: 'Evening Gown', nameAr: 'فستان سهرة', nameFr: 'Robe de Soirée', slug: 'evening-gown' },
  { nameEn: 'Summer Maxi Dress', nameAr: 'فستان ماكسي صيفي', nameFr: 'Robe Maxi d\'Été', slug: 'summer-maxi-dress' },
  { nameEn: 'Puffer Vest', nameAr: 'سترة بافرة', nameFr: 'Gilet Duvet', slug: 'puffer-vest' },
  { nameEn: 'Cashmere Scarf', nameAr: 'وشاح كشمير', nameFr: 'Écharpe en Cachemire', slug: 'cashmere-scarf' },
  { nameEn: 'Wool Blend Coat', nameAr: 'معطف صوف', nameFr: 'Manteau en Laine', slug: 'wool-blend-coat' },
  { nameEn: 'Sequin Party Top', nameAr: 'بلوزة حفلات بترتر', nameFr: 'Haut de Fête à Sequins', slug: 'sequin-party-top' },
  { nameEn: 'Boho Chic Jumpsuit', nameAr: 'جمبسوت بوهو', nameFr: 'Combinaison Bohème', slug: 'boho-chic-jumpsuit' },
];

const imagePool = [
  'https://images.unsplash.com/photo-1564257631407-4deb1f99d992?w=800',
  'https://images.unsplash.com/photo-1595777457583-95e059d581b8?w=800',
  'https://images.unsplash.com/photo-1572804013309-59a88b7e92f1?w=800',
  'https://images.unsplash.com/photo-1551028719-00167b16eac5?w=800',
  'https://images.unsplash.com/photo-1596755094514-f87e34085b2c?w=800',
  'https://images.unsplash.com/photo-1585487000160-6ebcfceb0d03?w=800',
  'https://images.unsplash.com/photo-1509631179647-0177331693ae?w=800',
  'https://images.unsplash.com/photo-1608236415056-5b0df5127ece?w=800',
  'https://images.unsplash.com/photo-1551232864-3f0890e580d9?w=800',
  'https://images.unsplash.com/photo-1591369822096-5ca80a9f3f9b?w=800',
  'https://images.unsplash.com/photo-1595777457583-95e059d581b8?w=800',
  'https://images.unsplash.com/photo-1564257631407-4deb1f99d992?w=800',
  'https://images.unsplash.com/photo-1578932750294-f5075e85f44a?w=800',
  'https://images.unsplash.com/photo-1548625361-cafc1cc205b8?w=800',
  'https://images.unsplash.com/photo-1595777457583-95e059d581b8?w=800',
  'https://images.unsplash.com/photo-1608236415056-5b0df5127ece?w=800',
  'https://images.unsplash.com/photo-1509631179647-0177331693ae?w=800',
  'https://images.unsplash.com/photo-1551232864-3f0890e580d9?w=800',
  'https://images.unsplash.com/photo-1585487000160-6ebcfceb0d03?w=800',
  'https://images.unsplash.com/photo-1572804013309-59a88b7e92f1?w=800',
  'https://images.unsplash.com/photo-1551028719-00167b16eac5?w=800',
  'https://images.unsplash.com/photo-1596755094514-f87e34085b2c?w=800',
  'https://images.unsplash.com/photo-1564257631407-4deb1f99d992?w=800',
  'https://images.unsplash.com/photo-1578932750294-f5075e85f44a?w=800',
  'https://images.unsplash.com/photo-1548625361-cafc1cc205b8?w=800',
  'https://images.unsplash.com/photo-1591369822096-5ca80a9f3f9b?w=800',
  'https://images.unsplash.com/photo-1509631179647-0177331693ae?w=800',
  'https://images.unsplash.com/photo-1608236415056-5b0df5127ece?w=800',
  'https://images.unsplash.com/photo-1551232864-3f0890e580d9?w=800',
  'https://images.unsplash.com/photo-1564257631407-4deb1f99d992?w=800',
  'https://images.unsplash.com/photo-1572804013309-59a88b7e92f1?w=800',
  'https://images.unsplash.com/photo-1595777457583-95e059d581b8?w=800',
  'https://images.unsplash.com/photo-1551028719-00167b16eac5?w=800',
  'https://images.unsplash.com/photo-1585487000160-6ebcfceb0d03?w=800',
  'https://images.unsplash.com/photo-1578932750294-f5075e85f44a?w=800',
  'https://images.unsplash.com/photo-1548625361-cafc1cc205b8?w=800',
  'https://images.unsplash.com/photo-1591369822096-5ca80a9f3f9b?w=800',
  'https://images.unsplash.com/photo-1596755094514-f87e34085b2c?w=800',
  'https://images.unsplash.com/photo-1509631179647-0177331693ae?w=800',
  'https://images.unsplash.com/photo-1608236415056-5b0df5127ece?w=800',
];

const stories = {
  en: [
    'Elevate your wardrobe with this stunning piece, designed for the modern woman who values both style and comfort.',
    'Crafted from premium materials, this piece offers exceptional quality and timeless elegance for any occasion.',
    'Experience unparalleled comfort and sophistication with this carefully designed addition to your collection.',
    'Made with attention to every detail, this piece combines traditional craftsmanship with contemporary design.',
    'A versatile essential that transitions seamlessly from day to night, perfect for the fashion-forward individual.',
  ],
  ar: [
    'ارفعي مستوى خزانة ملابسك بهذه القطعة الرائعة، المصممة للمرأة العصرية التي تقدر الأناقة والراحة.',
    'مصنوعة من مواد فاخرة، تقدم هذه القطعة جودة استثنائية وأناقة خالدة لأي مناسبة.',
    'استمتعي براحة وتطور لا مثيل لهما مع هذه الإضافة المصممة بعناية لمجموعتك.',
    'مصنوعة بعناية فائقة لكل تفصيل، تجمع هذه القطعة بين الحرفية التقليدية والتصميم المعاصر.',
    'قطعة أساسية متعددة الاستخدامات تنتقل بسلاسة من النهار إلى المساء، مثالية لعشاق الموضة.',
  ],
  fr: [
    'Élevez votre garde-robe avec cette magnifique pièce, conçue pour la femme moderne qui valorise le style et le confort.',
    'Fabriquée à partir de matériaux premium, cette pièce offre une qualité exceptionnelle et une élégance intemporelle.',
    'Profitez d\'un confort et d\'une sophistication inégalés avec cet ajout soigneusement conçu à votre collection.',
    'Fabriquée avec une attention à chaque détail, cette pièce allie artisanat traditionnel et design contemporain.',
    'Un essentiel polyvalent qui passe harmonieusement du jour à la nuit, parfait pour les avant-gardistes de la mode.',
  ],
};

const variantTemplate = {
  nameEn: 'Size',
  nameAr: 'المقاس',
  nameFr: 'Taille',
  type: 'generic',
  options: [
    { nameEn: 'S', nameAr: 'صغير', nameFr: 'S' },
    { nameEn: 'M', nameAr: 'متوسط', nameFr: 'M' },
    { nameEn: 'L', nameAr: 'كبير', nameFr: 'L' },
    { nameEn: 'XL', nameAr: 'كبير جدًا', nameFr: 'XL' },
  ],
};

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const categories = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../test.categories.json'), 'utf8'));
  const subcategories = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../test.subcategories.json'), 'utf8'));

  const categoryMap = {};
  for (const cat of categories) {
    const id = cat._id.$oid || cat._id;
    const subs = subcategories.filter(sc => (sc.categoryId.$oid || sc.categoryId) === id);
    categoryMap[id] = { data: cat, subs };
  }

  const catIds = Object.keys(categoryMap);
  const shuffled = shuffle([...products]);
  const perCategory = Math.ceil(40 / catIds.length);
  const vendorEmail = 'walidchebbab2001@gmail.com';

  let idx = 0;

  for (const catId of catIds) {
    const catInfo = categoryMap[catId];
    if (!catInfo.subs.length) continue;

    for (let i = 0; i < perCategory && idx < shuffled.length; i++) {
      const prod = shuffled[idx++];
      const subCat = randomFrom(catInfo.subs);
      const img = imagePool[idx - 1];
      const storyIdx = Math.floor(Math.random() * stories.en.length);

      const doc = {
        vendorEmail,
        nameEn: prod.nameEn,
        nameAr: prod.nameAr,
        nameFr: prod.nameFr,
        slug: prod.slug,
        storyEn: stories.en[storyIdx],
        storyAr: stories.ar[storyIdx],
        storyFr: stories.fr[storyIdx],
        category: catId,
        subCategory: subCat._id.$oid || subCat._id,
        originalPrice: Math.floor(Math.random() * 5000) + 500,
        price: Math.floor(Math.random() * 4000) + 300,
        stock: Math.floor(Math.random() * 50) + 5,
        weight: parseFloat((Math.random() * 2 + 0.1).toFixed(2)),
        image: img,
        images: shuffle([...imagePool]).slice(0, 3),
        status: 'Active',
        published: true,
        variants: [variantTemplate],
      };

      const now = new Date();
      doc.createdAt = now;
      doc.updatedAt = now;
      await mongoose.connection.db.collection('products').insertOne(doc);
      console.log(`Created: ${prod.nameEn} (${catInfo.data.nameEn} > ${subCat.nameEn})`);
    }
  }

  const total = await Product.countDocuments({ vendorEmail });
  console.log(`\nDone! Total products for ${vendorEmail}: ${total}`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
