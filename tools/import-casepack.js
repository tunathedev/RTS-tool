#!/usr/bin/env node
/* Merge case-pack (items-per-box) values into data/products.json by UPC.
 *
 *   node tools/import-casepack.js path/to/case-packs.csv
 *
 * CSV needs a UPC column and a case-pack column (header row, case-insensitive):
 *   upc  (or: ID_CONSM_UNT_CD, barcode, gtin)
 *   case_pack  (or: items_per_box, casepack, cs_pack, case_qty, pack_qty, case)
 * An optional `name` column is used as a fallback match when the UPC is blank.
 *
 * Non-destructive: only sets/clears each product's `boxQty`. Re-runnable.
 */
const fs = require('fs');
const path = require('path');

const csvPath = process.argv[2];
if (!csvPath) { console.error('Usage: node tools/import-casepack.js <file.csv>'); process.exit(1); }

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
const norm = (s) => String(s || '').replace(/\D/g, '');

const DATA = path.join(__dirname, '..', 'data', 'products.json');
const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const byUpc = new Map(), byName = new Map();
for (const cat of data.categories) for (const it of cat.items) {
  if (it.upc) byUpc.set(norm(it.upc), it);
  byName.set(it.name.trim().toLowerCase(), it);
}

const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
if (!rows.length) { console.error('Empty CSV'); process.exit(1); }
const header = rows[0].map((h) => h.trim().toLowerCase());
const col = (names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
const cUpc = col(['upc', 'id_consm_unt_cd', 'barcode', 'gtin']);
const cName = col(['name', 'dsc_item', 'description', 'product']);
const cBox = col(['case_pack', 'items_per_box', 'casepack', 'cs_pack', 'case_qty', 'pack_qty', 'case']);
if (cBox < 0) { console.error('CSV must have a case-pack column (e.g. case_pack)'); process.exit(1); }
if (cUpc < 0 && cName < 0) { console.error('CSV must have a upc or name column'); process.exit(1); }

let set = 0, cleared = 0, missed = 0;
for (const r of rows.slice(1)) {
  const upc = cUpc >= 0 ? norm(r[cUpc]) : '';
  const name = cName >= 0 ? (r[cName] || '').trim().toLowerCase() : '';
  const it = (upc && byUpc.get(upc)) || (name && byName.get(name));
  if (!it) { if (upc || name) { missed++; console.warn(`  ! no match: ${r[cUpc] || ''} ${r[cName] || ''}`.trim()); } continue; }
  const box = parseInt(r[cBox] || '', 10);
  if (Number.isFinite(box) && box > 0) { it.boxQty = box; set++; }
  else if (it.boxQty != null) { delete it.boxQty; cleared++; }
}

fs.writeFileSync(DATA, JSON.stringify(data, null, 2) + '\n');
console.log(`Case packs — set: ${set}, cleared: ${cleared}, unmatched: ${missed}`);
console.log(`Wrote ${DATA}`);
