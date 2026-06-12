#!/usr/bin/env node
/* RTS Sell-By Date Calculator — local server
 *
 * Two jobs:
 *   1. Serve the static app (index.html, app.js, styles.css, data/*).
 *   2. /api/heb-image?q=NAME — look up a product image on HEB.com server-side
 *      (no browser CORS limits here) and return { image, url }. Results are
 *      cached to data/image-cache.json so repeat lookups are instant.
 *
 * Zero dependencies — Node's built-in modules only.
 *   Run:  node server.js   then open  http://localhost:3000
 *
 * Note: HEB uses bot protection. If a live lookup is blocked, the API returns
 * an empty result and the app falls back to its "View on HEB.com" link, which
 * always works in a real browser. You can also pin exact images per product in
 * data/heb-overrides.json ({ "Product Name": { "image": "...", "url": "..." } }).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const CACHE_FILE = path.join(ROOT, 'data', 'image-cache.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* ---------------- image cache ---------------- */
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; }
let cacheDirty = false;
function saveCache() {
  if (!cacheDirty) return;
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); cacheDirty = false; } catch {}
}
setInterval(saveCache, 5000).unref();
process.on('exit', saveCache);

/* ---------------- HEB fetch ---------------- */
function httpsGet(targetUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('too many redirects'));
    const u = new URL(targetUrl);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/123.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, targetUrl).toString();
        return resolve(httpsGet(next, redirects + 1));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 4_000_000) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(12000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/* Pull the first plausible HEB product image + product link out of search HTML. */
function extractFromHtml(html) {
  let image = null, url = null;

  // Product image on HEB's Scene7 CDN.
  const imgMatch = html.match(/https?:\/\/images\.heb\.com\/is\/image\/HEBGrocery\/[A-Za-z0-9_\-./?&=%]+/);
  if (imgMatch) {
    image = imgMatch[0].replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
    // Normalise to a reasonably sized render.
    image = image.split('?')[0] + '?wid=400&hei=400&fmt=jpg';
  }

  // First product-detail link.
  const urlMatch = html.match(/\/product-detail\/[A-Za-z0-9\-/]+/);
  if (urlMatch) url = 'https://www.heb.com' + urlMatch[0].replace(/\\\//g, '/');

  return image ? { image, url } : null;
}

async function lookupImage(query) {
  const key = query.toLowerCase().trim();
  if (key in cache) return cache[key];

  let result = null;
  try {
    const r = await httpsGet('https://www.heb.com/search?q=' + encodeURIComponent(query));
    if (r.status === 200) result = extractFromHtml(r.body);
  } catch { /* network/bot block — fall through to null */ }

  cache[key] = result;       // cache misses too, to avoid hammering HEB
  cacheDirty = true;
  return result;
}

/* ---------------- static file serving ---------------- */
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* ---------------- request router ---------------- */
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/heb-image')) {
    const q = new URL(req.url, 'http://localhost').searchParams.get('q') || '';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!q.trim()) { res.writeHead(400).end(JSON.stringify({ error: 'missing q' })); return; }
    try {
      const result = await lookupImage(q);
      res.writeHead(200).end(JSON.stringify(result || {}));
    } catch (e) {
      res.writeHead(200).end(JSON.stringify({}));
    }
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`RTS Sell-By Calculator running →  http://localhost:${PORT}`);
});
