/* RTS Sell-By + Pull List
 * - Mobile-first calculator for Ready-to-Eat shelf life
 * - Sell-by = pull date (from freezer) + shelf-life days, shown as MM/DD/YYYY
 * - Morning "pull list": tap items you need to pull, see each sell-by date,
 *   check them off, and copy/share the list. Persists in localStorage.
 * - HEB.com product images via the local proxy (server.js) with a fallback link.
 */

const HEB_SEARCH = (q) => `https://www.heb.com/search?q=${encodeURIComponent(q)}`;
const LS_KEY = 'rts.pullList.v1';

const state = {
  data: null,
  items: [],          // flattened {name, days, pkgDate, category, image?, upc?, par?}
  byName: new Map(),
  byUpc: new Map(),   // normalized UPC -> product
  current: null,      // product open in the sheet
  pull: [],           // [{name, qty, done}]
  overrides: {},
  imgCache: new Map(),
  scan: { controls: null, active: false },
};

const $ = (id) => document.getElementById(id);

/* ---------------- init ---------------- */
async function init() {
  try {
    state.data = await (await fetch('data/products.json')).json();
  } catch {
    $('productList').innerHTML =
      `<div class="no-results">Could not load products.json.<br>Run via a local server (see README).</div>`;
    return;
  }
  try {
    const ov = await fetch('data/heb-overrides.json');
    if (ov.ok) state.overrides = await ov.json();
  } catch {}

  flatten();
  loadPullList();
  buildCategoryFilter();
  renderHeader();
  setToday();
  renderList();
  renderPullList();
  wireEvents();
  loadWeather();
}

function flatten() {
  for (const cat of state.data.categories) {
    for (const it of cat.items) {
      const obj = { ...it, category: cat.category };
      state.items.push(obj);
      state.byName.set(it.name, obj);
      if (obj.upc) state.byUpc.set(normUpc(obj.upc), obj);
    }
  }
}

// Normalize a UPC/EAN to digits only (drops spaces, dashes, leading zero noise kept).
function normUpc(code) { return String(code).replace(/\D/g, ''); }

function renderHeader() {
  const d = state.data.lastUpdated;
  if (d) {
    const dt = parseISO(d);
    $('lastUpdated').textContent = 'Sheet updated ' + fmtDate(dt);
  }
  $('footerCount').textContent = `${state.items.length} items · ${state.data.categories.length} categories`;
}

function buildCategoryFilter() {
  const sel = $('categoryFilter');
  for (const cat of state.data.categories) {
    const o = document.createElement('option');
    o.value = cat.category; o.textContent = cat.category;
    sel.appendChild(o);
  }
}

/* ---------------- Browse list ---------------- */
function renderList() {
  const term = $('search').value.trim().toLowerCase();
  const catFilter = $('categoryFilter').value;
  const list = $('productList');
  list.innerHTML = '';
  let shown = 0, lastCat = null;

  for (const it of state.items) {
    if (catFilter && it.category !== catFilter) continue;
    if (term && !matches(it, term)) continue;

    if (it.category !== lastCat) {
      const h = document.createElement('div');
      h.className = 'cat-header'; h.textContent = it.category;
      list.appendChild(h); lastCat = it.category;
    }

    const row = document.createElement('div');
    row.className = 'product-item';

    const tap = document.createElement('div');
    tap.className = 'tap';
    tap.innerHTML =
      `<div class="name">${escapeHtml(it.name)}</div>
       <div class="meta">${it.pkgDate ? 'Follow package date' : 'Sell by ' + fmtDate(sellByFor(it))}</div>`;
    tap.addEventListener('click', () => openSheet(it));

    const badge = document.createElement('span');
    badge.className = 'badge' + (it.pkgDate ? ' pkg' : '');
    badge.textContent = it.pkgDate ? 'Pkg date' : it.days + 'd';

    const add = document.createElement('button');
    add.className = 'add-btn' + (inList(it.name) ? ' in' : '');
    add.textContent = inList(it.name) ? '✓' : '＋';
    add.setAttribute('aria-label', inList(it.name) ? 'Remove from pull list' : 'Add to pull list');
    add.addEventListener('click', (e) => { e.stopPropagation(); toggleList(it.name); });

    row.append(tap, badge, add);
    list.appendChild(row);
    shown++;
  }

  if (shown === 0) list.innerHTML = `<div class="no-results">No products match “${escapeHtml(term)}”.</div>`;
  $('resultCount').textContent =
    `${shown} ${shown === 1 ? 'product' : 'products'}` + (catFilter ? ` in ${catFilter}` : '');
}

function matches(it, term) {
  return it.name.toLowerCase().includes(term) || it.category.toLowerCase().includes(term);
}

/* ---------------- Detail sheet ---------------- */
function openSheet(it) {
  state.current = it;
  $('detailCategory').textContent = it.category;
  $('detailName').textContent = it.name;
  $('detailShelf').innerHTML = it.pkgDate
    ? `Shelf life: <strong>Follow printed package date</strong>`
    : `Shelf life: <strong>${it.days} ${it.days === 1 ? 'day' : 'days'}</strong> from freezer pull`;
  $('hebLink').href = HEB_SEARCH(hebQuery(it.name));

  renderUpc(it);
  renderPar(it);
  renderSheetResult(it);
  updateSheetAddBtn();
  loadImage(it);

  $('sheetBackdrop').hidden = false;
  $('sheet').hidden = false;
}

function renderUpc(it) {
  $('detailUpc').innerHTML = it.upc
    ? `UPC <span class="upc-num">${escapeHtml(String(it.upc))}</span>`
    : '';
}

/* Par level — "how many tall × how many deep" with a cute icon grid. */
function renderPar(it) {
  const box = $('detailPar');
  const par = it.par;
  if (!par || !(par.tall || par.deep)) { box.innerHTML = ''; return; }
  const tall = Math.max(1, par.tall || 1);
  const deep = Math.max(1, par.deep || 1);
  const total = tall * deep;
  // Grid: `deep` columns across, `tall` rows down (capped so it stays cute).
  const cols = Math.min(deep, 8), rows = Math.min(tall, 6);
  let cells = '';
  for (let i = 0; i < cols * rows; i++) cells += '<div class="cell"></div>';
  box.innerHTML =
    `<div class="par-card">
       <div class="par-grid" style="grid-template-columns:repeat(${cols},14px)">${cells}</div>
       <div class="par-meta">
         <div class="par-title">📦 Par level</div>
         <div class="par-dim">${tall} tall × ${deep} deep</div>
         <div class="par-total">= ${total} on display</div>
       </div>
     </div>`;
}

function closeSheet() {
  $('sheet').hidden = true;
  $('sheetBackdrop').hidden = true;
  state.current = null;
}

function renderSheetResult(it) {
  const box = $('sheetResult');
  box.className = 'sheet-result';
  if (it.pkgDate) {
    box.classList.add('pkg');
    box.innerHTML =
      `<div class="sellby-label">Sell-by</div>
       <div class="sellby-date">Use package date</div>
       <div class="remaining">Not calculated — follow the date printed on the package.</div>`;
    return;
  }
  const sellBy = sellByFor(it);
  const { cls, note } = freshness(sellBy);
  box.classList.add(cls);
  box.innerHTML =
    `<div class="sellby-label">Sell-by date</div>
     <div class="sellby-date">${fmtDate(sellBy)}</div>
     <div class="remaining">${note}</div>`;
}

function updateSheetAddBtn() {
  const it = state.current; if (!it) return;
  const btn = $('sheetAddBtn');
  const inIt = inList(it.name);
  btn.textContent = inIt ? '✓ In pull list — remove' : '＋ Add to pull list';
  btn.classList.toggle('in', inIt);
}

/* ---------------- Pull list ---------------- */
function loadPullList() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    // keep only items that still exist in the dataset
    state.pull = saved.filter((p) => state.byName.has(p.name))
      .map((p) => ({ name: p.name, qty: Math.max(1, p.qty | 0 || 1), done: !!p.done }));
  } catch { state.pull = []; }
}
function savePullList() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state.pull)); } catch {}
}
function inList(name) { return state.pull.some((p) => p.name === name); }

function toggleList(name) {
  const i = state.pull.findIndex((p) => p.name === name);
  if (i >= 0) state.pull.splice(i, 1);
  else state.pull.push({ name, qty: 1, done: false });
  savePullList();
  renderList();
  renderPullList();
  updateSheetAddBtn();
}

function setQty(name, delta) {
  const p = state.pull.find((x) => x.name === name);
  if (!p) return;
  p.qty = Math.max(1, p.qty + delta);
  savePullList();
  renderPullList();
}

function toggleDone(name) {
  const p = state.pull.find((x) => x.name === name);
  if (!p) return;
  p.done = !p.done;
  savePullList();
  renderPullList();
}

function clearList() {
  if (!state.pull.length) return;
  if (!confirm('Clear the whole pull list?')) return;
  state.pull = [];
  savePullList();
  renderList();
  renderPullList();
}

function renderPullList() {
  const n = state.pull.length;
  $('listCount').textContent = n;
  $('pullListEmpty').hidden = n > 0;
  $('pullListWrap').hidden = n === 0;
  if (n === 0) return;

  const totalQty = state.pull.reduce((s, p) => s + p.qty, 0);
  const doneCount = state.pull.filter((p) => p.done).length;
  $('pullSummary').textContent =
    `${n} item${n === 1 ? '' : 's'} · ${totalQty} to pull · ${doneCount}/${n} pulled · pulled ${fmtDate(getPullDate())}`;

  // group by category, preserve dataset order
  const wrap = $('pullItems');
  wrap.innerHTML = '';
  const ordered = state.items.filter((it) => inList(it.name));
  for (const it of ordered) {
    const p = state.pull.find((x) => x.name === it.name);
    const row = document.createElement('div');
    row.className = 'pull-item' + (p.done ? ' done' : '');

    const sell = it.pkgDate
      ? `<span class="pull-sellby pkg">Pkg date</span>`
      : (() => { const sb = sellByFor(it); const { cls } = freshness(sb);
                 return `<span class="pull-sellby ${cls}">${fmtDate(sb)}</span>`; })();

    row.innerHTML = `
      <input type="checkbox" class="pull-check" ${p.done ? 'checked' : ''} aria-label="Mark pulled" />
      <div class="pull-main">
        <div class="pull-name">${escapeHtml(it.name)}</div>
        <div class="pull-sub">${escapeHtml(it.category)} · sell by ${sell}</div>
      </div>
      <div class="qty">
        <button type="button" data-act="dec" aria-label="Decrease quantity">−</button>
        <span>${p.qty}</span>
        <button type="button" data-act="inc" aria-label="Increase quantity">+</button>
      </div>
      <button type="button" class="remove-btn" aria-label="Remove">🗑️</button>`;

    row.querySelector('.pull-check').addEventListener('change', () => toggleDone(it.name));
    row.querySelector('[data-act="dec"]').addEventListener('click', () => setQty(it.name, -1));
    row.querySelector('[data-act="inc"]').addEventListener('click', () => setQty(it.name, +1));
    row.querySelector('.remove-btn').addEventListener('click', () => toggleList(it.name));
    wrap.appendChild(row);
  }
}

function pullListText() {
  const lines = [`Pull List — pulled ${fmtDate(getPullDate())}`];
  const ordered = state.items.filter((it) => inList(it.name));
  for (const it of ordered) {
    const p = state.pull.find((x) => x.name === it.name);
    const sb = it.pkgDate ? 'pkg date' : 'sell by ' + fmtDate(sellByFor(it));
    lines.push(`[${p.done ? 'x' : ' '}] ${p.qty}x ${it.name} — ${sb}`);
  }
  return lines.join('\n');
}

async function copyOrShare() {
  const text = pullListText();
  try {
    if (navigator.share) { await navigator.share({ title: 'Pull List', text }); return; }
  } catch {}
  try {
    await navigator.clipboard.writeText(text);
    flashBtn($('copyBtn'), '✓ Copied');
  } catch {
    // last-resort fallback
    prompt('Copy your pull list:', text);
  }
}

function flashBtn(btn, msg) {
  const old = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = old; }, 1500);
}

/* ---------------- date + freshness ---------------- */
function getPullDate() { return parseISO($('pullDate').value) || stripTime(new Date()); }
function sellByFor(it) { return it.pkgDate ? null : addDays(getPullDate(), it.days); }

function freshness(sellBy) {
  const today = stripTime(new Date());
  const daysLeft = Math.round((sellBy - today) / 86400000);
  if (daysLeft < 0) return { cls: 'bad', note: `Expired ${Math.abs(daysLeft)} day(s) ago — pull from sale.` };
  if (daysLeft === 0) return { cls: 'bad', note: `Sells by end of today.` };
  if (daysLeft <= 2) return { cls: 'warn', note: `${daysLeft} day(s) left — sell or mark down soon.` };
  return { cls: 'ok', note: `${daysLeft} days left.` };
}

function onPullDateChange() {
  renderList();
  renderPullList();
  if (state.current) renderSheetResult(state.current);
}

function setToday() { $('pullDate').value = toISO(new Date()); onPullDateChange(); }

/* ---------------- Weather (San Antonio 78252) ----------------
 * Three 3-hour blocks for the next 9 hours, to anticipate demand.
 * Open-Meteo: free, no API key, CORS-enabled (works on GitHub Pages). */
const WX = { lat: 29.356, lon: -98.697, tz: 'America/Chicago', label: 'San Antonio · 78252' };

// WMO weather codes → emoji + short label.
const WMO = {
  0: ['☀️', 'Clear'], 1: ['🌤️', 'Mostly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Cloudy'],
  45: ['🌫️', 'Fog'], 48: ['🌫️', 'Icy fog'],
  51: ['🌦️', 'Lt drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌦️', 'Hvy drizzle'],
  56: ['🌧️', 'Frz drizzle'], 57: ['🌧️', 'Frz drizzle'],
  61: ['🌧️', 'Lt rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Hvy rain'],
  66: ['🌧️', 'Frz rain'], 67: ['🌧️', 'Frz rain'],
  71: ['🌨️', 'Lt snow'], 73: ['🌨️', 'Snow'], 75: ['🌨️', 'Hvy snow'], 77: ['🌨️', 'Snow'],
  80: ['🌦️', 'Showers'], 81: ['🌦️', 'Showers'], 82: ['⛈️', 'Hvy showers'],
  85: ['🌨️', 'Snow showers'], 86: ['🌨️', 'Snow showers'],
  95: ['⛈️', 'T-storms'], 96: ['⛈️', 'T-storms'], 99: ['⛈️', 'Hail storms'],
};
const wmo = (code) => WMO[code] || ['🌡️', '—'];

async function loadWeather() {
  const box = $('wxBullets');
  box.innerHTML = `<div class="wx-msg">Loading weather…</div>`;
  $('wxTip').innerHTML = '';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${WX.lat}&longitude=${WX.lon}`
    + `&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m`
    + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=${encodeURIComponent(WX.tz)}`
    + `&forecast_days=2&timeformat=unixtime`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    renderWeather(data.hourly);
  } catch {
    box.innerHTML = `<div class="wx-err">Weather unavailable right now. Tap ↻ to retry.</div>`;
  }
}

function renderWeather(h) {
  if (!h || !Array.isArray(h.time)) {
    $('wxBullets').innerHTML = `<div class="wx-err">Weather unavailable right now.</div>`;
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  let start = h.time.findIndex((t) => t >= now);
  if (start < 0) start = 0;

  const blocks = [];
  for (let b = 0; b < 3; b++) {
    const idx = [];
    for (let k = 0; k < 3; k++) {
      const i = start + b * 3 + k;
      if (i < h.time.length) idx.push(i);
    }
    if (!idx.length) break;
    const temps = idx.map((i) => h.temperature_2m[i]);
    const pops = idx.map((i) => h.precipitation_probability[i] ?? 0);
    const winds = idx.map((i) => h.wind_speed_10m[i] ?? 0);
    const code = Math.max(...idx.map((i) => h.weather_code[i] ?? 0));
    blocks.push({
      startSec: h.time[idx[0]],
      endSec: h.time[idx[idx.length - 1]] + 3600,
      tMin: Math.round(Math.min(...temps)),
      tMax: Math.round(Math.max(...temps)),
      pop: Math.max(...pops),
      wind: Math.round(Math.max(...winds)),
      code,
    });
  }

  $('wxBullets').innerHTML = blocks.map((b) => {
    const [emoji, label] = wmo(b.code);
    const temp = b.tMin === b.tMax ? `${b.tMax}°` : `${b.tMin}–${b.tMax}°`;
    return `<div class="wx-bullet">
      <div class="wx-emoji">${emoji}</div>
      <div class="wx-when">${blockLabel(b.startSec, b.endSec)}</div>
      <div class="wx-temp">${temp}</div>
      <div class="wx-cond">${escapeHtml(label)}<br><span class="wx-rain">${b.pop}%</span> · ${b.wind}mph</div>
    </div>`;
  }).join('');

  $('wxTip').innerHTML = sellTip(blocks);
}

function blockLabel(startSec, endSec) {
  const a = hourParts(startSec), b = hourParts(endSec);
  return a.ap === b.ap ? `${a.h}–${b.h} ${b.ap}` : `${a.h} ${a.ap}–${b.h} ${b.ap}`;
}
function hourParts(sec) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: WX.tz, hour: 'numeric', hour12: true })
    .formatToParts(new Date(sec * 1000));
  return {
    h: parts.find((p) => p.type === 'hour').value,
    ap: (parts.find((p) => p.type === 'dayPeriod') || {}).value || '',
  };
}

/* A bakery-oriented demand hint based on the next 9 hours. */
function sellTip(blocks) {
  if (!blocks.length) return '';
  const maxTemp = Math.max(...blocks.map((b) => b.tMax));
  const maxPop = Math.max(...blocks.map((b) => b.pop));
  let tip;
  if (maxPop >= 50) tip = 'Rain likely — lean into grab-and-go comfort (coffee cakes, pies, breads, pretzels) and coffee pairings.';
  else if (maxTemp >= 90) tip = 'Hot &amp; dry — push lighter/chilled sellers (ice cream cakes, two-bite items, lighter pastries); heavy breads may slow.';
  else if (maxTemp <= 50) tip = 'Cold — comfort bakes move well (cinnamon rolls, babka, pies, stollen) plus hot-drink pairings.';
  else tip = 'Mild — steady demand; feature seasonal favorites and fresh bread.';
  return `<strong>Sell tip:</strong> ${tip}`;
}

/* ---------------- UPC barcode scanner ----------------
 * On-device camera scan via ZXing (loaded from CDN). Works on iOS Safari and
 * Android Chrome over HTTPS (GitHub Pages) or localhost. Scans a UPC/EAN and
 * opens the matching product card. */
const ZXING_CDN = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm';

async function openScanner() {
  const modal = $('scanModal');
  modal.hidden = false;
  setScanStatus('Starting camera…');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setScanStatus('Camera not supported on this device/browser.', 'err');
    return;
  }
  try {
    const { BrowserMultiFormatReader } = await import(ZXING_CDN);
    const reader = new BrowserMultiFormatReader();
    state.scan.active = true;
    setScanStatus('Point the camera at a UPC barcode…');
    state.scan.controls = await reader.decodeFromConstraints(
      { video: { facingMode: { ideal: 'environment' } } },
      $('scanVideo'),
      (result) => { if (result && state.scan.active) onScan(result.getText()); }
    );
  } catch (e) {
    const msg = (e && e.name === 'NotAllowedError')
      ? 'Camera permission denied. Allow camera access and try again.'
      : 'Could not start the scanner. Check your connection and camera permissions.';
    setScanStatus(msg, 'err');
  }
}

function onScan(raw) {
  const code = normUpc(raw);
  const match = state.byUpc.get(code);
  if (match) {
    setScanStatus(`✓ ${match.name}`, 'ok');
    state.scan.active = false;
    setTimeout(() => { closeScanner(); openSheet(match); }, 350);
  } else {
    // keep scanning, but report what was read
    setScanStatus(`No product matches ${code}. Keep scanning…`, 'err');
  }
}

function closeScanner() {
  state.scan.active = false;
  try { state.scan.controls && state.scan.controls.stop(); } catch {}
  state.scan.controls = null;
  const v = $('scanVideo');
  if (v && v.srcObject) { v.srcObject.getTracks().forEach((t) => t.stop()); v.srcObject = null; }
  $('scanModal').hidden = true;
}

function setScanStatus(text, cls = '') {
  const el = $('scanStatus');
  el.textContent = text;
  el.className = 'scan-status' + (cls ? ' ' + cls : '');
}

/* ---------------- HEB image ---------------- */
function hebQuery(name) {
  return name
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b\d+("|in|ct|oz|dozen|pkg)\b/gi, ' ')
    .replace(/\b(SAB|NSA|FROZEN|refrigeration|freezer)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

async function loadImage(it) {
  const wrap = $('detailImg');
  const key = it.name;
  // 0) Direct image URL from the product data (spreadsheet) wins.
  if (it.image) { showImage(it, it.image); return; }
  const pin = state.overrides[key];
  if (pin && pin.image) { showImage(it, pin.image); return; }
  if (state.imgCache.has(key)) {
    const v = state.imgCache.get(key);
    v ? showImage(it, v) : showPlaceholder();
    return;
  }
  wrap.classList.add('img-loading');
  showPlaceholder('Finding…');
  try {
    const res = await fetch('api/heb-image?q=' + encodeURIComponent(hebQuery(it.name)), { cache: 'no-store' });
    if (state.current !== it) return;
    wrap.classList.remove('img-loading');
    if (res.ok) {
      const data = await res.json();
      if (data && data.image) {
        state.imgCache.set(key, data.image);
        if (data.url) $('hebLink').href = data.url;
        showImage(it, data.image);
        return;
      }
    }
    state.imgCache.set(key, null);
    showPlaceholder();
  } catch {
    if (state.current !== it) return;
    wrap.classList.remove('img-loading');
    showPlaceholder();
  }
}
function showImage(it, src) {
  const wrap = $('detailImg');
  wrap.classList.remove('img-loading');
  wrap.innerHTML = '';
  const img = new Image();
  img.alt = it.name; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
  img.onerror = () => showPlaceholder();
  img.src = src;
  wrap.appendChild(img);
}
function showPlaceholder(text = 'No image') {
  $('detailImg').innerHTML = `<div class="img-placeholder">${escapeHtml(text)}</div>`;
}

/* ---------------- date helpers ---------------- */
function toISO(d) { const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }
function parseISO(s) { if (!s) return null; const [y, m, d] = s.split('-').map(Number); if (!y || !m || !d) return null; return new Date(y, m - 1, d); }
function stripTime(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function fmtDate(d) { const z = (n) => String(n).padStart(2, '0'); return `${z(d.getMonth() + 1)}/${z(d.getDate())}/${d.getFullYear()}`; }

/* ---------------- misc ---------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function switchTab(which) {
  const browse = which === 'browse';
  $('tabBrowse').classList.toggle('active', browse);
  $('tabList').classList.toggle('active', !browse);
  $('tabBrowse').setAttribute('aria-selected', browse);
  $('tabList').setAttribute('aria-selected', !browse);
  $('browseView').hidden = !browse;
  $('listView').hidden = browse;
}

function wireEvents() {
  $('search').addEventListener('input', renderList);
  $('categoryFilter').addEventListener('change', renderList);
  $('pullDate').addEventListener('change', onPullDateChange);
  $('todayBtn').addEventListener('click', setToday);
  $('tabBrowse').addEventListener('click', () => switchTab('browse'));
  $('tabList').addEventListener('click', () => switchTab('list'));
  $('sheetClose').addEventListener('click', closeSheet);
  $('sheetBackdrop').addEventListener('click', closeSheet);
  $('sheetAddBtn').addEventListener('click', () => { if (state.current) toggleList(state.current.name); });
  $('copyBtn').addEventListener('click', copyOrShare);
  $('clearBtn').addEventListener('click', clearList);
  $('wxRefresh').addEventListener('click', loadWeather);
  $('scanFab').addEventListener('click', openScanner);
  $('scanClose').addEventListener('click', closeScanner);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('scanModal').hidden) closeScanner();
    else if (!$('sheet').hidden) closeSheet();
  });
}

init();
