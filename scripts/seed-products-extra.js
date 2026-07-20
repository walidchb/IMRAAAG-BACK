require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;

const extraProducts = [
  { nameEn: 'Crepe Wrap Dress', nameAr: 'فستان ملفوف كريب', nameFr: 'Robe Portefeuille Crêpe', slug: 'crepe-wrap-dress' },
  { nameEn: 'Linen Button-Up Shirt', nameAr: 'قميص أزرار كتان', nameFr: 'Chemise Boutonnée Lin', slug: 'linen-button-up-shirt' },
  { nameEn: 'A-Line Mini Skirt', nameAr: 'تنورة قصيرة A-line', nameFr: 'Jupe Courte A-Ligne', slug: 'a-line-mini-skirt' },
  { nameEn: 'Cargo Pants', nameAr: 'بنطلون كارغو', nameFr: 'Pantalon Cargo', slug: 'cargo-pants' },
  { nameEn: 'Open Front Abaya', nameAr: 'عباية مفتوحة', nameFr: 'Abaya Ouverte', slug: 'open-front-abaya' },
  { nameEn: 'Striped Jilbab', nameAr: 'جلباب مخطط', nameFr: 'Jilbab Rayé', slug: 'striped-jilbab' },
  { nameEn: 'Two-Piece Skirt Set', nameAr: 'طقم تنورة من قطعتين', nameFr: 'Ensemble Jupe Deux Pièces', slug: 'two-piece-skirt-set' },
  { nameEn: 'Satin Hijab', nameAr: 'حجاب ساتان', nameFr: 'Hijab Satin', slug: 'satin-hijab' },
  { nameEn: 'Crinkle Khimar', nameAr: 'خمار مجعد', nameFr: 'Khimar Froissé', slug: 'crinkle-khimar' },
  { nameEn: 'Belted Modest Dress', nameAr: 'فستان محتشم بحزام', nameFr: 'Robe Modeste Ceinturée', slug: 'belted-modest-dress' },
  { nameEn: 'Quick-Dry Sports Top', nameAr: 'قميص رياضي سريع الجفاف', nameFr: 'Haut de Sport Séchage Rapide', slug: 'quick-dry-sports-top' },
  { nameEn: 'Yoga Leggings', nameAr: 'ليجينز يوجا', nameFr: 'Leggings Yoga', slug: 'yoga-leggings' },
  { nameEn: 'Mesh Panel Sports Bra', nameAr: 'حمالة صدر رياضية شبكية', nameFr: 'Soutien-gorge Sport Mesh', slug: 'mesh-panel-sports-bra' },
  { nameEn: 'Cotton Bralette', nameAr: 'براليت قطني', nameFr: 'Bralette Coton', slug: 'cotton-bralette' },
  { nameEn: 'Boyshort Underwear', nameAr: 'شورت داخلي', nameFr: 'Shorty', slug: 'boyshort-underwear' },
  { nameEn: 'Waist Cincher', nameAr: 'مشدد خصر', nameFr: 'Cache-ceinture Minceur', slug: 'waist-cincher' },
  { nameEn: 'Chemise Nightie', nameAr: 'ثوب نوم', nameFr: 'Nuise', slug: 'chemise-nightie' },
  { nameEn: 'Tote Bag', nameAr: 'حقيبة تسوق', nameFr: 'Sac Fourre-tout', slug: 'tote-bag' },
  { nameEn: 'Choker Necklace', nameAr: 'قلادة شوكر', nameFr: 'Collier Choker', slug: 'choker-necklace' },
  { nameEn: 'Chain Belt', nameAr: 'حزام سلسلة', nameFr: 'Ceinture Chaîne', slug: 'chain-belt' },
  { nameEn: 'Platform Heels', nameAr: 'كعب ذو منصة', nameFr: 'Talons Plateforme', slug: 'platform-heels' },
  { nameEn: 'Running Shoes', nameAr: 'حذاء جري', nameFr: 'Chaussures de Course', slug: 'running-shoes' },
  { nameEn: 'Espadrille Sandals', nameAr: 'صندل إسبادريل', nameFr: 'Sandales Espadrille', slug: 'espadrille-sandals' },
  { nameEn: 'Combat Boots', nameAr: 'جزمة عسكرية', nameFr: 'Bottes de Combat', slug: 'combat-boots' },
  { nameEn: 'Niacinamide Moisturizer', nameAr: 'مرطب نياسيناميد', nameFr: 'Hydratant Niacinamide', slug: 'niacinamide-moisturizer' },
  { nameEn: 'Setting Spray', nameAr: 'رذاذ تثبيت المكياج', nameFr: 'Spray Fixateur', slug: 'setting-spray' },
  { nameEn: 'Coconut Hair Oil', nameAr: 'زيت شعر جوز الهند', nameFr: 'Huile Capillaire Noix de Coco', slug: 'coconut-hair-oil' },
  { nameEn: 'Oud Perfume Oil', nameAr: 'دهن عود', nameFr: 'Huile de Parfum Oud', slug: 'oud-perfume-oil' },
  { nameEn: 'Beaded Clutch Bag', nameAr: 'حقيبة كلاتش مطرزة', nameFr: 'Sac Clutch Perlé', slug: 'beaded-clutch-bag' },
  { nameEn: 'Tiered Maxi Skirt', nameAr: 'تنورة ماكسي متدرجة', nameFr: 'Jupe Maxi à Volants', slug: 'tiered-maxi-skirt' },
  { nameEn: 'Cropped Cardigan', nameAr: 'كارديغان قصير', nameFr: 'Cardigan Court', slug: 'cropped-cardigan' },
  { nameEn: 'Pinstripe Blazer', nameAr: 'بليزر مخطط', nameFr: 'Blazer Rayures Fines', slug: 'pinstripe-blazer' },
  { nameEn: 'Sweater Vest', nameAr: 'سترة صدرية', nameFr: 'Gilet Pull', slug: 'sweater-vest' },
  { nameEn: 'Bamboo Fiber Set', nameAr: 'طقم ألياف الخيزران', nameFr: 'Ensemble Fibre de Bambou', slug: 'bamboo-fiber-set' },
  { nameEn: 'Faux Leather Jacket', nameAr: 'جاكيت جلد صناعي', nameFr: 'Veste Fausse Cuir', slug: 'faux-leather-jacket' },
  { nameEn: 'Velvet Blazer', nameAr: 'بليزر مخمل', nameFr: 'Blazer Velours', slug: 'velvet-blazer' },
  { nameEn: 'Pleated Trousers', nameAr: 'بنطلون مطوي', nameFr: 'Pantalon Plissé', slug: 'pleated-trousers' },
  { nameEn: 'Off-Shoulder Top', nameAr: 'بلوزة مكشوفة الكتفين', nameFr: 'Haut Décolleté Épaules', slug: 'off-shoulder-top' },
  { nameEn: 'Cutout Detail Dress', nameAr: 'فستان بقصات', nameFr: 'Robe à Découpes', slug: 'cutout-detail-dress' },
  { nameEn: 'Ribbed Knit Set', nameAr: 'طقم محبوك مضلع', nameFr: 'Ensemble Maille Côtelée', slug: 'ribbed-knit-set' },
  { nameEn: 'Geometric Print Scarf', nameAr: 'وشاح هندسي', nameFr: 'Écharpe Motif Géométrique', slug: 'geometric-print-scarf' },
  { nameEn: 'Wide-Brim Hat', nameAr: 'قبعة عريضة الحواف', nameFr: 'Chapeau à Large Bord', slug: 'wide-brim-hat' },
  { nameEn: 'Leather Gloves', nameAr: 'قفازات جلدية', nameFr: 'Gants en Cuir', slug: 'leather-gloves' },
  { nameEn: 'Anklet Bracelet', nameAr: 'سوار كاحل', nameFr: 'Bracelet Cheville', slug: 'anklet-bracelet' },
  { nameEn: 'Statement Earrings', nameAr: 'أقراط مميزة', nameFr: 'Boucles d\'Oreilles Statement', slug: 'statement-earrings' },
  { nameEn: 'Silk Blouse', nameAr: 'بلوزة حريرية', nameFr: 'Chemisier en Soie', slug: 'silk-blouse' },
  { nameEn: 'Wool Beret', nameAr: 'قبعة صوفية', nameFr: 'Béret en Laine', slug: 'wool-beret' },
  { nameEn: 'Saddle Bag', nameAr: 'حقيبة سرج', nameFr: 'Sac Selle', slug: 'saddle-bag' },
  { nameEn: 'Layered Necklace', nameAr: 'قلادة متعددة الطبقات', nameFr: 'Collier Superposé', slug: 'layered-necklace' },
  { nameEn: 'Embroidered Belt Bag', nameAr: 'حقيبة حزام مطرزة', nameFr: 'Sac Ceinture Brodé', slug: 'embroidered-belt-bag' },
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
  'https://images.unsplash.com/photo-1578932750294-f5075e85f44a?w=800',
  'https://images.unsplash.com/photo-1548625361-cafc1cc205b8?w=800',
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
  const shuffled = shuffle([...extraProducts]);
  const perCategory = Math.ceil(50 / catIds.length);
  const vendorEmail = 'walidchebbab2001@gmail.com';

  let idx = 0;

  for (const catId of catIds) {
    const catInfo = categoryMap[catId];
    if (!catInfo.subs.length) continue;

    for (let i = 0; i < perCategory && idx < shuffled.length; i++) {
      const prod = shuffled[idx++];
      const subCat = randomFrom(catInfo.subs);
      const img = imagePool[idx % imagePool.length];
      const storyIdx = Math.floor(Math.random() * stories.en.length);

      const now = new Date(Date.now() + idx);

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
        createdAt: now,
        updatedAt: now,
      };

      await mongoose.connection.db.collection('products').insertOne(doc);
      console.log(`Created: ${prod.nameEn} (${catInfo.data.nameEn} > ${subCat.nameEn})`);
    }
  }

  const total = await mongoose.connection.db.collection('products').countDocuments({ vendorEmail });
  console.log(`\nDone! Total products for ${vendorEmail}: ${total}`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
