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
  items: [],          // flattened {name, days, pkgDate, category}
  byName: new Map(),
  current: null,      // product open in the sheet
  pull: [],           // [{name, qty, done}]
  overrides: {},
  imgCache: new Map(),
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
}

function flatten() {
  for (const cat of state.data.categories) {
    for (const it of cat.items) {
      const obj = { ...it, category: cat.category };
      state.items.push(obj);
      state.byName.set(it.name, obj);
    }
  }
}

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

  renderSheetResult(it);
  updateSheetAddBtn();
  loadImage(it);

  $('sheetBackdrop').hidden = false;
  $('sheet').hidden = false;
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
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });
}

init();
