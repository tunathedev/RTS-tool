#!/usr/bin/env node
/* Build data/products.json from the bakery planogram CSV export.
 *
 *   node tools/import-planogram.js path/to/planogram.csv
 *
 * CSV columns used:
 *   ID_CONSM_UNT_CD  -> UPC (scannable barcode)
 *   DSC_ITEM         -> product description
 *   PROD_FCNG_QTY    -> par: wide (facings across the front)
 *   ROW_DEEP_QTY     -> par: deep (units behind)
 *   ROW_HI_QTY       -> par: tall (units high)
 *   image            -> product image URL
 *
 * Shelf life is derived by matching each item's TYPE to the RTS Shelf Life
 * Quick Sheet values (rules below). When a type isn't on the sheet, the item
 * falls back to pkgDate ("follow printed package date") — we never invent a
 * shelf-life number.
 */
const fs = require('fs');
const path = require('path');

const csvPath = process.argv[2];
if (!csvPath) { console.error('Usage: node tools/import-planogram.js <file.csv>'); process.exit(1); }

/* ---------- tiny CSV parser ---------- */
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\r') {}
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/* ---------- name cleanup ---------- */
function titleCase(s) {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}
function cleanName(desc) {
  let s = ' ' + desc.toUpperCase() + ' ';
  s = s.replace(/\s205\s/g, ' ').replace(/\sF&F\s*(LABEL|LABE)?\s/g, ' ').replace(/\*/g, ' ');
  // expansions (word-boundary-ish)
  const rep = [
    [/\bCHEESEC(A|AK|AKE)?\b/g, 'Cheesecake'], [/\bCHEESCAK\b/g, 'Cheesecake'],
    [/\bIC\s?CREAM\b/g, 'Ice Cream'], [/\bIC\s?CAKE\b/g, 'Ice Cream Cake'], [/\bICC\b/g, 'Ice Cream Cake'],
    [/\bCHOC(O|OLATE|LATE)?\b/g, 'Chocolate'], [/\bCHOCLATE\b/g, 'Chocolate'],
    [/\bMFFN\b/g, 'Muffin'], [/\bMUFFN\b/g, 'Muffin'], [/\bMUFFNS\b/g, 'Muffins'], [/\bMFFNS\b/g, 'Muffins'],
    [/\bCPCKS?\b/g, 'Cupcakes'], [/\bCC\b/g, 'Cupcakes'],
    [/\bTB\b/g, 'Two-Bite'], [/\bGF\b/g, 'Gluten-Free'], [/\bHEB\b/g, 'H-E-B'],
    [/\bBM\b/g, 'Buttercream'], [/\bCRM\b/g, 'Cream'], [/\bCREME\b/g, 'Creme'],
    [/\bS\/F\b/g, 'Sugar-Free'], [/\bSFT\b/g, 'Soft'], [/\bBKD\b/g, 'Baked'], [/\bPAK\b/g, 'Pack'],
    [/\bSTRWBRY\b/g, 'Strawberry'], [/\bSTRWBRIES\b/g, 'Strawberries'], [/\bSTRAWBRRY\b/g, 'Strawberry'],
    [/\bBLUEBRRY\b/g, 'Blueberry'], [/\bSTRSL\b/g, 'Streusel'], [/\bCKIES\b/g, 'Cookies'], [/\bCKIE\b/g, 'Cookie'],
    [/\bHAMBRGR\b/g, 'Hamburger'], [/\bHAMBRGER\b/g, 'Hamburger'], [/\bHT\s?DG\b/g, 'Hot Dog'], [/\bBUN\b/g, 'Bun'],
    [/\bMINI\b/g, 'Mini'], [/\bXMS\b/g, 'Christmas'], [/\bVAN\b/g, 'Vanilla'], [/\bCONF\b/g, 'Confetti'],
    [/\bSHRTCK\b/g, 'Shortcake'], [/\bWHT\b/g, 'White'], [/\bCRML\b/g, 'Caramel'], [/\bSEASALT\b/g, 'Sea Salt'],
  ];
  for (const [re, to] of rep) s = s.replace(re, to);
  s = s.replace(/\s+/g, ' ').trim();
  // keep size markers uppercased nicely; title-case the rest
  return titleCase(s).replace(/\bH-e-b\b/g, 'H-E-B').replace(/\bOz\b/g, 'oz').replace(/(\d)In\b/g, '$1in');
}

/* ---------- shelf-life rules (first match wins) ----------
 * test: { any?:[...], all?:[...], not?:[...] } matched against UPPERCASE desc.
 * days: integer, or null = follow package date. cat: browse category. */
const D = (any, days, cat, extra = {}) => ({ any, days, cat, ...extra });
const RULES = [
  // Ice cream cakes (follow package date) — check first so "ICE CREAM CAKE"
  // is never mistaken for a "cream cake".
  D(['IC CREAM', 'IC CAKE', 'ICC', 'ICE CREAM', 'CARVEL'], null, 'Ice Cream Cakes/Cupcakes'),

  // Cheesecakes
  D(['CBC'], 3, 'Cheesecakes'),                                   // Cotton Blues slices
  { all: ['CHEESEC'], days: 7, cat: 'Cheesecakes' },              // H-E-B cheesecakes (refrigerated)
  { all: ['CHEESCAK'], days: 7, cat: 'Cheesecakes' },

  // Pies
  D(['LEMON MERINGUE'], 4, 'Pies'),
  { all: ['PECAN'], any: ['PIE'], days: 4, cat: 'Pies' },
  { all: ['PUMPKIN', 'PIE'], days: 3, cat: 'Pies' },
  D(['PUMPKIN CREAM CHEESE'], 3, 'Pies'),
  D(['APPLE CARAMEL CRUMB'], 5, 'Pies'),
  D(['SWEET POTATO'], 3, 'Pies'),
  { all: ['KENNYS'], any: ['PIE'], days: 10, cat: 'Pies' },       // Kenny's mini pies

  // Donuts / Danish
  D(['GLAZED DONUT'], 2, 'Danish/Donuts/Eclairs'),
  D(['DONUT HOLE'], 5, 'Danish/Donuts/Eclairs'),
  { all: ['DONUT'], days: null, cat: 'Danish/Donuts/Eclairs' },   // two-bite mini donuts -> pkg
  D(['DANISH'], 7, 'Danish/Donuts/Eclairs'),
  D(['ECLAIR'], null, 'Danish/Donuts/Eclairs'),

  // Bread / Buns
  D(['CHALLAH'], 5, 'Bread/Buns'),
  D(['ALOHA'], 14, 'Bread/Buns'),
  { all: ['BRIOCHE'], any: ['BUN', 'HAMBURG', 'HAMBRGR', 'HT DG', 'HOT DOG'], days: 14, cat: 'Bread/Buns' },
  { all: ['BRIOCHE'], any: ['LEMON', 'BLUEBERRY', 'CINNAMON', 'AVOCADO', 'JALAPENO', 'CHEDDAR'], days: 14, cat: 'Bread/Buns' },
  { all: ['BRIOCHE'], days: 7, cat: 'Bread/Buns' },               // plain/butter/sliced brioche
  D(['CRISTAL'], 5, 'Bread/Buns'),
  D(['IZZIO', 'CIABATTA', 'FOCACCIA', 'BATARD', 'SOURDOUGH', 'TAKE & BAKE', 'TAKE AND BAKE'], 10, 'Bread/Buns'),
  D(['HOT CROSS BUN'], 7, 'Bread/Buns'),
  D(['PRETZILLA'], 10, 'Bread/Buns'),
  { all: ['PRETZEL'], any: ['BITE'], days: 10, cat: 'Bread/Buns' },
  D(['PRETZEL'], 4, 'Bread/Buns'),
  { all: ['GENIUS'], days: 10, cat: 'Gluten Free Items' },
  { all: ['GLUTEN-FREE'], any: ['BREAD'], days: 10, cat: 'Gluten Free Items' },

  // Babka / Biscotti / Bunuelo / Granola
  D(['BABKA'], 21, 'Babka'),
  D(['BISCOTTI', 'BISCOTTINI'], null, 'Biscotti'),
  D(['BUNUELO', 'PAN DE POLVO'], 30, 'Bunuelo'),
  D(['GRANOLA'], 30, 'Granola'),

  // Cookies
  { all: ['18CT'], days: 7, cat: 'Cookies' },                    // HEB 18-count cookie packs
  D(['SNICKERDOODLE', 'CHEWIES', 'GINGER'], 10, 'Cookies'),
  D(['MADELEINE'], 30, 'Cookies'),
  { all: ['BROOKIE'], days: 12, cat: 'Cookies' },
  { any: ['S/F', 'SUGAR FREE', 'SUGAR-FREE'], all: [], days: null, cat: 'Sugar Free', _sf: true },
  { any: ['FROSTED', 'FROSTD'], all: [], any2: ['COOKIE'], days: 28, cat: 'Cookies' },
  { any: ['COOKIE'], all: [], any2: ['CHRISTMAS', 'EASTER', 'HALLOWEEN', 'HEART', 'BUNNY', 'PUMPK', 'BELLS', 'TREES', 'VALENTINE', 'STARS', 'SMOOCHIES'], days: 28, cat: 'Cookies', _seasonal: true },
  D(['SMOOCHIES'], 28, 'Cookies'),
  { any: ['SNACK PACK', 'SNACK PAK'], all: [], days: 30, cat: 'Two Bite Items', _snackBrownie: true }, // brownies snack pack 30 handled below
  { all: ['ALYSSA'], days: null, cat: 'Cookies' },
  { all: ['DO BITES'], days: 30, cat: 'Cookies' },
  { any: ['SNACK PACK', 'SNACK PAK'], all: [], not: ['BROWNIE'], days: 7, cat: 'Cookies' }, // HEB cookie snack packs
  { all: ['COOKIE'], any: ['CANDY', 'CHUNK'], days: 21, cat: 'Cookies' },
  { all: ['COOKIES'], days: 21, cat: 'Cookies' },

  // Macarons (French) — not on the sheet → pkg date; coconut "macaroon" = 21
  D(['MACAROON'], 21, 'Two Bite Items'),
  D(['MACARON'], null, 'Macarons'),

  // Cupcakes
  { all: ['MINI'], any: ['CUPCAKE', 'CPCK', 'CC '], days: 7, cat: 'Cupcakes' },
  { all: ['GLUTEN-FREE'], any: ['CUPCAKE'], days: 7, cat: 'Cupcakes' },
  { all: ['CUPCAKE'], days: 7, cat: 'Cupcakes' },

  // Muffins
  { any: ["ABE'S", 'ABES'], all: [], days: 7, cat: 'Gluten Free Items' },
  { all: ['MINI'], any: ['MUFFIN', 'MUFFN', 'MFFN'], days: 5, cat: 'Mini Muffins' },
  { any: ['MUFFIN', 'MUFFN', 'MFFN'], all: [], days: 5, cat: 'Muffins' },

  // Cakes
  { any: ['CREME CAKE', 'CREAM CAKE', 'CRME CK', 'CRME CAKE'], all: [], days: 6, cat: 'Cakes' },
  { all: ['36OZ'], any: ['CREME', 'CREAM'], days: 6, cat: 'Cakes' },
  D(['HONEY BUN CAKE', 'HONEY CAKE'], 14, 'Cakes'),
  D(['RING CAKE', 'BUNDT', 'BIG RED'], 10, 'Cakes'),
  { all: ['ANGEL FOOD'], days: 14, cat: 'Cakes' },
  D(['DESSERT SHELL'], 14, 'Cakes'),
  D(['GUZEL'], 14, 'Cakes'),
  { all: ['GC '], days: 14, cat: 'Cakes' },                        // Guzel Cakes export prefix
  { all: ['LOAF', 'SLICED'], days: 6, cat: 'Cakes' },
  D(['CAKE POP'], 14, 'Cakes'),
  { any: ['TIRAMISU BOWL', 'LEMONCELLO BOWL', 'LIMONCELLO BOWL'], all: [], days: 7, cat: 'Cakes' },
  { any: ['COFFEECAKE', 'COFECKE', 'COFFEE CAKE'], all: [], days: 7, cat: 'Cakes' },

  // Scones / Two-bite / Brownies
  D(['SCONE'], 10, 'Two Bite Items'),
  { all: ['BROWNIE'], any: ['SNACK PACK', 'SNACK PAK'], days: 30, cat: 'Two Bite Items' },
  { all: ['GLUTEN-FREE', 'BROWNIE'], days: 14, cat: 'Gluten Free Items' },
  { any: ['BROWNIE BITE', 'TWO-BITE BROWNIE', 'TB BROWNIE'], all: [], days: 21, cat: 'Two Bite Items' },
  { all: ['BROWNIE'], days: 21, cat: 'Two Bite Items' },
  { all: ['CINNAMON ROLL'], days: 14, cat: 'Two Bite Items' },

  // Stollen / panettone / fruit cake / rosca
  D(['STOLLEN'], 60, 'Stollen/Panettone'),
  D(['PANETTONE'], null, 'Stollen/Panettone'),
  D(['FRUIT CAKE', 'FRUITCAKE'], 90, 'Fruit Cakes'),
  D(['ROSCA'], 6, 'Rosca de Reyes'),

  // Candy / stuffing / decorated
  D(['PALMER'], 180, 'Candy'),
  D(['STUFFING'], null, 'Stuffing Mix'),
  { any: ['BIRTHDAY', '1/4 SHEET', 'RECEPTION', 'FLOWER POWER', 'VINTAGE BOWS', 'CANDLES'], all: [], days: null, cat: 'Decorated Cakes' },
];

function pick(descU) {
  for (const r of RULES) {
    const all = (r.all || []).every((k) => descU.includes(k));
    const any = !r.any || r.any.length === 0 || r.any.some((k) => descU.includes(k));
    const any2 = !r.any2 || r.any2.some((k) => descU.includes(k));
    const no = !r.not || !r.not.some((k) => descU.includes(k));
    if (all && any && any2 && no) {
      // sugar-free sub-typing
      if (r._sf) {
        if (descU.includes('ANGEL')) return { days: 30, cat: 'Sugar Free' };
        if (descU.includes('LEMON')) return { days: 7, cat: 'Sugar Free' };
        if (descU.includes('MERINGUE')) return { days: 5, cat: 'Sugar Free' };
        return { days: null, cat: 'Sugar Free' };
      }
      if (r._snackBrownie && !descU.includes('BROWNIE')) continue; // only brownies snack pack -> 30
      return { days: r.days, cat: r.cat };
    }
  }
  return null;
}

function fallbackCat(descU) {
  if (descU.includes('CHEESECAK') || descU.includes('CHEESEC')) return 'Cheesecakes';
  if (descU.includes('PIE')) return 'Pies';
  if (descU.includes('COOKIE')) return 'Cookies';
  if (descU.includes('MACARON')) return 'Macarons';
  if (descU.includes('MUFFIN') || descU.includes('MUFFN') || descU.includes('MFFN')) return 'Muffins';
  if (descU.includes('CUPCAKE') || descU.includes('CPCK')) return 'Cupcakes';
  if (descU.includes('BREAD') || descU.includes('BUN') || descU.includes('BRIOCHE') || descU.includes('BATARD')) return 'Bread/Buns';
  if (descU.includes('DONUT')) return 'Danish/Donuts/Eclairs';
  if (descU.includes('CAKE')) return 'Cakes';
  return 'Other';
}

/* ---------- build ---------- */
const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
const header = rows[0];
const idx = (name) => header.indexOf(name);
const cUpc = idx('ID_CONSM_UNT_CD'), cDsc = idx('DSC_ITEM'),
  cFac = idx('PROD_FCNG_QTY'), cDeep = idx('ROW_DEEP_QTY'), cHi = idx('ROW_HI_QTY'), cImg = idx('image');

const byUpc = new Map();
for (const r of rows.slice(1)) {
  const upc = (r[cUpc] || '').trim();
  if (!upc) continue;
  const wide = parseInt(r[cFac] || '0', 10) || 0;
  const deep = parseInt(r[cDeep] || '0', 10) || 0;
  const tall = parseInt(r[cHi] || '0', 10) || 0;
  const score = wide * deep * tall;
  const rec = { upc, desc: (r[cDsc] || '').trim(), wide, deep, tall, score, image: (r[cImg] || '').trim() };
  const prev = byUpc.get(upc);
  if (!prev || score > prev.score) byUpc.set(upc, rec); // keep the largest placement
}

const cats = new Map();
let withDays = 0, pkg = 0;
const review = [];
for (const rec of byUpc.values()) {
  // strip dept/label noise so it can't create false keyword hits (e.g. "LABEL" -> "ABE")
  const raw = (' ' + rec.desc.toUpperCase() + ' ')
    .replace(/\s205\s/g, ' ').replace(/F&F/g, ' ').replace(/\bLABEL?\b/g, ' ')
    .replace(/\*/g, ' ').replace(/\s+/g, ' ').trim();
  // match against both the raw abbreviations and the expanded/cleaned name
  const descU = raw + ' || ' + cleanName(rec.desc).toUpperCase();
  const m = pick(descU);
  const days = m ? m.days : null;
  const category = m ? m.cat : fallbackCat(descU);
  if (days != null) withDays++; else pkg++;
  const item = {
    name: cleanName(rec.desc),
    days: days,
    pkgDate: days == null,
    upc: rec.upc,
    image: rec.image || undefined,
  };
  if (rec.tall || rec.wide || rec.deep) item.par = { tall: rec.tall, wide: rec.wide, deep: rec.deep };
  if (!cats.has(category)) cats.set(category, []);
  cats.get(category).push(item);
  review.push(`${days == null ? 'PKG' : String(days).padStart(3)}  ${item.name}  [${category}]`);
}

// stable category order
const ORDER = ['Bread/Buns', 'Babka', 'Biscotti', 'Bunuelo', 'Cakes', 'Decorated Cakes', 'Candy',
  'Cheesecakes', 'Cookies', 'Macarons', 'Cupcakes', 'Danish/Donuts/Eclairs', 'Muffins', 'Mini Muffins',
  'Gluten Free Items', 'Granola', 'Ice Cream Cakes/Cupcakes', 'Pies', 'Scones', 'Two Bite Items',
  'Sugar Free', 'Stollen/Panettone', 'Fruit Cakes', 'Rosca de Reyes', 'Other'];
const categories = [];
const seen = new Set();
for (const name of ORDER) if (cats.has(name)) { categories.push({ category: name, items: sortItems(cats.get(name)) }); seen.add(name); }
for (const [name, items] of cats) if (!seen.has(name)) categories.push({ category: name, items: sortItems(items) });
function sortItems(a) { return a.sort((x, y) => x.name.localeCompare(y.name)); }

const out = {
  title: 'RTS Shelf Life Quick Sheet',
  source: 'READY TO EAT ITEM SHELF LIFE DATES',
  note: 'ALL RTE ITEMS MUST BE DATED IMMEDIATELY once taken out of the freezer',
  lastUpdated: '2026-03-31',
  categories,
};
const DATA = path.join(__dirname, '..', 'data', 'products.json');
fs.writeFileSync(DATA, JSON.stringify(out, null, 2) + '\n');

const total = withDays + pkg;
console.log(`Products: ${total}  (numeric shelf life: ${withDays}, follow package date: ${pkg})`);
console.log(`Categories: ${categories.length}`);
console.log(`Wrote ${DATA}`);
if (process.env.REVIEW) review.sort().forEach((l) => console.log('  ' + l));
