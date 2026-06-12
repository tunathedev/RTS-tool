/* RTS Sell-By Date Calculator
 * - Loads the shelf-life dataset (data/products.json)
 * - Calculates sell-by dates from the date an item is pulled from the freezer
 * - Pulls product images from HEB.com (via the local image proxy in server.js,
 *   with a graceful fallback to an "View on HEB.com" search link)
 */

const HEB_SEARCH = (q) => `https://www.heb.com/search?q=${encodeURIComponent(q)}`;

const state = {
  data: null,
  items: [],          // flattened {name, days, pkgDate, category}
  selected: null,
  overrides: {},      // optional name -> {image, url} pins (data/heb-overrides.json)
  imgCache: new Map(),
};

const $ = (id) => document.getElementById(id);

/* ---------------- Data loading ---------------- */
async function init() {
  try {
    const res = await fetch('data/products.json');
    state.data = await res.json();
  } catch (e) {
    $('productList').innerHTML =
      `<div class="no-results">Could not load products.json.<br>Run via a local server (see README).</div>`;
    return;
  }

  // Optional manual image pins. Absent file is fine.
  try {
    const ov = await fetch('data/heb-overrides.json');
    if (ov.ok) state.overrides = await ov.json();
  } catch { /* optional */ }

  flatten();
  buildCategoryFilter();
  renderHeader();
  renderList();
  wireEvents();
  setToday();
}

function flatten() {
  state.items = [];
  for (const cat of state.data.categories) {
    for (const it of cat.items) {
      state.items.push({ ...it, category: cat.category });
    }
  }
}

function renderHeader() {
  const d = state.data.lastUpdated;
  if (d) {
    const dt = new Date(d + 'T00:00:00');
    $('lastUpdated').textContent =
      'Sheet updated ' + dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  $('footerCount').textContent = `${state.items.length} items · ${state.data.categories.length} categories`;
}

function buildCategoryFilter() {
  const sel = $('categoryFilter');
  for (const cat of state.data.categories) {
    const o = document.createElement('option');
    o.value = cat.category;
    o.textContent = cat.category;
    sel.appendChild(o);
  }
}

/* ---------------- List rendering ---------------- */
function renderList() {
  const term = $('search').value.trim().toLowerCase();
  const catFilter = $('categoryFilter').value;
  const list = $('productList');
  list.innerHTML = '';

  let shown = 0;
  let lastCat = null;

  for (const it of state.items) {
    if (catFilter && it.category !== catFilter) continue;
    if (term && !matches(it, term)) continue;

    if (it.category !== lastCat) {
      const h = document.createElement('div');
      h.className = 'cat-header';
      h.textContent = it.category;
      list.appendChild(h);
      lastCat = it.category;
    }

    const row = document.createElement('div');
    row.className = 'product-item' + (state.selected === it ? ' active' : '');
    row.setAttribute('role', 'option');
    row.tabIndex = 0;

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = it.name;

    const badge = document.createElement('span');
    if (it.pkgDate) {
      badge.className = 'badge pkg';
      badge.textContent = 'Pkg date';
    } else {
      badge.className = 'badge';
      badge.textContent = it.days + (it.days === 1 ? ' day' : ' days');
    }

    row.append(name, badge);
    row.addEventListener('click', () => select(it));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(it); }
    });
    list.appendChild(row);
    shown++;
  }

  if (shown === 0) {
    list.innerHTML = `<div class="no-results">No products match “${escapeHtml(term)}”.</div>`;
  }
  $('resultCount').textContent =
    `${shown} ${shown === 1 ? 'product' : 'products'}` + (catFilter ? ` in ${catFilter}` : '');
}

function matches(it, term) {
  return it.name.toLowerCase().includes(term) || it.category.toLowerCase().includes(term);
}

/* ---------------- Selection + detail ---------------- */
function select(it) {
  state.selected = it;
  renderList(); // refresh active highlight
  $('emptyState').hidden = true;
  $('detail').hidden = false;

  $('detailCategory').textContent = it.category;
  $('detailName').textContent = it.name;

  if (it.pkgDate) {
    $('detailShelf').innerHTML = `Shelf life: <strong>Follow printed package date</strong>`;
  } else {
    $('detailShelf').innerHTML =
      `Shelf life: <strong>${it.days} ${it.days === 1 ? 'day' : 'days'}</strong> from freezer pull`;
  }

  $('hebLink').href = HEB_SEARCH(hebQuery(it.name));
  loadImage(it);
  calc();
}

/* Clean a product name into a better HEB search query
 * (drop parenthetical notes, size markers, and packaging words). */
function hebQuery(name) {
  return name
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b\d+("|in|ct|oz|dozen|pkg)\b/gi, ' ')
    .replace(/\b(SAB|NSA|FROZEN|refrigeration|freezer)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------------- HEB image loading ---------------- */
async function loadImage(it) {
  const wrap = $('detailImg');
  const key = it.name;

  // 1) Manual override pin
  const pin = state.overrides[key];
  if (pin && pin.image) { showImage(pin.image); return; }

  // 2) Cached lookup
  if (state.imgCache.has(key)) {
    const v = state.imgCache.get(key);
    v ? showImage(v) : showPlaceholder();
    return;
  }

  // 3) Live lookup through the local proxy (server.js). If the app is opened
  //    as a static file with no proxy, this simply falls back to a placeholder
  //    plus the always-available "View on HEB.com" link.
  wrap.classList.add('img-loading');
  showPlaceholder('Finding image…');
  try {
    const res = await fetch('api/heb-image?q=' + encodeURIComponent(hebQuery(it.name)), { cache: 'no-store' });
    if (state.selected !== it) return; // selection changed while loading
    wrap.classList.remove('img-loading');
    if (res.ok) {
      const data = await res.json();
      if (data && data.image) {
        state.imgCache.set(key, data.image);
        if (data.url) $('hebLink').href = data.url;
        showImage(data.image);
        return;
      }
    }
    state.imgCache.set(key, null);
    showPlaceholder();
  } catch {
    if (state.selected !== it) return;
    wrap.classList.remove('img-loading');
    showPlaceholder();
  }
}

function showImage(src) {
  const wrap = $('detailImg');
  wrap.classList.remove('img-loading');
  wrap.innerHTML = '';
  const img = new Image();
  img.alt = state.selected ? state.selected.name : 'Product';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.onerror = () => showPlaceholder();
  img.src = src;
  wrap.appendChild(img);
}

function showPlaceholder(text = 'No image') {
  const wrap = $('detailImg');
  wrap.innerHTML = `<div class="img-placeholder" id="imgPlaceholder">${escapeHtml(text)}</div>`;
}

/* ---------------- Date calculation ---------------- */
function setToday() {
  const t = new Date();
  $('pullDate').value = toISO(t);
  if (state.selected) calc();
}

function calc() {
  const it = state.selected;
  if (!it) return;
  const box = $('result');
  box.className = 'result';

  if (it.pkgDate) {
    box.classList.add('pkg');
    box.innerHTML =
      `<div class="sellby-label">Sell-by</div>
       <div class="sellby-date">Use printed package date</div>
       <div class="remaining">This item is not calculated — follow the date printed on the package.</div>`;
    updatePrintLabel(it, null);
    return;
  }

  const pull = parseISO($('pullDate').value);
  if (!pull) {
    box.innerHTML = `<div class="remaining">Pick the date the item was pulled from the freezer.</div>`;
    return;
  }

  const sellBy = addDays(pull, it.days);
  const today = stripTime(new Date());
  const daysLeft = Math.round((sellBy - today) / 86400000);

  let cls = 'ok', note;
  if (daysLeft < 0) { cls = 'bad'; note = `Expired ${Math.abs(daysLeft)} day(s) ago — pull from sale.`; }
  else if (daysLeft === 0) { cls = 'bad'; note = `Sells by end of today.`; }
  else if (daysLeft <= 2) { cls = 'warn'; note = `${daysLeft} day(s) left — sell or mark down soon.`; }
  else { cls = 'ok'; note = `${daysLeft} days left.`; }

  box.classList.add(cls);
  box.innerHTML =
    `<div class="sellby-label">Sell-by date</div>
     <div class="sellby-date">${fmtLong(sellBy)}</div>
     <div class="remaining">${note}</div>`;

  updatePrintLabel(it, sellBy);
}

function updatePrintLabel(it, sellBy) {
  const pull = parseISO($('pullDate').value);
  const lines = [
    `<div class="pl-name">${escapeHtml(it.name)}</div>`,
    `<div class="pl-row">Category: ${escapeHtml(it.category)}</div>`,
    pull ? `<div class="pl-row">Pulled: ${fmtLong(pull)}</div>` : '',
  ];
  if (it.pkgDate) {
    lines.push(`<div class="pl-sellby">Use printed package date</div>`);
  } else {
    lines.push(`<div class="pl-row">Shelf life: ${it.days} day(s)</div>`);
    lines.push(`<div class="pl-sellby">SELL BY: ${sellBy ? fmtLong(sellBy) : '—'}</div>`);
  }
  $('printLabel').innerHTML = lines.join('');
}

/* ---------------- Date helpers ---------------- */
function toISO(d) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
function parseISO(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
function stripTime(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function fmtLong(d) {
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
}

/* ---------------- Misc ---------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function wireEvents() {
  $('search').addEventListener('input', renderList);
  $('categoryFilter').addEventListener('change', renderList);
  $('pullDate').addEventListener('change', calc);
  $('todayBtn').addEventListener('click', setToday);
  $('printBtn').addEventListener('click', () => window.print());
}

init();
