/* RTS Sell-By + Pull List
 * - Mobile-first calculator for Ready-to-Eat shelf life
 * - Sell-by = pull date (from freezer) + shelf-life days, shown as MM/DD/YYYY
 * - Morning "pull list": tap items you need to pull, see each sell-by date,
 *   check them off, and copy/share the list. Persists in localStorage.
 * - HEB.com product images via the local proxy (server.js) with a fallback link.
 */

const HEB_SEARCH = (q) => `https://www.heb.com/search?q=${encodeURIComponent(q)}`;
const LS_KEY = 'rts.pullList.v1';
const LS_SHELF = 'rts.shelfOverrides.v1';   // legacy (migrated into LS_CUST)
const LS_CUST = 'rts.catalog.v2';           // user edits: { patches, added, deleted }
const LS_BASE = 'rts.baseCatalog.v1';       // optional imported base catalog
const LS_WX = 'rts.wxCollapsed';
const LS_HOLIDAY = 'rts.hideHoliday';
const LS_CAKE = 'rts.hideCake';
const LS_PROD = 'rts.production.v1';

const state = {
  data: null,
  items: [],          // flattened {name, days, pkgDate, category, image?, upc?, par?}
  byName: new Map(),
  byUpc: new Map(),   // normalized UPC -> product
  current: null,      // product open in the sheet
  pull: [],           // [{name, qty, done}]
  overrides: {},
  base: [],           // base catalog items (with _key)
  catOrder: new Map(),
  cust: { patches: {}, added: [], deleted: [] },  // user customizations
  hideHoliday: false,
  hideCake: false,
  prod: {},           // production plan: id -> { make, done }
  imgCache: new Map(),
  scan: { controls: null, active: false, mode: 'lookup', onCapture: null, lastCode: '' },
};

const $ = (id) => document.getElementById(id);

/* ---------------- init ---------------- */
async function init() {
  try {
    const saved = localStorage.getItem(LS_BASE);
    state.data = saved ? JSON.parse(saved) : await (await fetch('data/products.json')).json();
  } catch {
    $('productList').innerHTML =
      `<div class="no-results">Could not load products.json.<br>Run via a local server (see README).</div>`;
    return;
  }

  buildBase();
  loadCustomizations();
  loadHolidayPref();
  loadCakePref();
  rebuildItems();
  loadPullList();
  loadProduction();
  buildCategoryFilter();
  buildCatDatalist();
  renderHeader();
  setToday();
  renderList();
  renderPullList();
  renderProduction();
  wireEvents();
  applyWxCollapsed();
  syncHolidayBtn();
  syncCakeBtn();
  loadWeather();
}

// Normalize a UPC/EAN to digits only (drops spaces, dashes).
function normUpc(code) { return String(code).replace(/\D/g, ''); }

/* ---------------- Catalog: base + user customizations ---------------- */
function baseKeyOf(it) { return it.upc ? 'u:' + normUpc(it.upc) : 'n:' + it.name; }

function buildBase() {
  state.base = [];
  state.catOrder = new Map();
  state.data.categories.forEach((c) => { if (!state.catOrder.has(c.category)) state.catOrder.set(c.category, state.catOrder.size); });
  for (const cat of state.data.categories)
    for (const it of cat.items)
      state.base.push({ ...it, category: cat.category, _key: baseKeyOf(it) });
}

function loadCustomizations() {
  try { state.cust = JSON.parse(localStorage.getItem(LS_CUST) || 'null') || { patches: {}, added: [], deleted: [] }; }
  catch { state.cust = { patches: {}, added: [], deleted: [] }; }
  state.cust.patches = state.cust.patches || {};
  state.cust.added = state.cust.added || [];
  state.cust.deleted = state.cust.deleted || [];
  // migrate legacy shelf-only overrides
  try {
    const old = JSON.parse(localStorage.getItem(LS_SHELF) || 'null');
    if (old && typeof old === 'object') {
      for (const k in old) state.cust.patches[k] = Object.assign({}, state.cust.patches[k], { days: old[k].days });
      localStorage.removeItem(LS_SHELF);
      saveCustomizations();
    }
  } catch {}
}
function saveCustomizations() { try { localStorage.setItem(LS_CUST, JSON.stringify(state.cust)); } catch {} }

function effective(src, patch, key, isAdded) {
  const days = ('days' in patch) ? patch.days : src.days;
  return {
    name: patch.name ?? src.name,
    category: patch.category ?? src.category,
    days, pkgDate: days == null,
    upc: ('upc' in patch ? patch.upc : src.upc) || '',
    image: ('image' in patch ? patch.image : src.image) || undefined,
    par: ('par' in patch ? patch.par : src.par) || undefined,
    boxQty: ('boxQty' in patch ? patch.boxQty : src.boxQty) || undefined,
    table: ('table' in patch ? patch.table : src.table) || undefined,
    holiday: ('holiday' in patch ? patch.holiday : src.holiday) || false,
    seasonTable: ('seasonTable' in patch ? patch.seasonTable : src.seasonTable) || undefined,
    cakeSide: ('cakeSide' in patch ? patch.cakeSide : src.cakeSide) || false,
    _key: key, _added: !!isAdded,
    _defDays: src.days, _defPkg: src.pkgDate,
  };
}

/* Physical tables, in floor-walk order. Each product maps to a table either
 * explicitly (it.table) or via its category. */
const TABLES = [
  { n: 1, name: 'Breakfast' },
  { n: 2, name: 'Cookies, Cakes & Brownies' },
  { n: 3, name: 'Doughnuts' },
  { n: 4, name: 'Mexican Pastry' },
  { n: 5, name: 'Sugar Free & Gluten Free' },
  { n: 6, name: 'Breads' },
  { n: 7, name: 'Cupcakes & Freezer' },
];
const TABLE_NAME = Object.fromEntries(TABLES.map((t) => [t.n, t.name]));
const CATEGORY_TABLE = {
  'Biscotti': 1, 'Danish/Donuts/Eclairs': 1, 'Muffins': 1, 'Mini Muffins': 1, 'Scones': 1,
  'Cakes': 2, 'Decorated Cakes': 2, 'Candy': 2, 'Cookies': 2,
  'Macarons': 2, 'Pies': 2, 'Two Bite Items': 2, 'Fruit Cakes': 2,
  'Babka': 4, 'Bunuelo': 4, 'Rosca de Reyes': 4,
  'Granola': 5, 'Gluten Free Items': 5, 'Sugar Free': 5,
  'Bread/Buns': 6, 'Stollen/Panettone': 6,
  'Cheesecakes': 7, 'Cupcakes': 7, 'Ice Cream Cakes/Cupcakes': 7,
};
function tableFor(it) {
  if (it.table) return it.table;
  if (/donut|doughnut/i.test(it.name)) return 3;   // doughnuts get their own table
  return CATEGORY_TABLE[it.category] || 2;
}

/* Holiday items live on a parallel set of 6 "Season Tables". */
const SEASON_TABLES = [1, 2, 3, 4, 5, 6].map((n) => ({ n, name: 'Season Table ' + n }));
const SEASON_NAME = Object.fromEntries(SEASON_TABLES.map((t) => [t.n, t.name]));
function seasonFor(it) { return it.holiday ? (it.seasonTable || 1) : 0; }

function rebuildItems() {
  const list = [];
  for (const b of state.base) {
    if (state.cust.deleted.includes(b._key)) continue;
    list.push(effective(b, state.cust.patches[b._key] || {}, b._key, false));
  }
  for (const a of state.cust.added) {
    if (state.cust.deleted.includes(a._key)) continue;
    list.push(effective(a, {}, a._key, true));
  }
  const order = (cat) => { if (!state.catOrder.has(cat)) state.catOrder.set(cat, state.catOrder.size); return state.catOrder.get(cat); };
  for (const it of list) { it._table = tableFor(it); it._season = seasonFor(it); }
  // everyday tables first (by table), then seasonal items (by season table)
  list.sort((x, y) => {
    const hx = x.holiday ? 1 : 0, hy = y.holiday ? 1 : 0;
    if (hx !== hy) return hx - hy;
    const gx = x.holiday ? x._season : x._table, gy = y.holiday ? y._season : y._table;
    return gx - gy || order(x.category) - order(y.category) || x.name.localeCompare(y.name);
  });
  state.items = list;
  state.byName = new Map(); state.byUpc = new Map();
  for (const it of list) { state.byName.set(it.name, it); if (it.upc) state.byUpc.set(normUpc(it.upc), it); }
}

function isOverridden(it) { return it._added || Object.prototype.hasOwnProperty.call(state.cust.patches, it._key); }

function loadHolidayPref() {
  let v = null; try { v = localStorage.getItem(LS_HOLIDAY); } catch {}
  state.hideHoliday = v === null ? true : v === '1';   // default: holiday items hidden
}
function toggleHoliday() {
  state.hideHoliday = !state.hideHoliday;
  try { localStorage.setItem(LS_HOLIDAY, state.hideHoliday ? '1' : '0'); } catch {}
  syncHolidayBtn();
  renderList();
}
function syncHolidayBtn() {
  const btn = $('holidayToggle');
  btn.classList.toggle('active', state.hideHoliday);
  btn.textContent = state.hideHoliday ? '🎄 Holiday: hidden' : '🎄 Holiday: shown';
}

function loadCakePref() {
  let v = null; try { v = localStorage.getItem(LS_CAKE); } catch {}
  state.hideCake = v === null ? true : v === '1';   // default: cake-side items hidden
}
function toggleCake() {
  state.hideCake = !state.hideCake;
  try { localStorage.setItem(LS_CAKE, state.hideCake ? '1' : '0'); } catch {}
  syncCakeBtn();
  renderList();
}
function syncCakeBtn() {
  const btn = $('cakeToggle');
  btn.classList.toggle('active', state.hideCake);
  btn.textContent = state.hideCake ? '🎂 Cake side: hidden' : '🎂 Cake side: shown';
}

function refreshCatalog() {
  rebuildItems();
  buildCategoryFilter();
  buildCatDatalist();
  renderHeader();
  renderList();
  renderPullList();
}

function renderHeader() {
  const d = state.data.lastUpdated;
  if (d) {
    const dt = parseISO(d);
    $('lastUpdated').textContent = 'Sheet updated ' + fmtDate(dt);
  }
  const nCats = new Set(state.items.map((i) => i.category)).size;
  $('footerCount').textContent = `${state.items.length} items · ${nCats} categories`;
}

function categoryNames() {
  const seen = [];
  for (const it of state.items) if (!seen.includes(it.category)) seen.push(it.category);
  return seen;
}

function buildCategoryFilter() {
  const sel = $('categoryFilter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All tables</option>';
  const present = new Set(state.items.filter((i) => !i.holiday).map((i) => i._table));
  for (const t of TABLES) {
    if (!present.has(t.n)) continue;
    const o = document.createElement('option');
    o.value = String(t.n); o.textContent = `${t.n} · ${t.name}`;
    sel.appendChild(o);
  }
  const seasonPresent = new Set(state.items.filter((i) => i.holiday).map((i) => i._season));
  for (const t of SEASON_TABLES) {
    if (!seasonPresent.has(t.n)) continue;
    const o = document.createElement('option');
    o.value = 's' + t.n; o.textContent = `🎄 ${t.name}`;
    sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

function buildCatDatalist() {
  const dl = $('catList');
  if (!dl) return;
  dl.innerHTML = '';
  for (const cat of categoryNames()) {
    const o = document.createElement('option'); o.value = cat; dl.appendChild(o);
  }
}

/* ---------------- Browse list ---------------- */
function renderList() {
  const term = $('search').value.trim().toLowerCase();
  const tableFilter = $('categoryFilter').value;
  const seasonFilter = tableFilter.startsWith('s');
  const filterNum = seasonFilter ? parseInt(tableFilter.slice(1), 10) : parseInt(tableFilter, 10);
  const list = $('productList');
  list.innerHTML = '';
  let shown = 0, lastCat = null, lastGroup = null;

  for (const it of state.items) {
    // holiday toggle hides seasonal items (unless explicitly filtering a season)
    if (state.hideHoliday && it.holiday && !seasonFilter) continue;
    // cake-side items are hidden from the shelves when the toggle is on
    if (state.hideCake && it.cakeSide) continue;
    if (tableFilter) {
      if (seasonFilter) { if (!(it.holiday && it._season === filterNum)) continue; }
      else { if (it.holiday || it._table !== filterNum) continue; }
    }
    if (term && !matches(it, term)) continue;

    const groupKey = it.holiday ? 's' + it._season : 't' + it._table;
    if (groupKey !== lastGroup) {
      const th = document.createElement('div');
      if (it.holiday) {
        th.className = 'table-header season';
        th.innerHTML = `<span class="table-num">🎄</span> ${escapeHtml(SEASON_NAME[it._season] || 'Seasonal')}`;
      } else {
        th.className = 'table-header';
        th.innerHTML = `<span class="table-num">${it._table}</span> ${escapeHtml(TABLE_NAME[it._table] || 'Other')}`;
      }
      list.appendChild(th); lastGroup = groupKey; lastCat = null;
    }
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
      `<div class="name">${it.holiday ? '🎄 ' : ''}${it.cakeSide ? '🎂 ' : ''}${escapeHtml(it.name)}</div>
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
  let filterLabel = '';
  if (tableFilter) filterLabel = seasonFilter ? ` · 🎄 ${SEASON_NAME[filterNum]}` : ` · Table ${filterNum} · ${TABLE_NAME[filterNum]}`;
  $('resultCount').textContent =
    `${shown} ${shown === 1 ? 'product' : 'products'}` + filterLabel;
}

function matches(it, term) {
  return it.name.toLowerCase().includes(term) || it.category.toLowerCase().includes(term)
    || (TABLE_NAME[it._table] || '').toLowerCase().includes(term);
}

/* ---------------- Detail sheet ---------------- */
function openSheet(it) {
  state.current = it;
  $('detailCategory').textContent = it.category;
  $('detailName').textContent = it.name;
  $('hebLink').href = HEB_SEARCH(hebQuery(it.name));

  renderShelf(it);
  renderUpc(it);
  renderPar(it);
  renderSheetResult(it);
  updateSheetAddBtn();
  loadImage(it);

  $('sheetBackdrop').hidden = false;
  $('sheet').hidden = false;
}

function renderShelf(it) {
  const tag = isOverridden(it) ? ' <span class="edited-tag">edited</span>' : '';
  $('detailShelf').innerHTML = it.pkgDate
    ? `Shelf life: <strong>Follow printed package date</strong>${tag}`
    : `Shelf life: <strong>${it.days} ${it.days === 1 ? 'day' : 'days'}</strong> from freezer pull${tag}`;
}

/* ---- item editor (edit / add / delete) ---- */
let editorKey = null;       // key of item being edited; null = adding new
let editorFromSheet = false;

function openItemEditor(it) {
  editorKey = it ? it._key : null;
  editorFromSheet = !!it;
  // hide the detail sheet underneath so the two don't overlap (keep state.current
  // so Cancel can return to it)
  if (it) { state.current = it; $('sheet').hidden = true; $('sheetBackdrop').hidden = true; }
  $('editorTitle').textContent = it ? 'Edit item' : 'Add item';
  const par = (it && it.par) || {};
  $('edName').value = it ? it.name : '';
  $('edCategory').value = it ? it.category : '';
  $('edTable').value = it && it.table ? String(it.table) : '';
  $('edUpc').value = it ? (it.upc || '') : '';
  $('edBox').value = it && it.boxQty ? it.boxQty : '';
  $('edImage').value = it ? (it.image || '') : '';
  $('edTall').value = par.tall || ''; $('edWide').value = par.wide || ''; $('edDeep').value = par.deep || '';
  $('edHoliday').checked = it ? !!it.holiday : false;
  $('edSeason').value = it && it.seasonTable ? String(it.seasonTable) : '1';
  $('edSeasonField').hidden = !$('edHoliday').checked;
  $('edCake').checked = it ? !!it.cakeSide : false;
  const pkg = it ? it.pkgDate : false;
  $('edPkg').checked = pkg;
  $('edDays').value = it && !pkg ? it.days : '';
  $('edDays').disabled = pkg;
  $('edDelete').style.display = it ? '' : 'none';
  $('edReset').style.display = it && !it._added ? '' : 'none';
  $('itemEditor').scrollTop = 0;
  $('editorBackdrop').hidden = false;
  $('itemEditor').hidden = false;
}
function closeItemEditor() { $('itemEditor').hidden = true; $('editorBackdrop').hidden = true; }
function cancelItemEditor() {
  closeItemEditor();
  if (editorFromSheet && state.current) openSheet(state.current);
}

function readEditor() {
  const name = $('edName').value.trim();
  if (!name) { $('edName').focus(); return null; }
  const pkg = $('edPkg').checked;
  let days = null;
  if (!pkg) { const d = parseInt($('edDays').value, 10); days = Number.isFinite(d) && d >= 0 ? d : null; }
  const pos = (id) => { const n = parseInt($(id).value, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
  const tall = pos('edTall'), wide = pos('edWide'), deep = pos('edDeep');
  const box = pos('edBox');
  return {
    name,
    category: $('edCategory').value.trim() || 'Other',
    table: parseInt($('edTable').value, 10) || null,
    upc: normUpc($('edUpc').value),
    image: $('edImage').value.trim(),
    boxQty: box || null,
    par: (tall || wide || deep) ? { tall, wide, deep } : null,
    holiday: $('edHoliday').checked,
    seasonTable: $('edHoliday').checked ? (parseInt($('edSeason').value, 10) || 1) : null,
    cakeSide: $('edCake').checked,
    days: pkg ? null : days,
  };
}

function saveItemEditor() {
  const f = readEditor(); if (!f) return;
  let key = editorKey;
  if (editorKey) {
    const added = state.cust.added.find((a) => a._key === editorKey);
    if (added) Object.assign(added, f, { pkgDate: f.days == null });
    else state.cust.patches[editorKey] = f;
  } else {
    key = 'a:' + (f.upc ? 'u' + f.upc : Date.now().toString(36) + Math.floor(Math.random() * 1e4));
    state.cust.added.push(Object.assign({ _key: key }, f, { pkgDate: f.days == null }));
  }
  saveCustomizations();
  closeItemEditor();
  refreshCatalog();
  const updated = state.items.find((i) => i._key === key);
  if (editorFromSheet && updated) openSheet(updated); else if (editorFromSheet) closeSheet();
}

function deleteItemEditor() {
  if (!editorKey) return;
  if (!confirm('Delete this item from the catalog?')) return;
  const added = state.cust.added.find((a) => a._key === editorKey);
  if (added) state.cust.added = state.cust.added.filter((a) => a._key !== editorKey);
  else { if (!state.cust.deleted.includes(editorKey)) state.cust.deleted.push(editorKey); delete state.cust.patches[editorKey]; }
  saveCustomizations();
  closeItemEditor(); closeSheet(); refreshCatalog();
}

function resetItemEditor() {
  if (!editorKey) return;
  delete state.cust.patches[editorKey];
  state.cust.deleted = state.cust.deleted.filter((k) => k !== editorKey);
  saveCustomizations();
  closeItemEditor(); refreshCatalog();
  const updated = state.items.find((i) => i._key === editorKey);
  if (updated) openSheet(updated); else closeSheet();
}

/* ---- export / import catalog ---- */
function exportCatalog() {
  const cats = [];
  for (const c of categoryNames()) {
    const items = state.items.filter((i) => i.category === c).map((i) => {
      const o = { name: i.name, days: i.days, pkgDate: i.pkgDate };
      if (i.upc) o.upc = i.upc;
      if (i.image) o.image = i.image;
      if (i.par) o.par = i.par;
      if (i.boxQty) o.boxQty = i.boxQty;
      return o;
    });
    cats.push({ category: c, items });
  }
  const out = Object.assign({}, state.data, { categories: cats, exportedAt: new Date().toISOString() });
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'products.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importCatalog(file) {
  const r = new FileReader();
  r.onload = () => {
    let data;
    try { data = JSON.parse(r.result); } catch { alert('That file is not valid JSON.'); return; }
    if (!data || !Array.isArray(data.categories)) { alert('That JSON does not look like a products catalog.'); return; }
    if (!confirm('Replace the current catalog with this file? Your local edits will be cleared.')) return;
    state.data = data;
    try { localStorage.setItem(LS_BASE, JSON.stringify(data)); } catch {}
    state.cust = { patches: {}, added: [], deleted: [] };
    saveCustomizations();
    buildBase(); refreshCatalog();
    alert('Imported ' + state.items.length + ' products.');
  };
  r.readAsText(file);
}

function renderUpc(it) {
  $('detailUpc').innerHTML = it.upc
    ? `UPC <span class="upc-num">${escapeHtml(String(it.upc))}</span>`
    : '';
}

/* Par level — "tall × wide × deep" with a cute front-of-shelf icon grid. */
function renderPar(it) {
  const box = $('detailPar');
  const par = it.par;
  if (!par || !(par.tall || par.wide || par.deep)) { box.innerHTML = ''; return; }
  const tall = par.tall || 0, wide = par.wide || 0, deep = par.deep || 0;
  const total = (tall || 1) * (wide || 1) * (deep || 1);
  // Front view of the shelf: `wide` facings across × `tall` high.
  const cols = Math.min(Math.max(wide, 1), 8), rows = Math.min(Math.max(tall, 1), 6);
  let cells = '';
  for (let i = 0; i < cols * rows; i++) cells += '<div class="cell"></div>';
  box.innerHTML =
    `<div class="par-card">
       <div class="par-grid" style="grid-template-columns:repeat(${cols},14px)">${cells}</div>
       <div class="par-meta">
         <div class="par-title">📦 Par level</div>
         <div class="par-dim">${tall} tall × ${wide} wide × ${deep} deep</div>
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
      .map((p) => ({ name: p.name, qty: Math.max(1, p.qty | 0 || 1), done: !!p.done, labels: !!p.labels }));
  } catch { state.pull = []; }
}
function savePullList() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state.pull)); } catch {}
}
function inList(name) { return state.pull.some((p) => p.name === name); }

function toggleList(name) {
  const i = state.pull.findIndex((p) => p.name === name);
  if (i >= 0) state.pull.splice(i, 1);
  else state.pull.push({ name, qty: 1, done: false, labels: false });
  savePullList();
  renderList();
  renderPullList();
  updateSheetAddBtn();
}

// boxes needed for a quantity given items-per-box
function boxesFor(it, qty) {
  return it && it.boxQty ? Math.ceil(qty / it.boxQty) : null;
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

function toggleLabels(name) {
  const p = state.pull.find((x) => x.name === name);
  if (!p) return;
  p.labels = !p.labels;
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

  const ordered = state.items.filter((it) => inList(it.name));
  const totalQty = state.pull.reduce((s, p) => s + p.qty, 0);
  const doneCount = state.pull.filter((p) => p.done).length;
  const labeledCount = state.pull.filter((p) => p.labels).length;
  let totalBoxes = 0, boxKnown = false;
  for (const it of ordered) {
    const p = state.pull.find((x) => x.name === it.name);
    const b = boxesFor(it, p.qty);
    if (b != null) { totalBoxes += b; boxKnown = true; }
  }
  $('pullSummary').innerHTML =
    `${n} item${n === 1 ? '' : 's'} · ${totalQty} to pull` +
    (boxKnown ? ` · <strong>${totalBoxes} box${totalBoxes === 1 ? '' : 'es'}</strong>` : '') +
    ` · ${doneCount}/${n} pulled · ${labeledCount}/${n} labeled · pulled ${fmtDate(getPullDate())}`;

  const wrap = $('pullItems');
  wrap.innerHTML = '';
  for (const it of ordered) {
    const p = state.pull.find((x) => x.name === it.name);
    const row = document.createElement('div');
    row.className = 'pull-item' + (p.done ? ' done' : '') + (p.labels ? ' labeled' : '');

    const sell = it.pkgDate
      ? `<span class="pull-sellby pkg">Pkg date</span>`
      : (() => { const sb = sellByFor(it); const { cls } = freshness(sb);
                 return `<span class="pull-sellby ${cls}">${fmtDate(sb)}</span>`; })();
    const boxes = boxesFor(it, p.qty);
    const boxHtml = boxes != null
      ? `<span class="pull-boxes">${boxes} box${boxes === 1 ? '' : 'es'}</span>`
      : `<span class="pull-boxes unknown">box qty —</span>`;

    const thumb = it.image
      ? `<img src="${escapeHtml(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('empty');this.remove();" />`
      : '';
    row.innerHTML = `
      <input type="checkbox" class="pull-check" ${p.done ? 'checked' : ''} aria-label="Mark pulled" />
      <div class="pull-thumb${it.image ? '' : ' empty'}">${thumb}</div>
      <div class="pull-main">
        <div class="pull-name">${escapeHtml(it.name)}</div>
        <div class="pull-sub">${escapeHtml(it.category)} · sell by ${sell}</div>
      </div>
      <div class="qty">
        <button type="button" data-act="dec" aria-label="Decrease quantity">−</button>
        <span>${p.qty}</span>
        <button type="button" data-act="inc" aria-label="Increase quantity">+</button>
      </div>
      <div class="pull-flags">
        <label class="label-toggle"><input type="checkbox" ${p.labels ? 'checked' : ''} aria-label="Labels printed" /> labels</label>
        ${boxHtml}
      </div>
      <button type="button" class="remove-btn" aria-label="Remove">🗑️</button>`;

    row.querySelector('.pull-check').addEventListener('change', () => toggleDone(it.name));
    row.querySelector('.label-toggle input').addEventListener('change', () => toggleLabels(it.name));
    row.querySelector('[data-act="dec"]').addEventListener('click', () => setQty(it.name, -1));
    row.querySelector('[data-act="inc"]').addEventListener('click', () => setQty(it.name, +1));
    row.querySelector('.remove-btn').addEventListener('click', () => toggleList(it.name));
    wrap.appendChild(row);
  }
}

function pullListText() {
  const lines = [`Pull List — pulled ${fmtDate(getPullDate())}`];
  const ordered = state.items.filter((it) => inList(it.name));
  let totalBoxes = 0, boxKnown = false;
  for (const it of ordered) {
    const p = state.pull.find((x) => x.name === it.name);
    const sb = it.pkgDate ? 'pkg date' : 'sell by ' + fmtDate(sellByFor(it));
    const b = boxesFor(it, p.qty);
    if (b != null) { totalBoxes += b; boxKnown = true; }
    const boxStr = b != null ? ` (${b} box${b === 1 ? '' : 'es'})` : '';
    lines.push(`[${p.done ? 'x' : ' '}] ${p.qty}x ${it.name} — ${sb}${boxStr}`);
  }
  if (boxKnown) lines.push(`Total: ${totalBoxes} box${totalBoxes === 1 ? '' : 'es'}`);
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

/* ---------------- Production (platters & sliced half creme cakes) ---------------- */
const PRODUCTION = [
  { id: 'plt-doughnut', group: 'Platters', name: 'Doughnut Platter', components: ['Glazed', 'Chocolate', 'Powdered'] },
  { id: 'plt-cookie', group: 'Platters', name: 'Cookie Platter', components: ['Oatmeal', 'Sugar', 'Candy', 'Chunk'] },
  { id: 'plt-cookiebrownie', group: 'Platters', name: 'Cookie + Brownie Platter', components: ['Oatmeal', 'Sugar', 'Candy', 'Chunk', 'Brownie Bites'] },
  { id: 'plt-loaf', group: 'Platters', name: 'Sliced Loaf Platter', components: ['Lemon', 'Marble', 'Danish'] },
  { id: 'plt-pdp-half', group: 'Platters', name: 'Pan de Polvo (Half & Half)', components: ['Powdered Sugar', 'Cinnamon'] },
  { id: 'plt-pdp-cinn', group: 'Platters', name: 'Pan de Polvo (Cinnamon)', components: ['Cinnamon'] },
  { id: 'cake-marble', group: 'Sliced Half Creme Cakes', name: 'Marble', cake: true },
  { id: 'cake-lemon', group: 'Sliced Half Creme Cakes', name: 'Lemon', cake: true },
  { id: 'cake-strawberry', group: 'Sliced Half Creme Cakes', name: 'Strawberry', cake: true },
  { id: 'cake-banananut', group: 'Sliced Half Creme Cakes', name: 'Banana Nut', cake: true },
  { id: 'cake-triplechoc', group: 'Sliced Half Creme Cakes', name: 'Triple Chocolate', cake: true },
  { id: 'cake-sockit', group: 'Sliced Half Creme Cakes', name: 'Sock It To Me', cake: true },
];

function loadProduction() {
  try { state.prod = JSON.parse(localStorage.getItem(LS_PROD) || '{}') || {}; } catch { state.prod = {}; }
}
function saveProduction() { try { localStorage.setItem(LS_PROD, JSON.stringify(state.prod)); } catch {} }
function prodOf(id) { return state.prod[id] || (state.prod[id] = { make: 0, done: false }); }

function setProdMake(id, delta) {
  const p = prodOf(id);
  p.make = Math.max(0, p.make + delta);
  if (p.make === 0) p.done = false;
  saveProduction(); renderProduction();
}
function toggleProdDone(id) {
  const p = prodOf(id);
  if (!p.make) return;
  p.done = !p.done;
  saveProduction(); renderProduction();
}
function clearProduction() {
  if (!Object.keys(state.prod).length) return;
  if (!confirm('Clear the whole production plan?')) return;
  state.prod = {};
  saveProduction(); renderProduction();
}

function updateProdCount() {
  const n = PRODUCTION.filter((it) => (state.prod[it.id] || {}).make > 0).length;
  $('prodCount').textContent = n;
}

function renderProduction() {
  updateProdCount();
  const wrap = $('prodItems');
  wrap.innerHTML = '';
  let lastGroup = null;
  let totalPlatters = 0, totalHalves = 0, doneCount = 0, planned = 0;

  for (const it of PRODUCTION) {
    const p = state.prod[it.id] || { make: 0, done: false };
    if (it.group !== lastGroup) {
      const h = document.createElement('div');
      h.className = 'cat-header'; h.textContent = it.group;
      wrap.appendChild(h); lastGroup = it.group;
    }
    if (p.make > 0) {
      planned++;
      if (p.done) doneCount++;
      if (it.cake) totalHalves += p.make; else totalPlatters += p.make;
    }
    const sub = it.cake
      ? (p.make > 0 ? `${p.make} halves · slice ${Math.ceil(p.make / 2)} whole${Math.ceil(p.make / 2) === 1 ? '' : 's'}` : 'sliced half creme cake')
      : (it.components || []).join(' · ');

    const row = document.createElement('div');
    row.className = 'pull-item' + (p.done ? ' done' : '');
    row.innerHTML = `
      <input type="checkbox" class="pull-check" ${p.done ? 'checked' : ''} ${p.make ? '' : 'disabled'} aria-label="Mark produced" />
      <div class="pull-main">
        <div class="pull-name">${escapeHtml(it.name)}</div>
        <div class="pull-sub">${escapeHtml(sub)}</div>
      </div>
      <div class="qty">
        <button type="button" data-act="dec" aria-label="Decrease">−</button>
        <span>${p.make}</span>
        <button type="button" data-act="inc" aria-label="Increase">+</button>
      </div>`;
    row.querySelector('.pull-check').addEventListener('change', () => toggleProdDone(it.id));
    row.querySelector('[data-act="dec"]').addEventListener('click', () => setProdMake(it.id, -1));
    row.querySelector('[data-act="inc"]').addEventListener('click', () => setProdMake(it.id, +1));
    wrap.appendChild(row);
  }

  $('prodSummary').innerHTML = planned === 0
    ? 'Set how many to make with the + buttons.'
    : `<strong>${totalPlatters}</strong> platter${totalPlatters === 1 ? '' : 's'} · <strong>${totalHalves}</strong> creme-cake halves · ${doneCount}/${planned} produced`;
}

function productionText() {
  const lines = [`Production plan — ${fmtDate(stripTime(new Date()))}`];
  let lastGroup = null;
  for (const it of PRODUCTION) {
    const p = state.prod[it.id] || { make: 0 };
    if (!p.make) continue;
    if (it.group !== lastGroup) { lines.push(`-- ${it.group} --`); lastGroup = it.group; }
    const extra = it.cake ? ` (slice ${Math.ceil(p.make / 2)})` : '';
    lines.push(`[${p.done ? 'x' : ' '}] ${p.make}x ${it.name}${extra}`);
  }
  return lines.length > 1 ? lines.join('\n') : 'Production plan is empty.';
}
async function copyProduction() {
  const text = productionText();
  try { if (navigator.share) { await navigator.share({ title: 'Production plan', text }); return; } } catch {}
  try { await navigator.clipboard.writeText(text); flashBtn($('prodCopyBtn'), '✓ Copied'); }
  catch { prompt('Copy your production plan:', text); }
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
  updateDateLabel();
  renderList();
  renderPullList();
  if (state.current) renderSheetResult(state.current);
}

function setToday() { $('pullDate').value = toISO(new Date()); onPullDateChange(); }

function updateDateLabel() {
  const d = parseISO($('pullDate').value);
  if (!d) { $('todayLabel').textContent = ''; return; }
  const isToday = d.getTime() === stripTime(new Date()).getTime();
  const fmt = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  $('todayLabel').textContent = (isToday ? 'Today · ' : '') + fmt;
}

/* ---------------- Weather (San Antonio 78253) ----------------
 * Three 3-hour blocks for the next 9 hours, to anticipate demand.
 * Open-Meteo: free, no API key, CORS-enabled (works on GitHub Pages). */
const WX = { lat: 29.466, lon: -98.800, tz: 'America/Chicago', label: 'San Antonio · 78253' };

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

function toggleWeather() {
  const collapsed = $('weather').classList.toggle('collapsed');
  $('wxToggle').setAttribute('aria-expanded', String(!collapsed));
  try { localStorage.setItem(LS_WX, collapsed ? '1' : '0'); } catch {}
}
function applyWxCollapsed() {
  let v = null; try { v = localStorage.getItem(LS_WX); } catch {}
  const collapsed = v === null ? true : v === '1';   // default collapsed
  $('weather').classList.toggle('collapsed', collapsed);
  $('wxToggle').setAttribute('aria-expanded', String(!collapsed));
}

async function loadWeather() {
  const box = $('wxBullets');
  box.innerHTML = `<div class="wx-msg">Loading weather…</div>`;
  $('wxTip').innerHTML = '';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${WX.lat}&longitude=${WX.lon}`
    + `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m`
    + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max`
    + `&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m`
    + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=${encodeURIComponent(WX.tz)}`
    + `&forecast_days=2&timeformat=unixtime`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    renderWeather(data);
  } catch {
    box.innerHTML = `<div class="wx-err">Weather unavailable right now. Tap ↻ to retry.</div>`;
  }
}

function renderWeather(data) {
  const hl = data && data.hourly;
  if (!hl || !Array.isArray(hl.time)) {
    $('wxBullets').innerHTML = `<div class="wx-err">Weather unavailable right now.</div>`;
    return;
  }
  const dl = data.daily || {};
  const today = {
    hi: dl.temperature_2m_max ? Math.round(dl.temperature_2m_max[0]) : null,
    lo: dl.temperature_2m_min ? Math.round(dl.temperature_2m_min[0]) : null,
    pop: dl.precipitation_probability_max ? (dl.precipitation_probability_max[0] ?? 0) : 0,
    code: dl.weather_code ? dl.weather_code[0] : 0,
  };

  // current conditions card (today's high/low)
  const cur = data.current || {};
  const curTemp = Math.round(cur.temperature_2m ?? today.hi ?? 0);
  const [ce, clabel] = wmo(cur.weather_code ?? today.code ?? 0);
  $('wxChipTemp').textContent = `${curTemp}°`;
  $('wxChipIcon').textContent = ce;
  $('wxCurrent').innerHTML =
    `<div class="wx-cur-emoji">${ce}</div>
     <div class="wx-cur-main">
       <div class="wx-cur-temp">${curTemp}°</div>
       <div class="wx-cur-label">${escapeHtml(clabel)}</div>
       <div class="wx-cur-meta">Feels ${Math.round(cur.apparent_temperature ?? curTemp)}° · 💨 ${Math.round(cur.wind_speed_10m ?? 0)} mph · 🌧️ ${today.pop}%</div>
     </div>` +
    (today.hi != null ? `<div class="wx-cur-hilo">today<br><b>${today.hi}°</b> / ${today.lo}°</div>` : '');

  // hourly strip (next 12 hours)
  const now = Math.floor(Date.now() / 1000);
  let start = hl.time.findIndex((t) => t >= now);
  if (start < 0) start = 0;
  const hours = [];
  for (let k = 0; k < 12; k++) {
    const i = start + k;
    if (i >= hl.time.length) break;
    hours.push({
      sec: hl.time[i],
      temp: Math.round(hl.temperature_2m[i]),
      pop: hl.precipitation_probability[i] ?? 0,
      wind: Math.round(hl.wind_speed_10m[i] ?? 0),
      code: hl.weather_code[i] ?? 0,
    });
  }
  $('wxBullets').innerHTML = hours.map((b, k) => {
    const [emoji, label] = wmo(b.code);
    return `<div class="wx-bullet" title="${escapeHtml(label)}">
      <div class="wx-when">${k === 0 ? 'Now' : hourLabel(b.sec)}</div>
      <div class="wx-emoji">${emoji}</div>
      <div class="wx-temp">${b.temp}°</div>
      <div class="wx-cond"><span class="wx-rain">${b.pop}%</span><br>💨${b.wind}</div>
    </div>`;
  }).join('');

  const maxPop = Math.max(today.pop || 0, ...hours.map((x) => x.pop));
  const maxWind = Math.max(Math.round(cur.wind_speed_10m ?? 0), ...hours.map((x) => x.wind));
  const dp = new Intl.DateTimeFormat('en-US', { timeZone: WX.tz, weekday: 'short', hour: 'numeric', hour12: false })
    .formatToParts(new Date());
  const wd = (dp.find((p) => p.type === 'weekday') || {}).value || '';
  const hr = parseInt((dp.find((p) => p.type === 'hour') || {}).value, 10) || 0;
  $('wxTip').innerHTML = sellTip({ hi: today.hi ?? curTemp, maxPop, maxWind, weekday: wd, hour: hr % 24 });
}

function hourLabel(sec) { const p = hourParts(sec); return `${p.h} ${p.ap}`; }
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

/* Bakery demand hints from weather + day-of-week + time of day.
 * Returns 2–3 ranked bullets. ctx: { hi, maxPop, maxWind, weekday, hour } */
function sellTip(ctx) {
  const { hi, maxPop, maxWind, weekday, hour } = ctx;
  const tips = [];

  // 1) dominant weather condition
  if (maxPop >= 60) tips.push(`🌧️ Rain likely (${maxPop}%) — grab-and-go comfort: coffee cakes, pies, breads, pretzels; push coffee pairings.`);
  else if (hi >= 90) tips.push(`🔥 Hot (${hi}°) — feature chilled &amp; light: ice cream cakes, two-bite items, lighter pastries; ease off heavy breads.`);
  else if (hi <= 50) tips.push(`❄️ Cold (${hi}°) — comfort bakes: cinnamon rolls, babka, pies, stollen + hot-drink pairings.`);
  else if (maxPop >= 30) tips.push(`🌦️ Showers possible (${maxPop}%) — keep grab-and-go stocked.`);
  else tips.push(`🌤️ Mild (${hi}°) — steady demand; feature seasonal favorites &amp; fresh bread.`);

  // 2) wind (only when notable)
  if (maxWind >= 20) tips.push(`💨 Windy (${maxWind} mph) — fewer browsers; tighten bake-ahead on perishables.`);

  // 3) day of week
  if (weekday === 'Sat' || weekday === 'Sun') tips.push(`🎉 Weekend — celebration sells: cakes, cupcakes, party trays, family packs.`);
  else if (weekday === 'Fri') tips.push(`🛒 Friday — weekend stock-up; bump breads, rolls &amp; cakes.`);

  // 4) time of day
  if (hour < 11) tips.push(`🌅 Morning — donuts, muffins, coffee cakes, croissants, fresh bread.`);
  else if (hour < 16) tips.push(`🍪 Afternoon — cookies, cupcakes, single-serve treats.`);
  else tips.push(`🌆 Evening — dinner breads + tonight's desserts.`);

  const top = tips.slice(0, 3);
  return `<div class="tip-head">💡 Sell tips</div><ul class="tip-list">${top.map((t) => `<li>${t}</li>`).join('')}</ul>`;
}

/* ---------------- UPC barcode scanner ----------------
 * On-device camera scan via ZXing (loaded from CDN). Works on iOS Safari and
 * Android Chrome over HTTPS (GitHub Pages) or localhost. Scans a UPC/EAN and
 * opens the matching product card. */
const ZXING_CDN = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm';

async function openScanner(mode = 'lookup', onCapture = null) {
  state.scan.mode = mode;
  state.scan.onCapture = onCapture;
  state.scan.lastCode = '';
  $('scanAddBtn').hidden = true;
  $('scanModal').hidden = false;
  setScanStatus('Starting camera…');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setScanStatus('Camera not supported on this device/browser.', 'err');
    return;
  }
  try {
    const { BrowserMultiFormatReader } = await import(ZXING_CDN);
    const reader = new BrowserMultiFormatReader();
    state.scan.active = true;
    setScanStatus(mode === 'capture' ? 'Scan a barcode to fill the UPC…' : 'Point the camera at a UPC barcode…');
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
  if (!code) return;
  // capture mode: hand the code back (e.g. to the editor's UPC field)
  if (state.scan.mode === 'capture') {
    state.scan.active = false;
    setScanStatus(`✓ ${code}`, 'ok');
    const cb = state.scan.onCapture;
    setTimeout(() => { closeScanner(); if (cb) cb(code); }, 300);
    return;
  }
  const match = state.byUpc.get(code);
  if (match) {
    setScanStatus(`✓ ${match.name}`, 'ok');
    state.scan.active = false;
    setTimeout(() => { closeScanner(); openSheet(match); }, 350);
  } else {
    // unknown barcode — offer to add it as a new item on the spot
    state.scan.lastCode = code;
    setScanStatus(`No product matches ${code}.`, 'err');
    $('scanAddBtn').hidden = false;
  }
}

function scanAddNew() {
  const code = state.scan.lastCode;
  closeScanner();
  openItemEditor(null);
  $('edUpc').value = code;
}

function closeScanner() {
  state.scan.active = false;
  state.scan.mode = 'lookup';
  state.scan.onCapture = null;
  try { state.scan.controls && state.scan.controls.stop(); } catch {}
  state.scan.controls = null;
  const v = $('scanVideo');
  if (v && v.srcObject) { v.srcObject.getTracks().forEach((t) => t.stop()); v.srcObject = null; }
  $('scanAddBtn').hidden = true;
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
  const tabs = [['browse', 'tabBrowse', 'browseView'], ['list', 'tabList', 'listView'], ['prod', 'tabProd', 'prodView']];
  for (const [name, tabId, viewId] of tabs) {
    const on = which === name;
    $(tabId).classList.toggle('active', on);
    $(tabId).setAttribute('aria-selected', String(on));
    $(viewId).hidden = !on;
  }
}

function wireEvents() {
  $('search').addEventListener('input', renderList);
  $('categoryFilter').addEventListener('change', renderList);
  $('pullDate').addEventListener('change', onPullDateChange);
  $('todayBtn').addEventListener('click', setToday);
  $('tabBrowse').addEventListener('click', () => switchTab('browse'));
  $('tabList').addEventListener('click', () => switchTab('list'));
  $('tabProd').addEventListener('click', () => switchTab('prod'));
  $('prodCopyBtn').addEventListener('click', copyProduction);
  $('prodClearBtn').addEventListener('click', clearProduction);
  $('sheetClose').addEventListener('click', closeSheet);
  $('sheetBackdrop').addEventListener('click', closeSheet);
  $('sheetAddBtn').addEventListener('click', () => { if (state.current) toggleList(state.current.name); });
  $('copyBtn').addEventListener('click', copyOrShare);
  $('clearBtn').addEventListener('click', clearList);
  $('wxRefresh').addEventListener('click', loadWeather);
  $('wxToggle').addEventListener('click', toggleWeather);
  $('wxChip').addEventListener('click', toggleWeather);
  $('scanFab').addEventListener('click', () => openScanner('lookup'));
  $('scanClose').addEventListener('click', closeScanner);
  $('scanAddBtn').addEventListener('click', scanAddNew);
  // item editor
  $('shelfEditBtn').addEventListener('click', () => { if (state.current) openItemEditor(state.current); });
  $('edScanUpc').addEventListener('click', () => openScanner('capture', (code) => { $('edUpc').value = code; }));
  $('addItemBtn').addEventListener('click', () => openItemEditor(null));
  $('holidayToggle').addEventListener('click', toggleHoliday);
  $('cakeToggle').addEventListener('click', toggleCake);
  $('edSave').addEventListener('click', saveItemEditor);
  $('edDelete').addEventListener('click', deleteItemEditor);
  $('edReset').addEventListener('click', resetItemEditor);
  $('edCancel').addEventListener('click', cancelItemEditor);
  $('editorClose').addEventListener('click', cancelItemEditor);
  $('editorBackdrop').addEventListener('click', cancelItemEditor);
  $('edPkg').addEventListener('change', (e) => { $('edDays').disabled = e.target.checked; });
  $('edHoliday').addEventListener('change', (e) => { $('edSeasonField').hidden = !e.target.checked; });
  // export / import
  $('exportBtn').addEventListener('click', exportCatalog);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => { if (e.target.files[0]) importCatalog(e.target.files[0]); e.target.value = ''; });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('scanModal').hidden) closeScanner();
    else if (!$('itemEditor').hidden) cancelItemEditor();
    else if (!$('sheet').hidden) closeSheet();
  });
}

/* ---------------- PIN lock screen ---------------- */
function setupLock() {
  const PIN = '1905';
  const lock = $('lockScreen');
  if (!lock) return;
  try { if (sessionStorage.getItem('rts.unlocked') === '1') { lock.hidden = true; return; } } catch {}
  let entered = '';
  const renderDots = () => {
    [...$('lockDots').children].forEach((d, i) => d.classList.toggle('on', i < entered.length));
  };
  function press(k) {
    if (k === 'del') { entered = entered.slice(0, -1); $('lockError').textContent = ''; renderDots(); return; }
    if (!/^[0-9]$/.test(k) || entered.length >= 4) return;
    entered += k; renderDots();
    if (entered.length < 4) return;
    if (entered === PIN) {
      try { sessionStorage.setItem('rts.unlocked', '1'); } catch {}
      lock.hidden = true;
    } else {
      $('lockError').textContent = 'Wrong PIN — try again';
      lock.classList.add('shake');
      setTimeout(() => { lock.classList.remove('shake'); entered = ''; renderDots(); }, 450);
    }
  }
  $('lockKeys').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (b) press(b.dataset.k);
  });
  document.addEventListener('keydown', (e) => {
    if (lock.hidden) return;
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') { e.preventDefault(); press('del'); }
  });
}

setupLock();
init();
