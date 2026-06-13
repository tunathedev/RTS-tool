#!/usr/bin/env node
/* Best-effort HEB search scraper — run on YOUR network (HEB is reachable there).
 *
 *   node tools/scrape-heb.js "platters bakery"
 *
 * Writes data/heb-scrape.csv (name,upc,image,url) from the search results, and
 * prints them. Use the rows to add products in the app (or hand them to me).
 *
 * Heads-up: HEB's site is bot-protected and largely client-rendered, so this
 * may return nothing even from a real network. If it does, just copy the
 * product names off the HEB search page in your browser instead — that always
 * works — and paste them to me.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const query = process.argv.slice(2).join(' ') || 'platters bakery';

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const u = new URL(url);
    https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/123.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'identity',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject).end();
  });
}

// Pull product-ish objects (name + image/id) out of any embedded JSON or HTML.
function extract(html) {
  const out = new Map();
  // Scene7 product images: .../HEBGrocery/<id>
  const imgRe = /images\.heb\.com\/is\/image\/HEBGrocery\/0*([0-9]{4,})/g;
  let m;
  while ((m = imgRe.exec(html))) {
    const id = m[1];
    out.set(id, out.get(id) || { id, image: `https://images.heb.com/is/image/HEBGrocery/${m[0].split('/').pop()}`, name: '' });
  }
  // Try to attach names from JSON like "productId":"123","displayName":"..."
  const nameRe = /"(?:displayName|productName|name)"\s*:\s*"([^"]{3,80})"[^}]{0,200}?"(?:productId|id|sku)"\s*:\s*"?0*([0-9]{4,})/gi;
  while ((m = nameRe.exec(html))) {
    const id = m[2];
    if (out.has(id)) out.get(id).name = m[1];
    else out.set(id, { id, name: m[1], image: `https://images.heb.com/is/image/HEBGrocery/${id.padStart(9, '0')}` });
  }
  return [...out.values()];
}

(async () => {
  const url = 'https://www.heb.com/search?q=' + encodeURIComponent(query);
  console.log('Fetching', url);
  let r;
  try { r = await get(url); } catch (e) { console.error('Network error:', e.message); process.exit(1); }
  console.log('HTTP', r.status, '· bytes', r.body.length);
  if (r.status !== 200) { console.error('Blocked or no results (bot protection?). Copy names from your browser instead.'); process.exit(1); }
  const items = extract(r.body);
  if (!items.length) { console.error('No products found in the HTML (likely client-rendered). Copy names from your browser instead.'); process.exit(1); }
  const esc = (s) => /[",\n]/.test(s || '') ? '"' + String(s).replace(/"/g, '""') + '"' : (s || '');
  const lines = ['name,upc,image,url'];
  for (const it of items) lines.push([esc(it.name), '', esc(it.image), ''].join(','));
  const OUT = path.join(__dirname, '..', 'data', 'heb-scrape.csv');
  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  console.log(`Found ${items.length} candidates → ${OUT}`);
  items.forEach((it) => console.log(' -', it.name || '(no name)', it.image));
})();
