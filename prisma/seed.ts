import dotenv from "dotenv";
dotenv.config();

import { PrismaClient, SwipeAction } from "../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const USERS = [
  {
    email: "alice@example.com",
    username: "alice_style",
    firstName: "Alice",
    lastName: "Chen",
    avatarUrl: "https://i.pravatar.cc/150?u=alice",
    dateOfBirth: new Date("1998-04-12"),
    gender: "female",
    location: "Brooklyn, NY",
    bio: "Sneakerhead & streetwear enthusiast. Always hunting for the next grail.",
    stylePreferences: ["streetwear", "athleisure", "casual"],
    favoriteBrands: ["Nike", "Stüssy", "Carhartt WIP", "New Balance"],
    preferredSizes: { tops: "S", bottoms: "S", shoes: "7" },
    onboardingCompleted: true,
  },
  {
    email: "bob@example.com",
    username: "bob_fits",
    firstName: "Bob",
    lastName: "Martinez",
    avatarUrl: "https://i.pravatar.cc/150?u=bob",
    dateOfBirth: new Date("1995-09-23"),
    gender: "male",
    location: "Austin, TX",
    bio: "Minimalist wardrobe, maximum impact. Quality over quantity.",
    stylePreferences: ["minimalist", "smart casual", "scandinavian"],
    favoriteBrands: ["COS", "Arket", "AMI Paris", "Everlane"],
    preferredSizes: { tops: "L", bottoms: "32", shoes: "10" },
    onboardingCompleted: true,
  },
  {
    email: "carol@example.com",
    username: "carol_drip",
    firstName: "Carol",
    lastName: "Nguyen",
    avatarUrl: "https://i.pravatar.cc/150?u=carol",
    dateOfBirth: new Date("2000-01-07"),
    gender: "female",
    location: "Los Angeles, CA",
    bio: "Mixing vintage finds with designer pieces. Fashion is art you wear.",
    stylePreferences: ["vintage", "elevated basics", "eclectic"],
    favoriteBrands: ["Reformation", "& Other Stories", "Aritzia", "Totême"],
    preferredSizes: { tops: "M", bottoms: "27", shoes: "8" },
    onboardingCompleted: true,
  },
];

const ITEMS = [
  // ── Tops ──────────────────────────────────────────────
  { name: "Essential Crew Neck Tee", brand: "Uniqlo", category: "tops", subcategory: "t-shirt", price: 14.90, imageUrl: "https://placehold.co/400x500?text=Crew+Neck+Tee", colors: ["white", "black", "navy"], sizes: ["XS", "S", "M", "L", "XL"], tags: ["basics", "casual", "everyday"], gender: "unisex" },
  { name: "Oversized Graphic Tee", brand: "Stüssy", category: "tops", subcategory: "t-shirt", price: 45.00, imageUrl: "https://placehold.co/400x500?text=Graphic+Tee", colors: ["black", "white"], sizes: ["S", "M", "L", "XL"], tags: ["streetwear", "graphic", "oversized"], gender: "unisex" },
  { name: "Slim Fit Oxford Shirt", brand: "Ralph Lauren", category: "tops", subcategory: "shirt", price: 89.50, imageUrl: "https://placehold.co/400x500?text=Oxford+Shirt", colors: ["white", "light blue", "pink"], sizes: ["S", "M", "L", "XL"], tags: ["smart casual", "preppy", "classic"], gender: "men" },
  { name: "Linen Camp Collar Shirt", brand: "Zara", category: "tops", subcategory: "shirt", price: 49.90, imageUrl: "https://placehold.co/400x500?text=Camp+Collar", colors: ["beige", "olive", "terracotta"], sizes: ["S", "M", "L", "XL"], tags: ["summer", "relaxed", "resort"], gender: "men" },
  { name: "Ribbed Crop Tank", brand: "Aritzia", category: "tops", subcategory: "tank", price: 28.00, imageUrl: "https://placehold.co/400x500?text=Crop+Tank", colors: ["white", "black", "sage"], sizes: ["XS", "S", "M", "L"], tags: ["minimal", "layering", "fitted"], gender: "women" },
  { name: "Merino Wool Polo", brand: "COS", category: "tops", subcategory: "polo", price: 69.00, imageUrl: "https://placehold.co/400x500?text=Merino+Polo", colors: ["black", "charcoal", "cream"], sizes: ["S", "M", "L", "XL"], tags: ["smart casual", "knitwear", "elevated basics"], gender: "men" },
  { name: "Silk Camisole", brand: "& Other Stories", category: "tops", subcategory: "camisole", price: 59.00, imageUrl: "https://placehold.co/400x500?text=Silk+Cami", colors: ["champagne", "black", "dusty rose"], sizes: ["XS", "S", "M", "L"], tags: ["elegant", "layering", "date night"], gender: "women" },
  { name: "Heavy Cotton Pocket Tee", brand: "Lady White Co.", category: "tops", subcategory: "t-shirt", price: 62.00, imageUrl: "https://placehold.co/400x500?text=Pocket+Tee", colors: ["white", "black", "grey"], sizes: ["S", "M", "L", "XL"], tags: ["premium basics", "japanese cotton", "heavyweight"], gender: "men" },
  { name: "Breton Stripe Long Sleeve", brand: "Saint James", category: "tops", subcategory: "long sleeve", price: 85.00, imageUrl: "https://placehold.co/400x500?text=Breton+Stripe", colors: ["navy/white", "black/white"], sizes: ["S", "M", "L", "XL"], tags: ["french", "classic", "nautical"], gender: "unisex" },
  { name: "Boxy Crop Hoodie", brand: "Nike", category: "tops", subcategory: "hoodie", price: 55.00, imageUrl: "https://placehold.co/400x500?text=Crop+Hoodie", colors: ["grey heather", "black", "pale pink"], sizes: ["XS", "S", "M", "L"], tags: ["athleisure", "cropped", "cozy"], gender: "women" },

  // ── Bottoms ───────────────────────────────────────────
  { name: "501 Original Fit Jeans", brand: "Levi's", category: "bottoms", subcategory: "jeans", price: 79.50, imageUrl: "https://placehold.co/400x500?text=501+Jeans", colors: ["medium indigo", "black", "stonewash"], sizes: ["28", "30", "32", "34", "36"], tags: ["denim", "classic", "straight fit"], gender: "men" },
  { name: "Wide Leg Trouser", brand: "COS", category: "bottoms", subcategory: "trousers", price: 99.00, imageUrl: "https://placehold.co/400x500?text=Wide+Leg+Trouser", colors: ["black", "navy", "khaki"], sizes: ["XS", "S", "M", "L", "XL"], tags: ["tailored", "wide leg", "modern"], gender: "women" },
  { name: "Slim Chinos", brand: "Dockers", category: "bottoms", subcategory: "chinos", price: 59.99, imageUrl: "https://placehold.co/400x500?text=Slim+Chinos", colors: ["khaki", "navy", "olive"], sizes: ["29", "30", "32", "34", "36"], tags: ["smart casual", "versatile", "slim fit"], gender: "men" },
  { name: "High Rise Straight Jeans", brand: "Agolde", category: "bottoms", subcategory: "jeans", price: 188.00, imageUrl: "https://placehold.co/400x500?text=Straight+Jeans", colors: ["light wash", "black"], sizes: ["24", "25", "26", "27", "28", "29", "30"], tags: ["premium denim", "high rise", "straight leg"], gender: "women" },
  { name: "Cargo Joggers", brand: "Nike", category: "bottoms", subcategory: "joggers", price: 65.00, imageUrl: "https://placehold.co/400x500?text=Cargo+Joggers", colors: ["black", "olive", "grey"], sizes: ["S", "M", "L", "XL"], tags: ["athleisure", "cargo", "utility"], gender: "unisex" },
  { name: "Pleated Trousers", brand: "AMI Paris", category: "bottoms", subcategory: "trousers", price: 295.00, imageUrl: "https://placehold.co/400x500?text=Pleated+Trousers", colors: ["black", "grey", "navy"], sizes: ["S", "M", "L", "XL"], tags: ["elevated", "pleated", "french"], gender: "men" },
  { name: "Midi Satin Skirt", brand: "& Other Stories", category: "bottoms", subcategory: "skirt", price: 79.00, imageUrl: "https://placehold.co/400x500?text=Satin+Skirt", colors: ["champagne", "black", "burgundy"], sizes: ["XS", "S", "M", "L"], tags: ["elegant", "satin", "midi"], gender: "women" },
  { name: "Sweat Shorts", brand: "Carhartt WIP", category: "bottoms", subcategory: "shorts", price: 55.00, imageUrl: "https://placehold.co/400x500?text=Sweat+Shorts", colors: ["grey heather", "black", "navy"], sizes: ["S", "M", "L", "XL"], tags: ["casual", "relaxed", "summer"], gender: "men" },
  { name: "Tailored Bermuda Shorts", brand: "Zara", category: "bottoms", subcategory: "shorts", price: 39.90, imageUrl: "https://placehold.co/400x500?text=Bermuda+Shorts", colors: ["beige", "navy", "white"], sizes: ["S", "M", "L", "XL"], tags: ["smart casual", "summer", "tailored"], gender: "men" },
  { name: "Linen Wide Leg Pants", brand: "Reformation", category: "bottoms", subcategory: "pants", price: 148.00, imageUrl: "https://placehold.co/400x500?text=Linen+Pants", colors: ["white", "natural", "black"], sizes: ["XS", "S", "M", "L"], tags: ["linen", "summer", "relaxed"], gender: "women" },

  // ── Outerwear ─────────────────────────────────────────
  { name: "Classic Denim Jacket", brand: "Levi's", category: "outerwear", subcategory: "jacket", price: 98.00, imageUrl: "https://placehold.co/400x500?text=Denim+Jacket", colors: ["medium wash", "black"], sizes: ["S", "M", "L", "XL"], tags: ["denim", "classic", "layering"], gender: "unisex" },
  { name: "Oversized Blazer", brand: "Zara", category: "outerwear", subcategory: "blazer", price: 89.90, imageUrl: "https://placehold.co/400x500?text=Oversized+Blazer", colors: ["black", "charcoal", "camel"], sizes: ["XS", "S", "M", "L", "XL"], tags: ["tailored", "oversized", "power dressing"], gender: "women" },
  { name: "Lightweight Bomber", brand: "Alpha Industries", category: "outerwear", subcategory: "bomber", price: 150.00, imageUrl: "https://placehold.co/400x500?text=Bomber+Jacket", colors: ["sage green", "black", "navy"], sizes: ["S", "M", "L", "XL", "XXL"], tags: ["military", "iconic", "layering"], gender: "men" },
  { name: "Trench Coat", brand: "Arket", category: "outerwear", subcategory: "coat", price: 189.00, imageUrl: "https://placehold.co/400x500?text=Trench+Coat", colors: ["beige", "black"], sizes: ["XS", "S", "M", "L", "XL"], tags: ["classic", "rainy day", "transitional"], gender: "unisex" },
  { name: "Puffer Vest", brand: "The North Face", category: "outerwear", subcategory: "vest", price: 120.00, imageUrl: "https://placehold.co/400x500?text=Puffer+Vest", colors: ["black", "olive", "navy"], sizes: ["S", "M", "L", "XL"], tags: ["outdoor", "layering", "insulated"], gender: "unisex" },
  { name: "Wool Overcoat", brand: "COS", category: "outerwear", subcategory: "coat", price: 250.00, imageUrl: "https://placehold.co/400x500?text=Wool+Overcoat", colors: ["black", "camel", "grey"], sizes: ["S", "M", "L", "XL"], tags: ["winter", "formal", "minimalist"], gender: "men" },
  { name: "Cropped Leather Jacket", brand: "AllSaints", category: "outerwear", subcategory: "jacket", price: 399.00, imageUrl: "https://placehold.co/400x500?text=Leather+Jacket", colors: ["black"], sizes: ["XS", "S", "M", "L"], tags: ["leather", "edgy", "staple"], gender: "women" },
  { name: "Quilted Liner Jacket", brand: "Barbour", category: "outerwear", subcategory: "jacket", price: 165.00, imageUrl: "https://placehold.co/400x500?text=Quilted+Jacket", colors: ["olive", "navy", "black"], sizes: ["S", "M", "L", "XL"], tags: ["heritage", "british", "layering"], gender: "men" },
  { name: "Rain Shell", brand: "Rains", category: "outerwear", subcategory: "raincoat", price: 110.00, imageUrl: "https://placehold.co/400x500?text=Rain+Shell", colors: ["black", "sand", "evergreen"], sizes: ["XS/S", "S/M", "M/L", "L/XL"], tags: ["waterproof", "minimal", "scandinavian"], gender: "unisex" },
  { name: "Fleece Half-Zip", brand: "Patagonia", category: "outerwear", subcategory: "fleece", price: 129.00, imageUrl: "https://placehold.co/400x500?text=Fleece+Half+Zip", colors: ["oatmeal", "black", "sage"], sizes: ["S", "M", "L", "XL"], tags: ["outdoor", "cozy", "sustainable"], gender: "unisex" },

  // ── Shoes ─────────────────────────────────────────────
  { name: "Air Force 1 '07", brand: "Nike", category: "shoes", subcategory: "sneakers", price: 110.00, imageUrl: "https://placehold.co/400x500?text=Air+Force+1", colors: ["white", "black"], sizes: ["7", "8", "9", "10", "11", "12"], tags: ["iconic", "everyday", "clean"], gender: "unisex" },
  { name: "Chuck Taylor 70 High", brand: "Converse", category: "shoes", subcategory: "sneakers", price: 85.00, imageUrl: "https://placehold.co/400x500?text=Chuck+70", colors: ["black", "parchment", "navy"], sizes: ["6", "7", "8", "9", "10", "11", "12"], tags: ["classic", "canvas", "versatile"], gender: "unisex" },
  { name: "550", brand: "New Balance", category: "shoes", subcategory: "sneakers", price: 110.00, imageUrl: "https://placehold.co/400x500?text=NB+550", colors: ["white/green", "white/navy", "white/grey"], sizes: ["7", "8", "9", "10", "11", "12"], tags: ["retro", "basketball", "trending"], gender: "unisex" },
  { name: "Samba OG", brand: "Adidas", category: "shoes", subcategory: "sneakers", price: 100.00, imageUrl: "https://placehold.co/400x500?text=Samba+OG", colors: ["white/black", "black/white"], sizes: ["6", "7", "8", "9", "10", "11", "12"], tags: ["terrace", "classic", "trending"], gender: "unisex" },
  { name: "Classic Chelsea Boot", brand: "Blundstone", category: "shoes", subcategory: "boots", price: 199.95, imageUrl: "https://placehold.co/400x500?text=Chelsea+Boot", colors: ["brown", "black"], sizes: ["7", "8", "9", "10", "11", "12"], tags: ["boots", "versatile", "all-weather"], gender: "unisex" },
  { name: "Leather Loafers", brand: "G.H. Bass", category: "shoes", subcategory: "loafers", price: 110.00, imageUrl: "https://placehold.co/400x500?text=Loafers", colors: ["burgundy", "black", "tan"], sizes: ["7", "8", "9", "10", "11"], tags: ["classic", "preppy", "smart casual"], gender: "unisex" },
  { name: "Platform Sandals", brand: "Birkenstock", category: "shoes", subcategory: "sandals", price: 130.00, imageUrl: "https://placehold.co/400x500?text=Platform+Sandals", colors: ["black", "taupe", "white"], sizes: ["5", "6", "7", "8", "9", "10"], tags: ["comfort", "casual", "summer"], gender: "women" },
  { name: "Running Sneaker", brand: "On", category: "shoes", subcategory: "sneakers", price: 149.99, imageUrl: "https://placehold.co/400x500?text=On+Running", colors: ["all black", "white/grey", "navy"], sizes: ["7", "8", "9", "10", "11", "12"], tags: ["performance", "athleisure", "comfort"], gender: "unisex" },
  { name: "Suede Desert Boot", brand: "Clarks", category: "shoes", subcategory: "boots", price: 120.00, imageUrl: "https://placehold.co/400x500?text=Desert+Boot", colors: ["sand", "beeswax", "black"], sizes: ["7", "8", "9", "10", "11", "12"], tags: ["heritage", "suede", "versatile"], gender: "men" },
  { name: "Mesh Ballet Flat", brand: "Alaïa", category: "shoes", subcategory: "flats", price: 490.00, imageUrl: "https://placehold.co/400x500?text=Ballet+Flat", colors: ["black", "nude", "white"], sizes: ["5", "6", "7", "8", "9"], tags: ["luxury", "trending", "elegant"], gender: "women" },

  // ── Accessories ────────────────────────────────────────
  { name: "Canvas Tote Bag", brand: "L.L.Bean", category: "accessories", subcategory: "bags", price: 29.95, imageUrl: "https://placehold.co/400x500?text=Canvas+Tote", colors: ["natural/navy", "natural/red", "black"], sizes: ["one size"], tags: ["everyday", "durable", "classic"], gender: "unisex" },
  { name: "Leather Belt", brand: "Anderson's", category: "accessories", subcategory: "belts", price: 95.00, imageUrl: "https://placehold.co/400x500?text=Leather+Belt", colors: ["brown", "black", "tan"], sizes: ["30", "32", "34", "36"], tags: ["essential", "braided", "italian"], gender: "men" },
  { name: "Cashmere Beanie", brand: "Everlane", category: "accessories", subcategory: "hats", price: 35.00, imageUrl: "https://placehold.co/400x500?text=Cashmere+Beanie", colors: ["black", "grey", "camel"], sizes: ["one size"], tags: ["winter", "cozy", "minimal"], gender: "unisex" },
  { name: "Classic Aviator Sunglasses", brand: "Ray-Ban", category: "accessories", subcategory: "sunglasses", price: 163.00, imageUrl: "https://placehold.co/400x500?text=Aviators", colors: ["gold/green", "silver/grey", "black"], sizes: ["one size"], tags: ["iconic", "timeless", "uv protection"], gender: "unisex" },
  { name: "Silk Scarf", brand: "Totême", category: "accessories", subcategory: "scarves", price: 180.00, imageUrl: "https://placehold.co/400x500?text=Silk+Scarf", colors: ["cream/black", "navy/red"], sizes: ["one size"], tags: ["luxury", "versatile", "elegant"], gender: "women" },
  { name: "Minimal Crossbody Bag", brand: "Arket", category: "accessories", subcategory: "bags", price: 69.00, imageUrl: "https://placehold.co/400x500?text=Crossbody+Bag", colors: ["black", "brown", "olive"], sizes: ["one size"], tags: ["minimal", "everyday", "hands-free"], gender: "unisex" },
  { name: "Digital Watch", brand: "Casio", category: "accessories", subcategory: "watches", price: 24.99, imageUrl: "https://placehold.co/400x500?text=Casio+Watch", colors: ["silver", "gold", "black"], sizes: ["one size"], tags: ["retro", "affordable", "iconic"], gender: "unisex" },
  { name: "Pearl Stud Earrings", brand: "Mejuri", category: "accessories", subcategory: "jewelry", price: 58.00, imageUrl: "https://placehold.co/400x500?text=Pearl+Studs", colors: ["gold", "silver"], sizes: ["one size"], tags: ["delicate", "everyday", "classic"], gender: "women" },
  { name: "Leather Card Wallet", brand: "Bellroy", category: "accessories", subcategory: "wallets", price: 49.00, imageUrl: "https://placehold.co/400x500?text=Card+Wallet", colors: ["black", "tan", "navy"], sizes: ["one size"], tags: ["slim", "essential", "functional"], gender: "unisex" },
  { name: "Baseball Cap", brand: "Carhartt WIP", category: "accessories", subcategory: "hats", price: 35.00, imageUrl: "https://placehold.co/400x500?text=Baseball+Cap", colors: ["black", "navy", "hamilton brown"], sizes: ["one size"], tags: ["casual", "streetwear", "everyday"], gender: "unisex" },
];

async function main() {
  console.log("Clearing existing data...");
  await prisma.collectionItem.deleteMany();
  await prisma.collection.deleteMany();
  await prisma.swipe.deleteMany();
  await prisma.clothingItem.deleteMany();
  await prisma.user.deleteMany();

  console.log("Creating users...");
  const users = await Promise.all(
    USERS.map((u) => prisma.user.create({ data: u }))
  );
  console.log(`  Created ${users.length} users`);

  console.log("Creating clothing items...");
  const items = await Promise.all(
    ITEMS.map((item) =>
      prisma.clothingItem.create({
        data: {
          name: item.name,
          brand: item.brand,
          category: item.category,
          subcategory: item.subcategory,
          price: item.price,
          imageUrl: item.imageUrl,
          images: [item.imageUrl],
          colors: item.colors,
          sizes: item.sizes,
          tags: item.tags,
          gender: item.gender,
        },
      })
    )
  );
  console.log(`  Created ${items.length} clothing items`);

  // Sample swipes for alice — she likes streetwear/sneakers, passes on formal
  const alice = users[0]!;
  console.log("Creating sample swipes for alice...");
  const swipeData: { itemIndex: number; action: SwipeAction }[] = [
    { itemIndex: 1, action: "LIKE" },       // Oversized Graphic Tee
    { itemIndex: 4, action: "LIKE" },       // Ribbed Crop Tank
    { itemIndex: 14, action: "SUPERLIKE" }, // Cargo Joggers
    { itemIndex: 30, action: "SUPERLIKE" }, // Air Force 1
    { itemIndex: 33, action: "LIKE" },      // Samba OG
    { itemIndex: 31, action: "LIKE" },      // Chuck Taylor 70
    { itemIndex: 0, action: "LIKE" },       // Crew Neck Tee
    { itemIndex: 2, action: "PASS" },       // Oxford Shirt
    { itemIndex: 15, action: "PASS" },      // Pleated Trousers
    { itemIndex: 25, action: "PASS" },      // Wool Overcoat
    { itemIndex: 20, action: "LIKE" },      // Denim Jacket
    { itemIndex: 8, action: "LIKE" },       // Breton Stripe
    { itemIndex: 49, action: "LIKE" },      // Baseball Cap
  ];

  for (const s of swipeData) {
    await prisma.swipe.create({
      data: {
        userId: alice.id,
        itemId: items[s.itemIndex]!.id,
        action: s.action,
      },
    });
  }
  console.log(`  Created ${swipeData.length} swipes`);

  // Sample collections
  console.log("Creating sample collections...");
  const sneakerCollection = await prisma.collection.create({
    data: {
      userId: alice.id,
      name: "Sneaker Rotation",
    },
  });

  const everydayCollection = await prisma.collection.create({
    data: {
      userId: alice.id,
      name: "Everyday Essentials",
    },
  });

  await prisma.collectionItem.createMany({
    data: [
      { collectionId: sneakerCollection.id, itemId: items[30]!.id }, // Air Force 1
      { collectionId: sneakerCollection.id, itemId: items[33]!.id }, // Samba OG
      { collectionId: sneakerCollection.id, itemId: items[31]!.id }, // Chuck Taylor 70
      { collectionId: everydayCollection.id, itemId: items[0]!.id },  // Crew Neck Tee
      { collectionId: everydayCollection.id, itemId: items[14]!.id }, // Cargo Joggers
      { collectionId: everydayCollection.id, itemId: items[20]!.id }, // Denim Jacket
      { collectionId: everydayCollection.id, itemId: items[49]!.id }, // Baseball Cap
    ],
  });
  console.log("  Created 2 collections with 7 items total");

  console.log("\nSeed complete!");
  console.log(`  ${users.length} users`);
  console.log(`  ${items.length} clothing items`);
  console.log(`  ${swipeData.length} swipes`);
  console.log(`  2 collections`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
