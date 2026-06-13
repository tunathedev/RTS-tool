#!/usr/bin/env node
/* Merge a product spreadsheet (CSV) into data/products.json.
 *
 *   node tools/import-csv.js path/to/products.csv
 *
 * Expected columns (header row, case-insensitive; extra columns ignored):
 *   name        - product name (must match an existing item to merge onto it)
 *   image_url   - direct product image URL
 *   upc         - barcode digits (UPC-A / EAN-13)
 *   par_tall    - par level: how many tall
 *   par_deep    - par level: how many deep
 *   category    - optional; only used when adding a brand-new product
 *
 * Matching is by name (case-insensitive, trimmed). Unmatched rows are reported;
 * with a category they're added as new products, otherwise skipped.
 */
const fs = require('fs');
const path = require('path');

const csvPath = process.argv[2];
if (!csvPath) { console.error('Usage: node tools/import-csv.js <file.csv>'); process.exit(1); }

const DATA = path.join(__dirname, '..', 'data', 'products.json');
const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));

/* --- tiny CSV parser (handles quoted fields with commas/newlines) --- */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
if (!rows.length) { console.error('Empty CSV'); process.exit(1); }
const header = rows[0].map((h) => h.trim().toLowerCase());
const col = (names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
const ci = {
  name: col(['name', 'product', 'product name']),
  image: col(['image_url', 'image', 'imageurl', 'image url']),
  upc: col(['upc', 'barcode', 'gtin']),
  tall: col(['par_tall', 'tall', 'high']),
  deep: col(['par_deep', 'deep', 'depth']),
  category: col(['category', 'cat']),
};
if (ci.name < 0) { console.error('CSV must have a "name" column'); process.exit(1); }

// index existing products by normalized name
const byName = new Map();
for (const cat of data.categories) for (const it of cat.items) byName.set(it.name.trim().toLowerCase(), { it, cat });
const catByName = new Map(data.categories.map((c) => [c.category.toLowerCase(), c]));

let merged = 0, added = 0, skipped = 0;
const num = (v) => { const n = parseInt(String(v).replace(/\D/g, ''), 10); return Number.isFinite(n) ? n : 0; };

for (const r of rows.slice(1)) {
  const name = (r[ci.name] || '').trim();
  if (!name) continue;
  const image = ci.image >= 0 ? (r[ci.image] || '').trim() : '';
  const upc = ci.upc >= 0 ? (r[ci.upc] || '').trim() : '';
  const tall = ci.tall >= 0 ? num(r[ci.tall]) : 0;
  const deep = ci.deep >= 0 ? num(r[ci.deep]) : 0;

  const apply = (it) => {
    if (image) it.image = image;
    if (upc) it.upc = upc.replace(/\D/g, '');
    if (tall || deep) it.par = { tall: tall || 1, deep: deep || 1 };
  };

  const hit = byName.get(name.toLowerCase());
  if (hit) { apply(hit.it); merged++; continue; }

  const catName = ci.category >= 0 ? (r[ci.category] || '').trim() : '';
  if (catName) {
    let cat = catByName.get(catName.toLowerCase());
    if (!cat) { cat = { category: catName, items: [] }; data.categories.push(cat); catByName.set(catName.toLowerCase(), cat); }
    const it = { name, days: null, pkgDate: true };
    apply(it);
    cat.items.push(it);
    byName.set(name.toLowerCase(), { it, cat });
    added++;
  } else {
    console.warn(`  ! No match (and no category) for: ${name}`);
    skipped++;
  }
}

fs.writeFileSync(DATA, JSON.stringify(data, null, 2) + '\n');
console.log(`Done. merged=${merged} added=${added} skipped=${skipped}`);
console.log(`Wrote ${DATA}`);
