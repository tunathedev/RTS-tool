#!/usr/bin/env node
/* Write data/case-pack-worksheet.csv listing every product so you can fill in
 * the `case_pack` column as you work. Re-run anytime to refresh it (it keeps
 * any case_pack values already set on products).
 *
 *   node tools/make-casepack-worksheet.js
 *
 * Then, once filled:  node tools/import-casepack.js data/case-pack-worksheet.csv
 */
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data', 'products.json');
const OUT = path.join(__dirname, '..', 'data', 'case-pack-worksheet.csv');
const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));

const esc = (s) => { s = String(s == null ? '' : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

const lines = ['upc,name,category,shelf_life_days,case_pack'];
for (const cat of data.categories) for (const it of cat.items) {
  lines.push([
    esc(it.upc || ''),
    esc(it.name),
    esc(cat.category),
    esc(it.pkgDate ? 'pkg' : it.days),
    esc(it.boxQty || ''),
  ].join(','));
}
fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`Wrote ${OUT} (${lines.length - 1} products)`);
