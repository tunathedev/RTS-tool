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
const LS_DISC = 'rts.hideDiscontinued';
const LS_PROD = 'rts.production.v1';
const LS_COMPBOX = 'rts.componentBox.v1';
const LS_LOGINIT = 'rts.logInitials';
const LS_PROFILES = 'rts.profiles.v1';
const LS_ME = 'rts.me';

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
  hideDisc: false,
  prod: {},           // production plan: id -> { make, done }
  compBox: {},        // component name -> items per box (for box-pull math)
  log: [],            // floor log entries: { id, ts, day, tag, by, note, img }
  profiles: {},       // people: id -> { id, name, emoji, color, pin, createdAt }
  me: null,           // the profile signed in on this device
  feed: {},           // shift feed posts: id -> { uid, name, emoji, color, type, text, photo?, ts, reactions }

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
  loadDiscPref();
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
  syncDiscBtn();
  loadWeather();
  initSync();
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
function saveCustomizations() { try { localStorage.setItem(LS_CUST, JSON.stringify(state.cust)); } catch {} pushSync('cust', state.cust); }

function effective(src, patch, key, isAdded) {
  const days = ('days' in patch) ? patch.days : src.days;
  return {
    name: patch.name ?? src.name,
    category: patch.category ?? src.category,
    days, pkgDate: days == null,
    freezerDays: ('freezerDays' in patch ? patch.freezerDays : src.freezerDays) || undefined,
    upc: ('upc' in patch ? patch.upc : src.upc) || '',
    plu: ('plu' in patch ? patch.plu : src.plu) || '',
    image: ('image' in patch ? patch.image : src.image) || undefined,
    par: ('par' in patch ? patch.par : src.par) || undefined,
    boxQty: ('boxQty' in patch ? patch.boxQty : src.boxQty) || undefined,
    table: ('table' in patch ? patch.table : src.table) || undefined,
    holiday: ('holiday' in patch ? patch.holiday : src.holiday) || false,
    seasonTable: ('seasonTable' in patch ? patch.seasonTable : src.seasonTable) || undefined,
    cakeSide: ('cakeSide' in patch ? patch.cakeSide : src.cakeSide) || false,
    discontinued: ('discontinued' in patch ? patch.discontinued : src.discontinued) || false,
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
  'Biscotti': 1, 'Danish/Donuts/Eclairs': 1, 'Muffins': 1, 'Mini Muffins': 1, 'Scones': 1, 'Loafs': 1,
  'Doughnut Holes': 3,
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

/* Holiday items live on a parallel set of Season Tables (by holiday). */
const SEASON_TABLES = [
  { n: 1, name: "Valentine's Day", emoji: '💝' },
  { n: 2, name: 'Easter', emoji: '🐰' },
  { n: 3, name: 'Halloween', emoji: '🎃' },
  { n: 4, name: 'Fall / Harvest', emoji: '🍂' },
  { n: 5, name: 'Christmas', emoji: '🎄' },
  { n: 6, name: 'Patriotic & Other', emoji: '🎉' },
];
const SEASON_NAME = Object.fromEntries(SEASON_TABLES.map((t) => [t.n, t.name]));
const SEASON_EMOJI = Object.fromEntries(SEASON_TABLES.map((t) => [t.n, t.emoji]));
function seasonFor(it) { return it.holiday ? (it.seasonTable || 1) : 0; }

/* Group like products together when sorting: detect each item's product type
 * (specific phrases first) so cheesecakes, crème cakes, cookies, breads, etc.
 * cluster within their category regardless of word order in the name. */
const TYPE_GROUPS = [
  'Donut Holes', 'Ice Cream Cake', 'Pound Cake', 'Ring Cake', 'Bundt Cake', 'Coffee Cake', 'Sheet Cake',
  'Crème Cake', 'Creme Cake', 'Cream Cake', 'Cake Pops', 'Cheesecake', 'Sliced Loaf', 'Pan de Polvo',
  'Brownie Bites', 'Pretzel Bites', 'Mini Cupcake', 'Mini Muffin', 'Cupcake', 'Muffin', 'Cookie',
  'Macaroon', 'Macaron', 'Danish', 'Eclair', 'Scone', 'Brioche', 'Ciabatta', 'Focaccia', 'Batard',
  'Sourdough', 'Bagel', 'Babka', 'Biscotti', 'Bunuelo', 'Mantecada', 'Granola', 'Stollen', 'Panettone',
  'Pretzel', 'Bun', 'Roll', 'Bread', 'Tiramisu', 'Shortcake', 'Blondie', 'Brookie', 'Madeleine',
  'Crescent', 'Tart', 'Pie', 'Pudding', 'Strudel', 'Bowl', 'Loaf', 'Brownie', 'Bites', 'Bar', 'Cake',
];
const TYPE_GROUPS_LC = TYPE_GROUPS.map((t) => t.toLowerCase());
// fallback: an item named without a type word sorts with its category's type
const CATEGORY_TYPE = {
  'Cookies': 'Cookie', 'Cakes': 'Cake', 'Decorated Cakes': 'Cake', 'Cheesecakes': 'Cheesecake',
  'Cupcakes': 'Cupcake', 'Muffins': 'Muffin', 'Mini Muffins': 'Mini Muffin', 'Macarons': 'Macaron',
  'Pies': 'Pie', 'Two Bite Items': 'Bites', 'Danish/Donuts/Eclairs': 'Danish', 'Scones': 'Scone',
  'Loafs': 'Loaf', 'Bread/Buns': 'Bread', 'Babka': 'Babka', 'Biscotti': 'Biscotti', 'Bunuelo': 'Bunuelo',
  'Granola': 'Granola', 'Stollen/Panettone': 'Stollen',
};
function typeIndexOf(it) {
  const u = ' ' + it.name.toLowerCase() + ' ';
  for (let i = 0; i < TYPE_GROUPS_LC.length; i++) if (u.includes(TYPE_GROUPS_LC[i])) return i;
  const fb = CATEGORY_TYPE[it.category];               // fall back to the category's type
  if (fb) { const j = TYPE_GROUPS_LC.indexOf(fb.toLowerCase()); if (j >= 0) return j; }
  return TYPE_GROUPS_LC.length;
}

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
  for (const it of list) { it._table = tableFor(it); it._season = seasonFor(it); it._typeIdx = typeIndexOf(it); }
  // everyday tables first (by table), then seasonal; within a category group
  // like products together (by product type), then by name
  list.sort((x, y) => {
    const hx = x.holiday ? 1 : 0, hy = y.holiday ? 1 : 0;
    if (hx !== hy) return hx - hy;
    const gx = x.holiday ? x._season : x._table, gy = y.holiday ? y._season : y._table;
    return gx - gy || order(x.category) - order(y.category)
      || x._typeIdx - y._typeIdx || x.name.localeCompare(y.name);
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
  renderFlip();
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
  renderFlip();
}
function syncCakeBtn() {
  const btn = $('cakeToggle');
  btn.classList.toggle('active', state.hideCake);
  btn.textContent = state.hideCake ? '🎂 Cake side: hidden' : '🎂 Cake side: shown';
}

function loadDiscPref() {
  let v = null; try { v = localStorage.getItem(LS_DISC); } catch {}
  state.hideDisc = v === null ? true : v === '1';   // default: discontinued hidden
}
function toggleDisc() {
  state.hideDisc = !state.hideDisc;
  try { localStorage.setItem(LS_DISC, state.hideDisc ? '1' : '0'); } catch {}
  syncDiscBtn();
  renderList();
  renderFlip();
}
function syncDiscBtn() {
  const btn = $('discToggle');
  btn.classList.toggle('active', state.hideDisc);
  btn.textContent = state.hideDisc ? '⛔ Discontinued: hidden' : '⛔ Discontinued: shown';
}

function refreshCatalog() {
  rebuildItems();
  buildCategoryFilter();
  buildCatDatalist();
  renderHeader();
  renderList();
  renderPullList();
  renderFlip();
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
    o.value = 's' + t.n; o.textContent = `${t.emoji} ${t.name}`;
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

/* Sticky thumbnails: reuse already-loaded <img> nodes across re-renders so
 * images never reload (or get dropped on a flaky HEB request). A node that has
 * loaded once is cached and moved into the new row instead of recreated. */
const thumbCache = new Map();
function thumbEl(url, cls) {
  const wrap = document.createElement('div');
  wrap.className = cls + (url ? '' : ' empty');
  if (url) {
    let img = thumbCache.get(url);
    if (!img) {
      img = new Image();
      img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
      img.addEventListener('load', () => thumbCache.set(url, img));
      img.addEventListener('error', () => { if (!thumbCache.has(url)) { wrap.classList.add('empty'); img.remove(); } });
      img.src = url;
    }
    wrap.appendChild(img);   // moving a cached (loaded) node does not reload it
  }
  return wrap;
}

/* ---------------- Browse list ---------------- */
function renderList() {
  const term = $('search').value.trim().toLowerCase();
  const tableFilter = $('categoryFilter').value;
  const seasonFilter = tableFilter.startsWith('s');
  const filterNum = seasonFilter ? parseInt(tableFilter.slice(1), 10) : parseInt(tableFilter, 10);
  const list = $('productList');
  list.innerHTML = '';
  const frag = document.createDocumentFragment();   // build off-DOM, append once
  let shown = 0, lastCat = null, lastGroup = null;

  for (const it of state.items) {
    // holiday toggle hides seasonal items (unless explicitly filtering a season)
    if (state.hideHoliday && it.holiday && !seasonFilter) continue;
    // cake-side items are hidden from the shelves when the toggle is on
    if (state.hideCake && it.cakeSide) continue;
    // discontinued items are hidden when the toggle is on
    if (state.hideDisc && it.discontinued) continue;
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
        th.innerHTML = `<span class="table-num">${SEASON_EMOJI[it._season] || '🎉'}</span> ${escapeHtml(SEASON_NAME[it._season] || 'Seasonal')}`;
      } else {
        th.className = 'table-header';
        th.innerHTML = `<span class="table-num">${it._table}</span> ${escapeHtml(TABLE_NAME[it._table] || 'Other')}`;
      }
      frag.appendChild(th); lastGroup = groupKey; lastCat = null;
    }
    if (it.category !== lastCat) {
      const h = document.createElement('div');
      h.className = 'cat-header'; h.textContent = it.category;
      frag.appendChild(h); lastCat = it.category;
    }

    const row = document.createElement('div');
    row.className = 'product-item' + (it.discontinued ? ' discontinued' : '') + (isHole(it.name) ? ' hole' : '');

    const tap = document.createElement('div');
    tap.className = 'tap';
    tap.innerHTML =
      `<div class="tap-text">
         <div class="name">${it.discontinued ? '⛔ ' : ''}${it.holiday ? (SEASON_EMOJI[it._season] || '🎉') + ' ' : ''}${it.cakeSide ? '🎂 ' : ''}${escapeHtml(it.name)}</div>
         <div class="meta">${it.pkgDate ? 'Follow package date' : 'Sell by ' + fmtDate(sellByFor(it))}${it.freezerDays ? ` · ❄️ ${it.freezerDays}d frozen` : ''}</div>
       </div>`;
    tap.insertBefore(thumbEl(it.image, 'product-thumb'), tap.firstChild);
    tap.addEventListener('click', () => isDesktop() ? openItemEditor(it) : openSheet(it));

    const badge = document.createElement('span');
    badge.className = 'badge' + (it.pkgDate ? ' pkg' : '');
    badge.textContent = it.pkgDate ? 'Pkg date' : it.days + 'd';

    const add = document.createElement('button');
    add.className = 'add-btn' + (inList(it.name) ? ' in' : '');
    add.dataset.name = it.name;
    add.textContent = inList(it.name) ? '✓' : '＋';
    add.setAttribute('aria-label', inList(it.name) ? 'Remove from pull list' : 'Add to pull list');
    add.title = 'Tap to add · press & hold to flag a hole';
    // tap = add/remove · press-and-hold = flag/clear a hole (fill first)
    let lpTimer = null, lpFired = false;
    const lpStart = () => {
      lpFired = false;
      lpTimer = setTimeout(() => { lpFired = true; try { navigator.vibrate && navigator.vibrate(30); } catch {} toggleHole(it.name); }, 500);
    };
    const lpCancel = () => { clearTimeout(lpTimer); };
    add.addEventListener('touchstart', lpStart, { passive: true });
    add.addEventListener('touchend', lpCancel);
    add.addEventListener('touchmove', lpCancel, { passive: true });
    add.addEventListener('mousedown', lpStart);
    add.addEventListener('mouseup', lpCancel);
    add.addEventListener('mouseleave', lpCancel);
    add.addEventListener('click', (e) => {
      e.stopPropagation();
      if (lpFired) { lpFired = false; return; }   // long-press already toggled the hole
      toggleList(it.name);
    });

    row.append(tap, badge, add);
    frag.appendChild(row);
    shown++;
  }
  list.appendChild(frag);

  if (shown === 0) list.innerHTML = `<div class="no-results">No products match “${escapeHtml(term)}”.</div>`;
  let filterLabel = '';
  if (tableFilter) filterLabel = seasonFilter ? ` · 🎄 ${SEASON_NAME[filterNum]}` : ` · Table ${filterNum} · ${TABLE_NAME[filterNum]}`;
  $('resultCount').textContent =
    `${shown} ${shown === 1 ? 'product' : 'products'}` + filterLabel;
}

function matches(it, term) {
  return it.name.toLowerCase().includes(term) || it.category.toLowerCase().includes(term)
    || (TABLE_NAME[it._table] || '').toLowerCase().includes(term)
    || (it.plu && String(it.plu).includes(term)) || (it.upc && String(it.upc).includes(term));
}

const isDesktop = () => window.matchMedia('(min-width: 720px)').matches;

/* ---------------- Detail sheet ---------------- */
function openSheet(it) {
  state.current = it;
  $('detailCategory').textContent = it.category;
  $('detailName').textContent = it.name;
  $('hebLink').href = HEB_SEARCH(hebQuery(it.name));

  renderShelf(it);
  renderFreezerLife(it);
  renderUpc(it);
  renderPar(it);
  renderSheetResult(it);
  updateSheetAddBtn();
  loadImage(it);

  $('sheetBackdrop').hidden = false;
  $('sheet').hidden = false;
}

function renderFreezerLife(it) {
  const el = $('detailFreezer');
  if (!it.freezerDays) { el.innerHTML = ''; return; }
  const useBy = addDays(getPullDate(), it.freezerDays);
  el.innerHTML = `❄️ Freezer life: <strong>${it.freezerDays} days</strong> · if frozen on this date, use by <strong>${fmtDate(useBy)}</strong>`;
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

function openItemEditor(it, fromSheet) {
  editorKey = it ? it._key : null;
  editorFromSheet = !!fromSheet;
  // when opened from the detail sheet, hide it so the two don't overlap
  if (fromSheet && it) { state.current = it; $('sheet').hidden = true; $('sheetBackdrop').hidden = true; }
  $('editorTitle').textContent = it ? 'Edit item' : 'Add item';
  const par = (it && it.par) || {};
  $('edName').value = it ? it.name : '';
  $('edCategory').value = it ? it.category : '';
  $('edTable').value = it && it.table ? String(it.table) : '';
  $('edUpc').value = it ? (it.upc || '') : '';
  $('edPlu').value = it ? (it.plu || '') : '';
  $('edBox').value = it && it.boxQty ? it.boxQty : '';
  $('edImage').value = it ? (it.image || '') : '';
  $('edTall').value = par.tall || ''; $('edWide').value = par.wide || ''; $('edDeep').value = par.deep || '';
  $('edHoliday').checked = it ? !!it.holiday : false;
  $('edSeason').value = it && it.seasonTable ? String(it.seasonTable) : '1';
  $('edSeasonField').hidden = !$('edHoliday').checked;
  $('edCake').checked = it ? !!it.cakeSide : false;
  $('edDisc').checked = it ? !!it.discontinued : false;
  const pkg = it ? it.pkgDate : false;
  $('edPkg').checked = pkg;
  $('edDays').value = it && !pkg ? it.days : '';
  $('edDays').disabled = pkg;
  $('edFreezer').value = it && it.freezerDays ? it.freezerDays : '';
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
    plu: $('edPlu').value.trim(),
    image: $('edImage').value.trim(),
    boxQty: box || null,
    par: (tall || wide || deep) ? { tall, wide, deep } : null,
    holiday: $('edHoliday').checked,
    seasonTable: $('edHoliday').checked ? (parseInt($('edSeason').value, 10) || 1) : null,
    cakeSide: $('edCake').checked,
    discontinued: $('edDisc').checked,
    days: pkg ? null : days,
    freezerDays: pos('edFreezer') || null,
  };
}

// Persist the current editor fields without closing (used for auto-save).
function commitEditor() {
  if ($('itemEditor').hidden) return false;
  const f = readEditor(); if (!f) return false;   // needs a name first
  if (editorKey) {
    const added = state.cust.added.find((a) => a._key === editorKey);
    if (added) Object.assign(added, f, { pkgDate: f.days == null });
    else state.cust.patches[editorKey] = f;
  } else {
    // first valid save of a new item — create it, then keep editing the same item
    editorKey = 'a:' + (f.upc ? 'u' + f.upc : Date.now().toString(36) + Math.floor(Math.random() * 1e4));
    state.cust.added.push(Object.assign({ _key: editorKey }, f, { pkgDate: f.days == null }));
    $('edDelete').style.display = '';
    $('editorTitle').textContent = 'Edit item';
  }
  saveCustomizations();
  refreshCatalog();
  return true;
}

let autoSaveTimer = null;
function scheduleAutoSave() { clearTimeout(autoSaveTimer); autoSaveTimer = setTimeout(commitEditor, 350); }

function saveItemEditor() {
  commitEditor();
  const key = editorKey;
  closeItemEditor();
  const updated = state.items.find((i) => i._key === key);
  if (editorFromSheet && updated) openSheet(updated);
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
      if (i.freezerDays) o.freezerDays = i.freezerDays;
      if (i.upc) o.upc = i.upc;
      if (i.plu) o.plu = i.plu;
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
  $('detailPlu').innerHTML = it.plu
    ? `<span class="plu-tag">PLU ${escapeHtml(String(it.plu))}</span>`
    : '';
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
  const hole = isHole(it.name);
  const hb = $('sheetHoleBtn');
  hb.textContent = hole ? '🕳️ Hole flagged — tap to clear' : '🕳️ Flag as hole (fill first)';
  hb.classList.toggle('on', hole);
}

/* ---------------- Pull list ---------------- */
function loadPullList() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    // keep only items that still exist in the dataset
    state.pull = saved.filter((p) => state.byName.has(p.name))
      .map((p) => ({ name: p.name, qty: Math.max(1, p.qty | 0 || 1), done: !!p.done, labels: !!p.labels, hole: !!p.hole }));
  } catch { state.pull = []; }
}
function savePullList() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state.pull)); } catch {}
  pushSync('pull', state.pull);
}
function inList(name) { return state.pull.some((p) => p.name === name); }

function toggleList(name) {
  const i = state.pull.findIndex((p) => p.name === name);
  if (i >= 0) state.pull.splice(i, 1);
  else state.pull.push({ name, qty: 1, done: false, labels: false });
  savePullList();
  updateAddButton(name);   // just flip this row's button — don't rebuild Browse (keeps photos)
  renderPullList();
  syncCremeProduction();
  updateSheetAddBtn();
}

function isHole(name) { const p = state.pull.find((x) => x.name === name); return !!(p && p.hole); }

// Flag/unflag a product as a "hole" (empty floor spot). Flagging adds it to the
// pull list so holes get filled first; unflagging leaves it in the list.
function toggleHole(name) {
  let p = state.pull.find((x) => x.name === name);
  if (p) { p.hole = !p.hole; }
  else { p = { name, qty: 1, done: false, labels: false, hole: true }; state.pull.push(p); }
  savePullList();
  updateAddButton(name);   // in-place so a long-press isn't interrupted by a full re-render
  updateHoleRow(name);
  renderPullList();
  syncCremeProduction();
  updateSheetAddBtn();
}

// toggle just the 🕳️ marker on a Browse row without rebuilding the list
function updateHoleRow(name) {
  const hole = isHole(name);
  for (const b of document.querySelectorAll('#productList .add-btn')) {
    if (b.dataset.name === name) { const row = b.closest('.product-item'); if (row) row.classList.toggle('hole', hole); }
  }
}

// update the +/✓ state of a Browse row's add button without re-rendering the list
function updateAddButton(name) {
  const inIt = inList(name);
  for (const b of document.querySelectorAll('#productList .add-btn')) {
    if (b.dataset.name === name) {
      b.className = 'add-btn' + (inIt ? ' in' : '');
      b.textContent = inIt ? '✓' : '＋';
      b.setAttribute('aria-label', inIt ? 'Remove from pull list' : 'Add to pull list');
    }
  }
}

// boxes needed for a quantity given items-per-box
function boxesFor(it, qty) {
  return it && it.boxQty ? Math.ceil(qty / it.boxQty) : null;
}
// a "Half ___" item is a whole cake cut in half — 2 halves per whole to pull
function isHalfItem(it) { return /^half\b/i.test(it.name); }
function wholesForHalf(qty) { return Math.ceil(qty / 2); }

/* Pulling half crème cakes triggers the matching "Sliced Half Crème Cakes"
 * production (you slice whole cakes to make the halves). Pull qty drives the
 * production make-count for that flavor. */
const HALF_PROD_MAP = [
  [/banana nut/i, 'cake-banananut'],
  [/marble/i, 'cake-marble'],
  [/lemon/i, 'cake-lemon'],
  [/strawberry/i, 'cake-strawberry'],
  [/triple chocolate|chocolate/i, 'cake-triplechoc'],
  [/sock it/i, 'cake-sockit'],
];
function prodIdForHalf(name) { for (const [re, id] of HALF_PROD_MAP) if (re.test(name)) return id; return null; }
function syncCremeProduction() {
  const sums = {};
  for (const p of state.pull) {
    const it = state.byName.get(p.name);
    if (it && isHalfItem(it)) { const id = prodIdForHalf(it.name); if (id) sums[id] = (sums[id] || 0) + p.qty; }
  }
  let changed = false;
  for (const cake of PRODUCTION) {
    if (!cake.cake) continue;
    const want = sums[cake.id] || 0;
    const rec = state.prod[cake.id] || { make: 0, done: false };
    if (rec.make !== want) { rec.make = want; if (!want) rec.done = false; state.prod[cake.id] = rec; changed = true; }
  }
  if (changed) { saveProduction(); renderProduction(); }
}

function setQty(name, delta) {
  const p = state.pull.find((x) => x.name === name);
  if (!p) return;
  p.qty = Math.max(1, p.qty + delta);
  savePullList();
  renderPullList();
  syncCremeProduction();
}

function toggleDone(name) {
  const p = state.pull.find((x) => x.name === name);
  if (!p) return;
  p.done = !p.done;
  savePullList();
  renderPullList();
  // narrate to the feed when the whole floor is set (once per completion)
  const n = state.pull.length, done = state.pull.filter((x) => x.done).length;
  if (n > 0 && done === n) { if (!floorSetAnnounced) { floorSetAnnounced = true; autoPost(`✅ set the floor — ${n} item${n === 1 ? '' : 's'} pulled`); } }
  else floorSetAnnounced = false;
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
  syncCremeProduction();
}

function pullDivider(text) {
  const d = document.createElement('div');
  d.className = 'pull-divider';
  d.textContent = text;
  return d;
}

function renderPullList() {
  const n = state.pull.length;
  $('listCount').textContent = n;
  $('pullListEmpty').hidden = n > 0;
  $('pullListWrap').hidden = n === 0;
  if (!$('freezerView').hidden) renderFreezer();   // keep freezer mode in sync
  if (n === 0) return;

  const ordered = state.items.filter((it) => inList(it.name));
  const totalQty = state.pull.reduce((s, p) => s + p.qty, 0);
  const doneCount = state.pull.filter((p) => p.done).length;
  const labeledCount = state.pull.filter((p) => p.labels).length;
  let totalBoxes = 0, boxKnown = false, totalWholes = 0;
  for (const it of ordered) {
    const p = state.pull.find((x) => x.name === it.name);
    if (isHalfItem(it)) { totalWholes += wholesForHalf(p.qty); continue; }
    const b = boxesFor(it, p.qty);
    if (b != null) { totalBoxes += b; boxKnown = true; }
  }
  const pct = n ? Math.round((doneCount / n) * 100) : 0;
  $('pullSummary').innerHTML =
    `<div class="pull-progress-top">
       <strong>${doneCount} of ${n} pulled</strong>
       <span>${fmtDate(getPullDate())}</span>
     </div>
     <div class="pull-bar"><span style="width:${pct}%"></span></div>
     <div class="pull-progress-sub">${totalQty} to pull` +
    (boxKnown ? ` · ${totalBoxes} box${totalBoxes === 1 ? '' : 'es'}` : '') +
    (totalWholes ? ` · ${totalWholes} whole${totalWholes === 1 ? '' : 's'} to cut` : '') +
    `</div>`;

  const wrap = $('pullItems');
  wrap.innerHTML = '';
  const isHolePend = (it) => { const p = state.pull.find((x) => x.name === it.name); return !!(p && p.hole && !p.done); };
  const holes = ordered.filter(isHolePend);
  const rest = ordered.filter((it) => !isHolePend(it));
  let didHoleHdr = false, didRestHdr = false;
  for (const it of [...holes, ...rest]) {
    const p = state.pull.find((x) => x.name === it.name);
    const hole = isHolePend(it);
    if (holes.length) {
      if (hole && !didHoleHdr) { didHoleHdr = true; wrap.appendChild(pullDivider('🕳️ Fill first — empty spots')); }
      if (!hole && !didRestHdr) { didRestHdr = true; wrap.appendChild(pullDivider('Then pull')); }
    }
    const row = document.createElement('div');
    row.className = 'pull-item' + (p.done ? ' done' : '') + (p.labels ? ' labeled' : '') + (hole ? ' hole' : '');

    const sell = it.pkgDate
      ? `<span class="pull-date pkg">Pkg date</span>`
      : (() => { const sb = sellByFor(it); const { cls } = freshness(sb);
                 return `<span class="pull-date ${cls}">${fmtDate(sb)}</span>`; })();
    const boxes = boxesFor(it, p.qty);
    const meta = isHalfItem(it)
      ? `🍰 cut ${wholesForHalf(p.qty)} whole${wholesForHalf(p.qty) === 1 ? '' : 's'}`
      : boxes != null
      ? `${boxes} box${boxes === 1 ? '' : 'es'}`
      : '';

    row.innerHTML = `
      <button type="button" class="pull-check-btn" aria-label="Mark pulled" aria-pressed="${p.done}">${p.done ? '✓' : ''}</button>
      <div class="pull-body">
        <div class="pull-row-top">
          <span class="pull-name">${hole ? '🕳️ ' : ''}${escapeHtml(it.name)}${it.plu ? ` <span class="plu-tag">PLU ${escapeHtml(String(it.plu))}</span>` : ''}</span>
          <span class="pull-date-wrap">sell by ${sell}</span>
        </div>
        <div class="pull-row-ctl">
          <span class="qty">
            <button type="button" data-act="dec" aria-label="Decrease quantity">−</button>
            <span class="qty-n">${p.qty}</span>
            <button type="button" data-act="inc" aria-label="Increase quantity">+</button>
          </span>
          ${meta ? `<span class="pull-meta">${meta}</span>` : ''}
          <button type="button" class="pull-hole-chip${hole ? ' on' : ''}" aria-pressed="${hole}">🕳️ Hole</button>
          <button type="button" class="pull-label-chip${p.labels ? ' on' : ''}" aria-pressed="${p.labels}">🏷 ${p.labels ? 'Labeled' : 'Label'}</button>
          <button type="button" class="remove-btn" aria-label="Remove from list">🗑️</button>
        </div>
      </div>`;

    row.querySelector('.pull-check-btn').addEventListener('click', () => toggleDone(it.name));
    row.querySelector('.pull-hole-chip').addEventListener('click', () => toggleHole(it.name));
    row.querySelector('.pull-label-chip').addEventListener('click', () => toggleLabels(it.name));
    row.querySelector('[data-act="dec"]').addEventListener('click', () => setQty(it.name, -1));
    row.querySelector('[data-act="inc"]').addEventListener('click', () => setQty(it.name, +1));
    row.querySelector('.remove-btn').addEventListener('click', () => toggleList(it.name));
    wrap.appendChild(row);
  }
}

/* ---------------- Freezer Mode ----------------
 * Full-screen, glove-friendly pull checklist for standing at the freezer:
 * giant item names, a big check target per row, nothing easy to miss-tap.
 * Remaining items sit on top; pulled ones sink to the bottom, dimmed. */
function openFreezer() {
  if (!state.pull.length) return;
  $('freezerView').hidden = false;
  document.body.classList.add('freezer-open');
  renderFreezer();
}
function closeFreezer() { $('freezerView').hidden = true; document.body.classList.remove('freezer-open'); }

function renderFreezer() {
  const ordered = state.items.filter((it) => inList(it.name));
  const pullOf = (it) => state.pull.find((x) => x.name === it.name) || { qty: 1, done: false };
  const n = ordered.length;
  const done = ordered.filter((it) => pullOf(it).done).length;
  const pct = n ? Math.round((done / n) * 100) : 0;
  $('freezerCount').textContent = `${done}/${n}`;
  $('freezerBar').style.width = pct + '%';

  const list = $('freezerList');
  if (!n) { list.innerHTML = '<div class="fz-empty">Pull list is empty.</div>'; return; }
  if (done === n) {
    list.innerHTML = '<div class="fz-alldone"><div class="fz-alldone-emoji">✅</div>All pulled — nice work!<br><span>Tap Exit to head back.</span></div>';
    return;
  }
  const holeOf = (it) => { const p = state.pull.find((x) => x.name === it.name); return !!(p && p.hole && !p.done); };
  const fzCard = (it) => {
    const p = pullOf(it);
    const card = document.createElement('div');
    card.className = 'fz-card' + (p.done ? ' done' : '') + (holeOf(it) ? ' hole' : '');
    const sub = it.pkgDate ? 'Pkg date' : 'Sell by ' + fmtDate(sellByFor(it));
    card.innerHTML =
      `<div class="fz-qty">×${p.qty}</div>
       <div class="fz-info">
         <div class="fz-name">${holeOf(it) ? '🕳️ ' : ''}${escapeHtml(it.name)}</div>
         <div class="fz-sub">${sub}${it.plu ? ` · PLU ${escapeHtml(String(it.plu))}` : ''}</div>
       </div>
       <button type="button" class="fz-check${p.done ? ' on' : ''}" aria-label="${p.done ? 'Mark not pulled' : 'Mark pulled'}">${p.done ? '✓' : ''}</button>`;
    card.querySelector('.fz-check').addEventListener('click', () => {
      try { if (navigator.vibrate) navigator.vibrate(25); } catch {}
      toggleDone(it.name);   // re-renders the freezer via renderPullList
    });
    return card;
  };

  const frag = document.createDocumentFragment();
  // holes first — empty spots to fill before walking the freezer
  const holes = ordered.filter(holeOf);
  if (holes.length) {
    const h = document.createElement('div');
    h.className = 'fz-section fill';
    h.innerHTML = `<span class="fz-section-name">🕳️ Fill first — empty spots</span><span class="fz-section-count">${holes.length}</span>`;
    frag.appendChild(h);
    for (const it of holes) frag.appendChild(fzCard(it));
  }
  // then walk the freezer in table/section order; pulled items dim in place
  const walk = ordered.filter((it) => !holeOf(it));
  const counts = new Map();
  for (const it of walk) {
    const k = freezerGroupKey(it); const c = counts.get(k) || { t: 0, d: 0 };
    c.t++; if (pullOf(it).done) c.d++; counts.set(k, c);
  }
  let lastKey = null;
  for (const it of walk) {
    const k = freezerGroupKey(it);
    if (k !== lastKey) {
      lastKey = k;
      const c = counts.get(k);
      const h = document.createElement('div');
      h.className = 'fz-section' + (c.d === c.t ? ' done' : '');
      h.innerHTML = `<span class="fz-section-name">🧊 ${escapeHtml(freezerGroupLabel(it))}</span><span class="fz-section-count">${c.d}/${c.t}</span>`;
      frag.appendChild(h);
    }
    frag.appendChild(fzCard(it));
  }
  list.innerHTML = '';
  list.appendChild(frag);
}
function freezerGroupKey(it) { return it.holiday ? 's' + it._season : 't' + it._table; }
function freezerGroupLabel(it) {
  if (it.holiday) return (SEASON_EMOJI[it._season] || '🎉') + ' ' + (SEASON_NAME[it._season] || 'Seasonal');
  return 'Table ' + it._table + ' · ' + (TABLE_NAME[it._table] || 'Other');
}

function pullListText() {
  const lines = [`Pull List — pulled ${fmtDate(getPullDate())}`];
  const ordered = state.items.filter((it) => inList(it.name));
  let totalBoxes = 0, boxKnown = false, totalWholes = 0;
  for (const it of ordered) {
    const p = state.pull.find((x) => x.name === it.name);
    const sb = it.pkgDate ? 'pkg date' : 'sell by ' + fmtDate(sellByFor(it));
    let extra = '';
    if (isHalfItem(it)) { const w = wholesForHalf(p.qty); totalWholes += w; extra = ` (cut ${w} whole${w === 1 ? '' : 's'})`; }
    else { const b = boxesFor(it, p.qty); if (b != null) { totalBoxes += b; boxKnown = true; extra = ` (${b} box${b === 1 ? '' : 'es'})`; } }
    lines.push(`[${p.done ? 'x' : ' '}] ${p.qty}x ${it.name} — ${sb}${extra}`);
  }
  if (boxKnown) lines.push(`Total: ${totalBoxes} box${totalBoxes === 1 ? '' : 'es'}`);
  if (totalWholes) lines.push(`Whole cakes to cut: ${totalWholes}`);
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
// recipe component { n: name, q: pieces per platter (0 = count TBD) }
const PRODUCTION = [
  { id: 'plt-doughnut', group: 'Platters', name: 'Donut Holes Tray', price: 11.98, note: '~80 holes',
    recipe: [{ n: 'Glazed donut holes', q: 27 }, { n: 'Chocolate donut holes', q: 27 }, { n: 'Powdered donut holes', q: 26 }] },
  { id: 'plt-cookie', group: 'Platters', name: 'Assorted Cookie Tray (36 ct)', price: 11.98,
    recipe: [{ n: 'Oatmeal cookies', q: 9 }, { n: 'Sugar cookies', q: 9 }, { n: 'Chocolate candy cookies', q: 9 }, { n: 'Chocolate chunk cookies', q: 9 }] },
  { id: 'plt-cookiebrownie', group: 'Platters', name: 'Cookies & Brownie Bites Tray', price: 15.98,
    recipe: [{ n: 'Oatmeal cookies', q: 6 }, { n: 'Sugar cookies', q: 6 }, { n: 'Chocolate candy cookies', q: 6 }, { n: 'Chocolate chunk cookies', q: 6 }, { n: 'Brownie bites', q: 28 }] },
  { id: 'plt-loaf', group: 'Platters', name: 'Sliced Loaf Cake Tray', price: 11.98,
    recipe: [{ n: 'Marble loaf slices', q: 0 }, { n: 'Lemon loaf slices', q: 0 }, { n: 'Danish loaf slices', q: 0 }] },
  { id: 'plt-pdp-half', group: 'Mexican Pastries', name: 'Pan de Polvo Tray — Half & Half (48 oz)', price: 15.98, note: '3 lb',
    recipe: [{ n: 'Cinnamon pan de polvo', q: 0 }, { n: 'Powdered sugar pan de polvo', q: 0 }] },
  { id: 'plt-pdp-cinn', group: 'Mexican Pastries', name: 'Pan de Polvo Tray — Cinnamon (48 oz)', price: 15.98, note: '3 lb',
    recipe: [{ n: 'Cinnamon pan de polvo', q: 0 }] },
  { id: 'plt-mantecada-6', group: 'Mexican Pastries', name: 'Mantecada Cupcakes (6 ct)', note: '6 ct',
    recipe: [{ n: 'Mantecada cupcakes', q: 6 }] },
  { id: 'plt-mantecada-15', group: 'Mexican Pastries', name: 'Mantecada Cupcakes (15 ct)', price: 8.98, note: '15 ct',
    recipe: [{ n: 'Mantecada cupcakes', q: 15 }] },
  { id: 'cake-marble', group: 'Sliced Half Creme Cakes', name: 'Marble', cake: true },
  { id: 'cake-lemon', group: 'Sliced Half Creme Cakes', name: 'Lemon', cake: true },
  { id: 'cake-strawberry', group: 'Sliced Half Creme Cakes', name: 'Strawberry', cake: true },
  { id: 'cake-banananut', group: 'Sliced Half Creme Cakes', name: 'Banana Nut', cake: true },
  { id: 'cake-triplechoc', group: 'Sliced Half Creme Cakes', name: 'Triple Chocolate', cake: true },
  { id: 'cake-sockit', group: 'Sliced Half Creme Cakes', name: 'Sock It To Me', cake: true },
];

function loadProduction() {
  try { state.prod = JSON.parse(localStorage.getItem(LS_PROD) || '{}') || {}; } catch { state.prod = {}; }
  try { state.compBox = JSON.parse(localStorage.getItem(LS_COMPBOX) || '{}') || {}; } catch { state.compBox = {}; }
}
function saveProduction() { try { localStorage.setItem(LS_PROD, JSON.stringify(state.prod)); } catch {} pushSync('prod', state.prod); }
function saveCompBox() { try { localStorage.setItem(LS_COMPBOX, JSON.stringify(state.compBox)); } catch {} pushSync('compBox', state.compBox); }
function setCompBox(name) {
  const cur = state.compBox[name] || '';
  const v = prompt(`How many "${name}" come per box (case pack)?`, cur);
  if (v === null) return;
  const n = parseInt(v, 10);
  if (Number.isFinite(n) && n > 0) state.compBox[name] = n; else delete state.compBox[name];
  saveCompBox(); renderProduction();
}
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

function recipeSummary(it) {
  if (it.cake) return 'sliced half creme cake';
  const parts = (it.recipe || []).map((c) => (c.q ? c.q + ' ' : '') + c.n.replace(/ (cookies|donut holes|pan de polvo|loaf slices|cupcakes)$/i, ''));
  return parts.join(' · ') + (it.price ? ` · $${it.price.toFixed(2)}` : '') + (it.note ? ` · ${it.note}` : '');
}

function renderProduction() {
  updateProdCount();
  const wrap = $('prodItems');
  wrap.innerHTML = '';
  let lastGroup = null;
  let totalPlatters = 0, totalHalves = 0, doneCount = 0, planned = 0;
  const prep = new Map();      // component name -> total pieces
  const tbd = [];              // platters whose piece counts aren't set yet
  let wholesToSlice = 0;

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
      if (it.cake) { totalHalves += p.make; wholesToSlice += Math.ceil(p.make / 2); }
      else {
        totalPlatters += p.make;
        let anyTbd = false;
        for (const c of (it.recipe || [])) {
          if (c.q > 0) prep.set(c.n, (prep.get(c.n) || 0) + c.q * p.make);
          else anyTbd = true;
        }
        if (anyTbd) tbd.push(`${p.make}× ${it.name}`);
      }
    }
    const sub = it.cake
      ? (p.make > 0 ? `${p.make} halves · slice ${Math.ceil(p.make / 2)} whole${Math.ceil(p.make / 2) === 1 ? '' : 's'}` : 'sliced half creme cake')
      : recipeSummary(it);

    const row = document.createElement('div');
    row.className = 'pull-item' + (p.done ? ' done' : '');
    row.innerHTML = `
      <input type="checkbox" class="pull-check" ${p.done ? 'checked' : ''} ${p.make ? '' : 'disabled'} aria-label="Mark produced" />
      <div class="pull-main">
        <div class="pull-name">${escapeHtml(it.name)}</div>
        <div class="pull-sub">${escapeHtml(sub)}${it.cake && p.make > 0 ? ' <span class="from-pull">↳ from pull list</span>' : ''}</div>
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

  // Prep totals (component rollup) + box-pull math
  const prepEl = $('prodPrep');
  if (!prep.size && !wholesToSlice && !tbd.length) { prepEl.innerHTML = ''; return; }
  let totalBoxes = 0, anyBox = false;
  const rows = [...prep.entries()].sort((a, b) => b[1] - a[1]).map(([n, q]) => {
    const box = state.compBox[n];
    let boxHtml;
    if (box) {
      const boxes = Math.ceil(q / box);
      totalBoxes += boxes; anyBox = true;
      boxHtml = `<button type="button" class="prep-box known" data-comp="${escapeHtml(n)}">📦 ${boxes} box${boxes === 1 ? '' : 'es'} <small>(${box}/bx)</small></button>`;
    } else {
      boxHtml = `<button type="button" class="prep-box" data-comp="${escapeHtml(n)}">📦 set box</button>`;
    }
    return `<div class="prep-row"><span class="prep-name">${escapeHtml(n)}</span><span class="prep-qty"><b>${q}</b></span>${boxHtml}</div>`;
  });
  if (wholesToSlice) rows.push(`<div class="prep-row"><span class="prep-name">Creme cake wholes to slice</span><span class="prep-qty"><b>${wholesToSlice}</b></span><span class="prep-box-spacer"></span></div>`);
  let html = `<div class="prep-head">🧾 Prep totals — bake / portion / pull</div>${rows.join('')}`;
  if (anyBox) html += `<div class="prep-total-boxes"><span>Total boxes to pull</span><b>${totalBoxes}</b></div>`;
  if (tbd.length) html += `<div class="prep-tbd">Piece counts TBD: ${escapeHtml(tbd.join(', '))}</div>`;
  prepEl.innerHTML = html;
  prepEl.querySelectorAll('.prep-box').forEach((b) => b.addEventListener('click', () => setCompBox(b.dataset.comp)));

  // Packaging — one container + one date label per finished platter/tray/half
  const packEl = $('prodPack');
  const units = totalPlatters + totalHalves;
  packEl.innerHTML = units === 0 ? '' :
    `<div class="prep-head pack">📦 Packaging</div>
     <div class="prep-row"><span class="prep-name">Containers needed</span><span class="prep-qty"><b>${units}</b></span></div>
     <div class="prep-row"><span class="prep-name">Labels needed</span><span class="prep-qty"><b>${units}</b></span></div>
     <div class="prep-tbd">${totalPlatters} platter/tray${totalPlatters === 1 ? '' : 's'} · ${totalHalves} cake half${totalHalves === 1 ? '' : 'ves'} — 1 container &amp; 1 label each</div>`;
}

function productionText() {
  const lines = [`Production plan — ${fmtDate(stripTime(new Date()))}`];
  let lastGroup = null;
  const prep = new Map(); let wholes = 0;
  for (const it of PRODUCTION) {
    const p = state.prod[it.id] || { make: 0 };
    if (!p.make) continue;
    if (it.group !== lastGroup) { lines.push(`-- ${it.group} --`); lastGroup = it.group; }
    const extra = it.cake ? ` (slice ${Math.ceil(p.make / 2)})` : '';
    lines.push(`[${p.done ? 'x' : ' '}] ${p.make}x ${it.name}${extra}`);
    if (it.cake) wholes += Math.ceil(p.make / 2);
    else for (const c of (it.recipe || [])) if (c.q > 0) prep.set(c.n, (prep.get(c.n) || 0) + c.q * p.make);
  }
  if (lines.length === 1) return 'Production plan is empty.';
  if (prep.size || wholes) {
    lines.push('', 'Prep totals:');
    let totalBoxes = 0;
    [...prep.entries()].sort((a, b) => b[1] - a[1]).forEach(([n, q]) => {
      const box = state.compBox[n];
      const b = box ? Math.ceil(q / box) : 0;
      if (b) totalBoxes += b;
      lines.push(`  ${n}: ${q}${box ? ` (${b} box)` : ''}`);
    });
    if (wholes) lines.push(`  Creme cake wholes to slice: ${wholes}`);
    if (totalBoxes) lines.push(`  TOTAL BOXES TO PULL: ${totalBoxes}`);
  }
  let units = 0;
  for (const it of PRODUCTION) units += (state.prod[it.id] || {}).make || 0;
  if (units) { lines.push('', `Containers needed: ${units}`, `Labels needed: ${units}`); }
  return lines.join('\n');
}
async function copyProduction() {
  const text = productionText();
  try { if (navigator.share) { await navigator.share({ title: 'Production plan', text }); return; } } catch {}
  try { await navigator.clipboard.writeText(text); flashBtn($('prodCopyBtn'), '✓ Copied'); }
  catch { prompt('Copy your production plan:', text); }
}

/* ---------------- Flip Book (by shelf-life days) ---------------- */
let flipKey = null;   // current page: a day count (number) or 'pkg'

function flipPages() {
  const groups = new Map();
  for (const it of state.items) {
    if (state.hideHoliday && it.holiday) continue;
    if (state.hideCake && it.cakeSide) continue;
    if (state.hideDisc && it.discontinued) continue;
    const key = it.pkgDate ? 'pkg' : it.days;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const keys = [...groups.keys()].filter((k) => k !== 'pkg').sort((a, b) => a - b);
  if (groups.has('pkg')) keys.push('pkg');
  return { groups, keys };
}

function updateFlipBadge() {
  const n = flipPages().keys.length;
  const b = $('flipBadge');
  b.textContent = n;
  b.hidden = n === 0;
}

function renderFlip() {
  updateFlipBadge();                  // keep the floating-button count fresh even when closed
  if ($('flipView').hidden) return;   // overlay closed — it re-renders on open
  const { groups, keys } = flipPages();
  if (!keys.length) {
    $('flipCard').innerHTML = '<div class="flip-empty">No products to show.</div>';
    $('flipStrip').innerHTML = ''; $('flipPulled').textContent = '';
    return;
  }
  if (flipKey === null || !groups.has(flipKey)) flipKey = keys[0];

  $('flipStrip').innerHTML = keys.map((k) =>
    `<button type="button" class="flip-day${k === flipKey ? ' active' : ''}" data-k="${k}">${k === 'pkg' ? 'Pkg' : k + 'd'}</button>`
  ).join('');

  const items = groups.get(flipKey).slice().sort((a, b) => a.name.localeCompare(b.name));
  let head;
  if (flipKey === 'pkg') {
    head = `<div class="flip-daynum">Pkg date</div><div class="flip-date pkg">Follow printed<br>package date</div>`;
  } else {
    const sb = addDays(getPullDate(), flipKey);
    head = `<div class="flip-daynum">${flipKey}-day shelf life</div>
            <div class="flip-sub">Sell by</div>
            <div class="flip-weekday">${weekdayShort(sb)}</div>
            <div class="flip-date">${mmdd(sb)}</div>`;
  }
  $('flipCard').innerHTML =
    `${head}
     <div class="flip-count">${items.length} item${items.length === 1 ? '' : 's'}</div>
     <ul class="flip-list">${items.map((it) => `<li>${escapeHtml(it.name)}${it.plu ? ` <span class="plu-tag">PLU ${escapeHtml(String(it.plu))}</span>` : ''}</li>`).join('')}</ul>`;
  $('flipPulled').textContent = 'Pulled ' + mmdd(getPullDate());
}

function flipBy(delta) {
  const { keys } = flipPages();
  if (!keys.length) return;
  let i = keys.indexOf(flipKey);
  if (i < 0) i = 0;
  i = (i + delta + keys.length) % keys.length;   // wrap around
  flipKey = keys[i];
  renderFlip();
}

/* ---------------- Floor Log (arrive / leave proof photos) ----------------
 * Flexible photo log: each shot is tagged Arrive (the floor we inherited) or
 * Leave (how we set it), with initials + optional note + a burned-in date/time
 * stamp. Photos are compressed to ~100KB and stored per-entry under rts/log in
 * Firebase, loaded only when the log opens so the main app stays fast. */
const TAG_META = { arrive: { emoji: '🌅', label: 'Arrive' }, leave: { emoji: '🌇', label: 'Leave' } };
let logLoaded = false;        // fetched this session?
let logPendingLoad = false;   // opened before sync was ready
let captureTag = 'leave';     // which button launched the camera

function openFloorLog() {
  $('logView').hidden = false;
  document.body.classList.add('log-open');
  try { $('logInitials').value = state.me ? initialsOf(state.me.name) : (localStorage.getItem(LS_LOGINIT) || ''); } catch {}
  loadFloorLog();
  renderFloorLog();
}
function closeFloorLog() { $('logView').hidden = true; document.body.classList.remove('log-open'); }

function loadFloorLog() {
  if (!sync.on) { logPendingLoad = true; return; }   // retried once sync connects
  if (logLoaded) return;
  logLoaded = true;
  try {
    sync.mod.get(sync.mod.ref(sync.db, 'rts/log')).then((snap) => {
      mergeFloorLog(snap.val()); renderFloorLog();
    }).catch(() => {});
  } catch {}
}
function mergeFloorLog(obj) {
  if (!obj || typeof obj !== 'object') return;
  const seen = new Set(state.log.map((e) => e.id));
  for (const e of Object.values(obj)) {
    if (e && e.id && !seen.has(e.id)) { state.log.push(e); seen.add(e.id); }
  }
  state.log.sort((a, b) => b.ts - a.ts);   // newest first
}

function logStamp(tag, d, by) {
  const t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${(TAG_META[tag] || {}).label || ''}`.toUpperCase() + ` · ${monthDay(d)} ${t}` + (by ? ` · ${by}` : '');
}

// Downscale to ~1080px wide, burn in the stamp, export as a small JPEG data URL.
function processPhoto(file, text) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const ow = img.naturalWidth || 1080, oh = img.naturalHeight || 1080;
      const scale = Math.min(1, 1080 / ow);
      const w = Math.round(ow * scale), h = Math.round(oh * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const fs = Math.max(18, Math.round(w * 0.04));
      const barH = Math.round(fs * 1.9);
      ctx.fillStyle = 'rgba(0,0,0,.58)';
      ctx.fillRect(0, h - barH, w, barH);
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${fs}px Inter, Archivo, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, Math.round(w * 0.03), h - barH / 2);
      try { resolve(c.toDataURL('image/jpeg', 0.6)); } catch (e) { reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('load failed')); };
    img.src = url;
  });
}

function startCapture(tag) {
  captureTag = tag;
  const by = ($('logInitials').value || '').trim().toUpperCase();
  try { localStorage.setItem(LS_LOGINIT, by); } catch {}
  $('logFile').value = '';
  $('logFile').click();
}

async function onLogFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const d = new Date();
  const by = ($('logInitials').value || '').trim().toUpperCase();
  try { localStorage.setItem(LS_LOGINIT, by); } catch {}
  const note = ($('logNote').value || '').trim();
  $('logHint').textContent = 'Processing photo…';
  let img;
  try { img = await processPhoto(file, logStamp(captureTag, d, by)); }
  catch { $('logHint').textContent = 'Could not read that photo — try again.'; return; }
  const id = d.getTime().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  const entry = { id, ts: d.getTime(), day: toISO(d), tag: captureTag, by, note, img };
  state.log.unshift(entry);
  $('logNote').value = '';
  $('logHint').textContent = sync.on ? 'Saved ✓' : '⚠︎ Saved on this device — will upload when sync connects.';
  if (sync.on) { try { sync.mod.set(sync.mod.ref(sync.db, 'rts/log/' + id), entry); } catch {} }
  renderFloorLog();
  const tm = TAG_META[captureTag] || {};
  autoPost(`${tm.emoji || '📸'} logged the ${tm.label || ''} floor photo`);
}

function deleteLogEntry(id) {
  if (!confirm('Delete this photo from the log?')) return;
  state.log = state.log.filter((e) => e.id !== id);
  if (sync.on) { try { sync.mod.set(sync.mod.ref(sync.db, 'rts/log/' + id), null); } catch {} }
  renderFloorLog();
}

function renderFloorLog() {
  const tl = $('logTimeline');
  if (!sync.on && !state.log.length) {
    tl.innerHTML = '<div class="log-empty">📷 No photos yet.<br>Connect to global sync, then tag your first Arrive / Leave shot.</div>';
    return;
  }
  if (!state.log.length) {
    tl.innerHTML = '<div class="log-empty">📷 No photos yet.<br>Tag the floor when you arrive and when you leave — your before/after proof builds up here.</div>';
    return;
  }
  // group by day (already sorted newest-first)
  const days = [];
  const byDay = new Map();
  for (const e of state.log) {
    if (!byDay.has(e.day)) { byDay.set(e.day, []); days.push(e.day); }
    byDay.get(e.day).push(e);
  }
  const frag = document.createDocumentFragment();
  for (const day of days) {
    const entries = byDay.get(day);
    const hasA = entries.some((e) => e.tag === 'arrive');
    const hasL = entries.some((e) => e.tag === 'leave');
    const dd = parseISO(day) || new Date(entries[0].ts);
    const head = document.createElement('div');
    head.className = 'log-day-head';
    head.innerHTML = `<span class="log-day-date">${weekdayShort(dd)} · ${monthDay(dd)}</span>` +
      `<span class="log-day-right">
         <span class="log-day-flags">${hasA && hasL ? '<span class="log-complete">✅ before &amp; after</span>'
           : hasA ? '<span class="log-partial">🌅 arrive only</span>'
           : '<span class="log-partial">🌇 leave only</span>'}</span>
         <button type="button" class="log-share-day" aria-label="Share before/after">📤 Share</button>
       </span>`;
    head.querySelector('.log-share-day').addEventListener('click', () => shareDay(day));
    frag.appendChild(head);

    const cols = document.createElement('div');
    cols.className = 'log-cols';
    for (const tag of ['arrive', 'leave']) {
      const col = document.createElement('div');
      col.className = 'log-col';
      col.innerHTML = `<div class="log-col-label ${tag}">${TAG_META[tag].emoji} ${TAG_META[tag].label}</div>`;
      const shots = entries.filter((e) => e.tag === tag);
      if (!shots.length) col.insertAdjacentHTML('beforeend', '<div class="log-col-empty">—</div>');
      for (const e of shots) {
        const card = document.createElement('div');
        card.className = 'log-shot';
        const t = new Date(e.ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        card.innerHTML =
          `<img loading="lazy" src="${e.img}" alt="${TAG_META[tag].label} ${escapeHtml(e.day)}" />
           <div class="log-shot-meta">
             <span class="log-shot-by">${e.by ? escapeHtml(e.by) + ' · ' : ''}${t}</span>
             <button type="button" class="log-del" aria-label="Delete photo">🗑️</button>
           </div>
           ${e.note ? `<div class="log-shot-note">${escapeHtml(e.note)}</div>` : ''}`;
        card.querySelector('img').addEventListener('click', () => openPhoto(e.img));
        card.querySelector('.log-del').addEventListener('click', () => deleteLogEntry(e.id));
        col.appendChild(card);
      }
      cols.appendChild(col);
    }
    frag.appendChild(cols);
  }
  tl.innerHTML = '';
  tl.appendChild(frag);
}

/* Auto-build a side-by-side before/after image for a day and share/save it.
 * Uses the latest Arrive + latest Leave shot; the date stamps are already
 * burned into each photo, so the composite is a ready-to-send proof sheet. */
function loadImgEl(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}
async function buildDayComposite(day) {
  const entries = state.log.filter((e) => e.day === day);
  const latest = (tag) => entries.filter((e) => e.tag === tag).sort((a, b) => b.ts - a.ts)[0];
  const picks = [latest('arrive'), latest('leave')].filter(Boolean);
  if (!picks.length) return null;
  const imgs = await Promise.all(picks.map((e) => loadImgEl(e.img)));
  const hw = 720, headerH = 86;
  const scaled = imgs.map((im) => ({ im, w: hw, h: Math.round(im.naturalHeight * (hw / im.naturalWidth)) }));
  const bodyH = Math.max(...scaled.map((s) => s.h));
  const c = document.createElement('canvas');
  c.width = hw * scaled.length; c.height = headerH + bodyH;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#E31837'; ctx.fillRect(0, 0, c.width, headerH);
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
  ctx.font = '800 40px Archivo, Inter, sans-serif';
  const dd = parseISO(day) || new Date(picks[0].ts);
  ctx.fillText(`RTS Floor · ${weekdayShort(dd)} ${monthDay(dd)}`, 26, headerH / 2);
  let x = 0;
  for (const s of scaled) { ctx.drawImage(s.im, x, headerH, s.w, s.h); x += hw; }
  return c.toDataURL('image/jpeg', 0.72);
}
async function shareDay(day) {
  let url = null;
  try { url = await buildDayComposite(day); } catch {}
  if (!url) { alert('No photos to share for that day yet.'); return; }
  try {
    const blob = await (await fetch(url)).blob();
    const file = new File([blob], `rts-floor-${day}.jpg`, { type: 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: `RTS Floor ${day}` });
      return;
    }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = url; a.download = `rts-floor-${day}.jpg`;
  document.body.appendChild(a); a.click(); a.remove();
}

/* fullscreen photo viewer with share/save */
let viewerSrc = null;
function openPhoto(src) { viewerSrc = src; $('photoImg').src = src; $('photoViewer').hidden = false; }
function closePhoto() { $('photoViewer').hidden = true; $('photoImg').src = ''; viewerSrc = null; }
async function sharePhoto() {
  if (!viewerSrc) return;
  try {
    const blob = await (await fetch(viewerSrc)).blob();
    const file = new File([blob], 'rts-floor.jpg', { type: 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'RTS floor' });
      return;
    }
  } catch {}
  // fallback: download
  const a = document.createElement('a');
  a.href = viewerSrc; a.download = 'rts-floor.jpg';
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------------- Shift Feed (async team communication) ----------------
 * Posts live under rts/feed/{id} (live-subscribed). Each post carries the
 * author's identity denormalized so it renders without a lookup. Types:
 * note / handoff / props, plus 'auto' posts the app writes to narrate wins. */
const LS_FEEDREAD = 'rts.feedRead';
const FEED_REACTS = ['👍', '❤️', '🔥', '👏'];
const FEED_TYPE = { note: '📝 Note', handoff: '🤝 Handoff', props: '🎉 Props', auto: '' };
let feedType = 'note';
let feedPhotoData = null;
let floorSetAnnounced = false;

function onFeed(val) {
  state.feed = val || {};
  if (!$('feedView').hidden) renderFeed();
  updateFeedBadge();
}
function feedPosts() { return Object.values(state.feed).sort((a, b) => b.ts - a.ts); }
function updateFeedBadge() {
  let last = 0; try { last = +localStorage.getItem(LS_FEEDREAD) || 0; } catch {}
  const meId = state.me && state.me.id;
  const n = feedPosts().filter((p) => p.ts > last && p.uid !== meId).length;
  const b = $('feedBadge'); if (!b) return;
  b.textContent = n > 9 ? '9+' : n; b.hidden = n === 0;
}
function markFeedRead() {
  const posts = feedPosts();
  const max = posts.length ? posts[0].ts : Date.now();
  try { localStorage.setItem(LS_FEEDREAD, String(max)); } catch {}
  updateFeedBadge();
}
function openFeed() {
  $('feedView').hidden = false; document.body.classList.add('feed-open');
  renderFeed(); markFeedRead();
  setTimeout(() => $('feedText').focus(), 80);
}
function closeFeed() { $('feedView').hidden = true; document.body.classList.remove('feed-open'); }

function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return m + 'm';
  const h = Math.round(m / 60); if (h < 24) return h + 'h';
  return Math.round(h / 24) + 'd';
}
function renderFeed() {
  const tl = $('feedTimeline');
  const posts = feedPosts();
  if (!posts.length) {
    tl.innerHTML = '<div class="feed-empty">💬 No posts yet.<br>Leave a note, a handoff, or props for the team.</div>';
    return;
  }
  const meId = state.me && state.me.id;
  const frag = document.createDocumentFragment();
  for (const p of posts) {
    const card = document.createElement('div');
    card.className = 'feed-post' + (p.type === 'auto' ? ' auto' : '') + (p.type === 'props' ? ' props' : '');
    const badge = FEED_TYPE[p.type] ? `<span class="feed-type-badge ${p.type}">${FEED_TYPE[p.type]}</span>` : '';
    const reacts = FEED_REACTS.map((e) => {
      const users = (p.reactions && p.reactions[e]) || {};
      const n = Object.keys(users).length;
      const mine = meId && users[meId];
      return `<button type="button" class="feed-react${mine ? ' mine' : ''}" data-e="${e}">${e}${n ? ' ' + n : ''}</button>`;
    }).join('');
    card.innerHTML =
      `<span class="feed-av" style="background:${p.color || 'var(--heb)'}">${p.emoji || '🙂'}</span>
       <div class="feed-body">
         <div class="feed-meta"><b>${escapeHtml(p.name || 'Someone')}</b> ${badge} <time>${timeAgo(p.ts)}</time></div>
         ${p.text ? `<div class="feed-text">${escapeHtml(p.text)}</div>` : ''}
         ${p.photo ? `<img class="feed-img" loading="lazy" src="${p.photo}" alt="" />` : ''}
         <div class="feed-reacts">${reacts}</div>
       </div>`;
    if (p.photo) card.querySelector('.feed-img').addEventListener('click', () => openPhoto(p.photo));
    card.querySelectorAll('.feed-react').forEach((b) => b.addEventListener('click', () => toggleReaction(p.id, b.dataset.e)));
    frag.appendChild(card);
  }
  tl.innerHTML = ''; tl.appendChild(frag);
}

function newPostId() { return 'p_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }
function writeFeed(post) {
  state.feed[post.id] = post;                 // optimistic
  if (sync.on) { try { sync.mod.set(sync.mod.ref(sync.db, 'rts/feed/' + post.id), post); } catch {} }
}
function submitPost() {
  const text = ($('feedText').value || '').trim();
  if (!text && !feedPhotoData) return;
  if (!state.me) { alert('Pick your profile first (tap your avatar).'); return; }
  const p = state.me;
  const post = { id: newPostId(), uid: p.id, name: p.name, emoji: p.emoji, color: p.color, type: feedType, ts: Date.now() };
  if (text) post.text = text;
  if (feedPhotoData) post.photo = feedPhotoData;
  writeFeed(post);
  $('feedText').value = ''; feedPhotoData = null; $('feedPhotoPreview').hidden = true; $('feedPhotoPreview').innerHTML = '';
  setFeedType('note');
  renderFeed(); markFeedRead();
}
// app-written posts that narrate wins (attributed to the current user)
function autoPost(text) {
  if (!state.me || !sync.on) return;
  const p = state.me;
  writeFeed({ id: newPostId(), uid: p.id, name: p.name, emoji: p.emoji, color: p.color, type: 'auto', text, ts: Date.now() });
  if (!$('feedView').hidden) renderFeed();
  updateFeedBadge();
}
function toggleReaction(postId, emoji) {
  const post = state.feed[postId]; if (!post || !state.me) return;
  post.reactions = post.reactions || {};
  const map = post.reactions[emoji] = post.reactions[emoji] || {};
  if (map[state.me.id]) delete map[state.me.id]; else map[state.me.id] = true;
  const val = Object.keys(map).length ? map : null;
  if (!val) delete post.reactions[emoji];
  if (sync.on) { try { sync.mod.set(sync.mod.ref(sync.db, 'rts/feed/' + postId + '/reactions/' + emoji), val); } catch {} }
  renderFeed();
}
function setFeedType(t) {
  feedType = t;
  $('feedTypes').querySelectorAll('.feed-type').forEach((b) => b.classList.toggle('on', b.dataset.type === t));
}
async function onFeedFile(e) {
  const file = e.target.files && e.target.files[0]; if (!file) return;
  try { feedPhotoData = await compressPhoto(file); } catch { return; }
  const pv = $('feedPhotoPreview');
  pv.hidden = false;
  pv.innerHTML = `<img src="${feedPhotoData}" alt=""/><button type="button" class="feed-photo-x" aria-label="Remove photo">✕</button>`;
  pv.querySelector('.feed-photo-x').addEventListener('click', () => { feedPhotoData = null; pv.hidden = true; pv.innerHTML = ''; });
}
function compressPhoto(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const ow = img.naturalWidth || 1000, oh = img.naturalHeight || 1000;
      const s = Math.min(1, 1000 / ow), w = Math.round(ow * s), h = Math.round(oh * s);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      try { res(c.toDataURL('image/jpeg', 0.6)); } catch (err) { rej(err); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('load')); };
    img.src = url;
  });
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
  renderFlip();
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
function monthDay(d) { return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function mmdd(d) { const z = (n) => String(n).padStart(2, '0'); return `${z(d.getMonth() + 1)}/${z(d.getDate())}`; }
function weekdayShort(d) { return d.toLocaleDateString(undefined, { weekday: 'short' }); }

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
  // entering the Pull List with items waiting jumps straight into Freezer Mode
  if (which === 'list' && state.pull.length && $('freezerView').hidden) openFreezer();
}

/* Flip Book lives in a floating overlay (button stacked above Scan) */
function openFlip() { $('flipView').hidden = false; document.body.classList.add('flip-open'); renderFlip(); }
function closeFlip() { $('flipView').hidden = true; document.body.classList.remove('flip-open'); }

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
  // flip book overlay: open from floating button, close from header
  $('flipFab').addEventListener('click', openFlip);
  $('flipClose').addEventListener('click', closeFlip);
  // floor log overlay
  $('logFab').addEventListener('click', openFloorLog);
  $('logClose').addEventListener('click', closeFloorLog);
  $('logView').querySelectorAll('.log-cap').forEach((b) => b.addEventListener('click', () => startCapture(b.dataset.tag)));
  $('logFile').addEventListener('change', onLogFile);
  $('photoClose').addEventListener('click', closePhoto);
  $('photoShare').addEventListener('click', sharePhoto);
  // flip book navigation
  $('flipPrev').addEventListener('click', () => flipBy(-1));
  $('flipNext').addEventListener('click', () => flipBy(1));
  $('flipStrip').addEventListener('click', (e) => {
    const b = e.target.closest('.flip-day'); if (!b) return;
    flipKey = b.dataset.k === 'pkg' ? 'pkg' : parseInt(b.dataset.k, 10);
    renderFlip();
  });
  let fx = 0;
  $('flipCard').addEventListener('touchstart', (e) => { fx = e.changedTouches[0].clientX; }, { passive: true });
  $('flipCard').addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - fx;
    if (Math.abs(dx) > 50) flipBy(dx < 0 ? 1 : -1);
  }, { passive: true });
  $('sheetClose').addEventListener('click', closeSheet);
  $('sheetBackdrop').addEventListener('click', closeSheet);
  $('sheetAddBtn').addEventListener('click', () => { if (state.current) toggleList(state.current.name); });
  $('sheetHoleBtn').addEventListener('click', () => { if (state.current) toggleHole(state.current.name); });
  $('copyBtn').addEventListener('click', copyOrShare);
  $('clearBtn').addEventListener('click', clearList);
  $('a2hsClose').addEventListener('click', dismissInstall);
  $('a2hsInstall').addEventListener('click', doInstall);
  $('freezerBtn').addEventListener('click', openFreezer);
  $('freezerExit').addEventListener('click', closeFreezer);
  // shift feed
  $('feedBtn').addEventListener('click', openFeed);
  $('feedClose').addEventListener('click', closeFeed);
  $('feedSend').addEventListener('click', submitPost);
  $('feedText').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitPost(); } });
  $('feedTypes').addEventListener('click', (e) => { const b = e.target.closest('.feed-type'); if (b) setFeedType(b.dataset.type); });
  $('feedPhoto').addEventListener('click', () => { $('feedFile').value = ''; $('feedFile').click(); });
  $('feedFile').addEventListener('change', onFeedFile);
  $('wxRefresh').addEventListener('click', loadWeather);
  $('wxToggle').addEventListener('click', toggleWeather);
  $('wxChip').addEventListener('click', toggleWeather);
  $('scanFab').addEventListener('click', () => openScanner('lookup'));
  $('scanClose').addEventListener('click', closeScanner);
  $('scanAddBtn').addEventListener('click', scanAddNew);
  // item editor
  $('shelfEditBtn').addEventListener('click', () => { if (state.current) openItemEditor(state.current, true); });
  $('edScanUpc').addEventListener('click', () => openScanner('capture', (code) => { $('edUpc').value = code; commitEditor(); }));
  $('addItemBtn').addEventListener('click', () => openItemEditor(null));
  $('holidayToggle').addEventListener('click', toggleHoliday);
  $('cakeToggle').addEventListener('click', toggleCake);
  $('discToggle').addEventListener('click', toggleDisc);
  // flush any pending (coalesced) sync writes before the app is backgrounded/closed
  window.addEventListener('pagehide', flushAllPush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAllPush(); });
  $('edSave').addEventListener('click', saveItemEditor);
  $('edDelete').addEventListener('click', deleteItemEditor);
  $('edReset').addEventListener('click', resetItemEditor);
  $('edCancel').addEventListener('click', cancelItemEditor);
  $('editorClose').addEventListener('click', cancelItemEditor);
  $('editorBackdrop').addEventListener('click', cancelItemEditor);
  $('edPkg').addEventListener('change', (e) => { $('edDays').disabled = e.target.checked; commitEditor(); });
  $('edHoliday').addEventListener('change', (e) => { $('edSeasonField').hidden = !e.target.checked; commitEditor(); });
  // auto-save edits as you type / change
  ['edName', 'edCategory', 'edUpc', 'edPlu', 'edBox', 'edImage', 'edTall', 'edWide', 'edDeep', 'edDays', 'edFreezer']
    .forEach((id) => $(id).addEventListener('input', scheduleAutoSave));
  ['edTable', 'edSeason', 'edCake', 'edDisc'].forEach((id) => $(id).addEventListener('change', commitEditor));
  // export / import
  $('exportBtn').addEventListener('click', exportCatalog);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => { if (e.target.files[0]) importCatalog(e.target.files[0]); e.target.value = ''; });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('photoViewer').hidden) closePhoto();
    else if (!$('feedView').hidden) closeFeed();
    else if (!$('freezerView').hidden) closeFreezer();
    else if (!$('scanModal').hidden) closeScanner();
    else if (!$('itemEditor').hidden) cancelItemEditor();
    else if (!$('sheet').hidden) closeSheet();
    else if (!$('flipView').hidden) closeFlip();
    else if (!$('logView').hidden) closeFloorLog();
  });
}

/* ---------------- PIN lock screen ---------------- */
/* ---------------- Profiles & login ---------------- */
const ACCENTS = ['#E31837', '#2563eb', '#00857C', '#7c3aed', '#ea580c', '#16a34a', '#db2777', '#0891b2', '#475569', '#ca8a04'];
const AVATARS = ['🤠', '🧑‍🍳', '🥖', '🧁', '🍰', '🍩', '🥐', '🎂', '🌮', '☕', '🌟', '🔥', '🦸', '🐺', '😎', '🚀'];

function loadProfiles() {
  try { state.profiles = JSON.parse(localStorage.getItem(LS_PROFILES) || '{}') || {}; } catch { state.profiles = {}; }
}
function saveProfiles(fromRemote) {
  try { localStorage.setItem(LS_PROFILES, JSON.stringify(state.profiles)); } catch {}
  if (!fromRemote) pushSync('profiles', state.profiles);
}
function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

// header identity + personal accent (accent touches only; HEB red stays the brand)
function applyMe() {
  const p = state.me;
  const root = document.documentElement.style;
  const av = $('meAvatar');
  if (p) {
    root.setProperty('--me', p.color);
    av.hidden = false; av.textContent = p.emoji || initialsOf(p.name); av.style.background = p.color;
    $('howdy').innerHTML = `Howdy, <b>${escapeHtml(p.name)}</b>!`;
    try { localStorage.setItem(LS_ME, p.id); } catch {}
    const li = $('logInitials'); if (li && !li.value) li.value = initialsOf(p.name);
  } else {
    root.removeProperty('--me');
    av.hidden = true;
    $('howdy').textContent = '🤠 Howdy, Partner!';
  }
}

let loginMode = 'login';   // 'login' | 'create'
let loginTarget = null;    // profile being unlocked
let loginDraft = null;     // { name, emoji, color } during create
let pinEntered = '';

function showLockScreen(id) { for (const s of ['lockRoster', 'lockSetup', 'lockPin']) $(s).hidden = (s !== id); }
function renderRoster() {
  const list = Object.values(state.profiles).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  $('rosterGrid').innerHTML = list.map((p) =>
    `<button type="button" class="roster-tile" data-id="${p.id}">
       <span class="roster-av" style="background:${p.color}">${p.emoji || initialsOf(p.name)}</span>
       <span class="roster-name">${escapeHtml(p.name)}</span>
     </button>`).join('');
}
function openRoster() {
  if (!Object.keys(state.profiles).length) { openSetup(); return; }
  renderRoster(); showLockScreen('lockRoster');
}
function openSetup() {
  loginDraft = { name: '', emoji: AVATARS[0], color: ACCENTS[0] };
  $('setupName').value = ''; $('setupError').textContent = '';
  $('emojiGrid').innerHTML = AVATARS.map((e) => `<button type="button" class="emoji-opt${e === loginDraft.emoji ? ' on' : ''}" data-e="${e}">${e}</button>`).join('');
  $('colorGrid').innerHTML = ACCENTS.map((c) => `<button type="button" class="color-opt${c === loginDraft.color ? ' on' : ''}" data-c="${c}" style="background:${c}" aria-label="color"></button>`).join('');
  showLockScreen('lockSetup');
  setTimeout(() => $('setupName').focus(), 60);
}
function beginPin(mode, p) {
  loginMode = mode; pinEntered = ''; loginTarget = mode === 'login' ? p : null;
  $('pinWho').innerHTML = `<span class="pin-av" style="background:${p.color}">${p.emoji || initialsOf(p.name)}</span> ${escapeHtml(p.name)}`;
  $('pinPrompt').textContent = mode === 'login' ? 'Enter your PIN' : 'Create a 4-digit PIN';
  $('lockError').textContent = ''; renderDots(); showLockScreen('lockPin');
}
function renderDots() { [...$('lockDots').children].forEach((d, i) => d.classList.toggle('on', i < pinEntered.length)); }
function pinPress(k) {
  if (k === 'del') { pinEntered = pinEntered.slice(0, -1); $('lockError').textContent = ''; renderDots(); return; }
  if (!/^[0-9]$/.test(k) || pinEntered.length >= 4) return;
  pinEntered += k; renderDots();
  if (pinEntered.length < 4) return;
  if (loginMode === 'login') {
    if (pinEntered === loginTarget.pin) loginSuccess(loginTarget);
    else pinError('Wrong PIN — try again');
  } else {
    const id = 'u_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    const prof = { id, name: loginDraft.name, emoji: loginDraft.emoji, color: loginDraft.color, pin: pinEntered, createdAt: Date.now() };
    state.profiles[id] = prof; saveProfiles();
    loginSuccess(prof);
  }
}
function pinError(msg) {
  $('lockError').textContent = msg;
  $('lockScreen').classList.add('shake');
  setTimeout(() => { $('lockScreen').classList.remove('shake'); pinEntered = ''; renderDots(); }, 450);
}
function loginSuccess(profile) {
  state.me = profile; applyMe();
  try { sessionStorage.setItem('rts.unlocked', '1'); } catch {}
  $('lockScreen').hidden = true;
  setTimeout(maybeShowInstall, 1200);
}
function switchUser() {
  try { sessionStorage.removeItem('rts.unlocked'); } catch {}
  pinEntered = ''; $('lockScreen').hidden = false; openRoster();
}

function setupLock() {
  const lock = $('lockScreen'); if (!lock) return;
  loadProfiles();
  $('lockKeys').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) pinPress(b.dataset.k); });
  $('pinBack').addEventListener('click', openRoster);
  $('rosterNew').addEventListener('click', openSetup);
  $('setupBack').addEventListener('click', openRoster);
  $('rosterGrid').addEventListener('click', (e) => {
    const t = e.target.closest('.roster-tile'); if (!t) return;
    const p = state.profiles[t.dataset.id]; if (p) beginPin('login', p);
  });
  $('emojiGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.emoji-opt'); if (!b) return;
    loginDraft.emoji = b.dataset.e;
    [...$('emojiGrid').children].forEach((x) => x.classList.toggle('on', x === b));
  });
  $('colorGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.color-opt'); if (!b) return;
    loginDraft.color = b.dataset.c;
    [...$('colorGrid').children].forEach((x) => x.classList.toggle('on', x === b));
  });
  $('setupNext').addEventListener('click', () => {
    const name = $('setupName').value.trim();
    if (!name) { $('setupError').textContent = 'Enter your name'; return; }
    loginDraft.name = name; beginPin('create', loginDraft);
  });
  $('meAvatar').addEventListener('click', switchUser);
  document.addEventListener('keydown', (e) => {
    if (lock.hidden || $('lockPin').hidden) return;
    if (/^[0-9]$/.test(e.key)) pinPress(e.key);
    else if (e.key === 'Backspace') { e.preventDefault(); pinPress('del'); }
  });

  let meId = null, unlocked = false;
  try { meId = localStorage.getItem(LS_ME); } catch {}
  try { unlocked = sessionStorage.getItem('rts.unlocked') === '1'; } catch {}
  if (unlocked && meId && state.profiles[meId]) {
    state.me = state.profiles[meId]; applyMe();
    lock.hidden = true; setTimeout(maybeShowInstall, 1200); return;
  }
  applyMe();
  openRoster();
}

/* ---------------- Global sync (optional · Firebase Realtime DB) ----------------
 * Off by default. Add your Firebase config in sync-config.js to enable live
 * sync of the catalog, pull list, production plan and case-pack sizes across
 * all devices. Until then everything stays device-only (localStorage). */
const sync = { on: false, applying: false, mod: null, db: null, seen: new Set(), last: {}, timers: {}, pending: {} };
const SYNC_PATHS = ['cust', 'pull', 'prod', 'compBox', 'profiles'];

function setSyncStatus(t, level) {
  const el = $('syncStatus'); if (el) el.textContent = t;
  const pill = $('syncPill'); if (!pill) return;
  const map = { connecting: ['Connecting…', 'amber'], on: ['Synced', 'on'], error: ['Sync error', 'error'] };
  const [label, cls] = map[level] || ['', ''];
  pill.textContent = label;
  pill.className = 'sync-pill' + (cls ? ' ' + cls : '');
  pill.hidden = !label;
}
function localOf(p) { return p === 'cust' ? state.cust : p === 'pull' ? state.pull : p === 'prod' ? state.prod : p === 'profiles' ? state.profiles : state.compBox; }
function asArr(d) { return Array.isArray(d) ? d : (d && typeof d === 'object' ? Object.values(d) : []); }

// coalesce rapid writes per path (e.g. +/- qty bursts) into one network write
function pushSync(path, value, force) {
  if (!sync.on || (sync.applying && !force)) return;
  const v = value == null ? null : value;
  sync.pending[path] = v;
  sync.last[path] = JSON.stringify(v);
  if (force) { flushPush(path); return; }
  clearTimeout(sync.timers[path]);
  sync.timers[path] = setTimeout(() => flushPush(path), 300);
}
function flushPush(path) {
  if (!sync.on || !(path in sync.pending)) return;
  clearTimeout(sync.timers[path]); delete sync.timers[path];
  const v = sync.pending[path]; delete sync.pending[path];
  try { sync.mod.set(sync.mod.ref(sync.db, 'rts/' + path), { data: v, ts: Date.now() }); } catch {}
}
function flushAllPush() { for (const p of Object.keys(sync.pending)) flushPush(p); }

function onRemote(path, wrapper) {
  const first = !sync.seen.has(path); sync.seen.add(path);
  if (wrapper == null) { if (first) pushSync(path, localOf(path), true); return; } // seed cloud from this device
  const data = wrapper.data;
  if (data == null) return;
  // skip our own echo / no-op updates to avoid redundant re-renders
  const incoming = JSON.stringify(data);
  if (incoming === sync.last[path] || incoming === JSON.stringify(localOf(path))) return;
  sync.applying = true;
  try {
    if (path === 'cust') {
      state.cust = { patches: data.patches || {}, added: asArr(data.added), deleted: asArr(data.deleted) };
      saveCustomizations(); rebuildItems(); buildCategoryFilter(); buildCatDatalist(); renderHeader(); renderList(); renderPullList();
    } else if (path === 'pull') {
      state.pull = asArr(data); savePullList(); renderPullList(); renderList();
    } else if (path === 'prod') {
      state.prod = data || {}; saveProduction(); renderProduction();
    } else if (path === 'compBox') {
      state.compBox = data || {}; saveCompBox(); renderProduction();
    } else if (path === 'profiles') {
      // remote wins on shared ids, but keep any local-only profile (e.g. just created)
      state.profiles = Object.assign({}, state.profiles, data || {});
      saveProfiles(true);
      if (state.me && state.profiles[state.me.id]) { state.me = state.profiles[state.me.id]; applyMe(); }
      if (!$('lockScreen').hidden) renderRoster();
      const cloudKeys = Object.keys(data || {});
      if (Object.keys(state.profiles).some((k) => !cloudKeys.includes(k))) setTimeout(() => pushSync('profiles', state.profiles), 50);
    }
  } finally { sync.applying = false; }
}

async function initSync() {
  const cfg = window.SYNC_CONFIG;
  if (!cfg || !cfg.databaseURL) { setSyncStatus('', 'off'); return; }
  setSyncStatus('☁︎ connecting…', 'connecting');
  try {
    const appMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
    const authMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
    const dbMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js');
    const app = appMod.initializeApp(cfg);
    await authMod.signInAnonymously(authMod.getAuth(app));   // rules require a signed-in token
    sync.db = dbMod.getDatabase(app); sync.mod = dbMod; sync.on = true;
    for (const p of SYNC_PATHS) dbMod.onValue(dbMod.ref(sync.db, 'rts/' + p), (snap) => onRemote(p, snap.val()));
    dbMod.onValue(dbMod.ref(sync.db, 'rts/feed'), (snap) => onFeed(snap.val()));   // live shift feed
    if (logPendingLoad && !$('logView').hidden) { logPendingLoad = false; loadFloorLog(); renderFloorLog(); }
    setSyncStatus('☁︎ Global sync on', 'on');
  } catch (e) {
    sync.on = false;
    const msg = e && /admin-restricted|operation-not-allowed|configuration-not-found/i.test(e.code || e.message || '')
      ? '⚠︎ sync off — enable Anonymous sign-in in Firebase'
      : '⚠︎ sync unavailable — check Firebase Auth/rules';
    setSyncStatus(msg, 'error');
  }
}

// fast repeat loads + offline support, with an "update ready → reload" prompt
function showUpdateToast(reg) {
  const t = document.getElementById('updateToast'); if (!t) return;
  t.hidden = false;
  document.getElementById('updateReload').onclick = () => {
    if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    else location.reload();
  };
}
/* ---------------- Add to Home Screen prompt ---------------- */
const A2HS_KEY = 'rts.a2hs.dismissed';
let deferredInstall = null;
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function iosSafari() { return isIOS() && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(navigator.userAgent); }
function shareGlyph() {
  return '<svg class="a2hs-share" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
    '<path fill="currentColor" d="M12 3l4 4-1.4 1.4L13 6.8V15h-2V6.8L9.4 8.4 8 7l4-4z"/>' +
    '<path fill="currentColor" d="M5 11h3v2H6v7h12v-7h-2v-2h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/></svg>';
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredInstall = e;
  const lock = $('lockScreen');
  if (!lock || lock.hidden) maybeShowInstall();   // already unlocked → offer now
});
window.addEventListener('appinstalled', dismissInstall);

function maybeShowInstall() {
  const el = $('a2hs'); if (!el || !el.hidden) return;
  if (isStandalone()) return;
  try { if (localStorage.getItem(A2HS_KEY) === '1') return; } catch {}
  const canInstall = !!deferredInstall;   // Android / desktop Chrome
  const ios = iosSafari();                // iOS Safari → manual instructions
  if (!canInstall && !ios) return;        // this browser can't add to home screen
  if (canInstall) {
    $('a2hsInstall').hidden = false;
    $('a2hsSub').textContent = 'One tap to open it like an app — even offline.';
  } else {
    $('a2hsInstall').hidden = true;
    $('a2hsSub').innerHTML = 'Tap ' + shareGlyph() + ' <b>Share</b>, then <b>Add to Home Screen</b>.';
  }
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
}
function dismissInstall() {
  try { localStorage.setItem(A2HS_KEY, '1'); } catch {}
  const el = $('a2hs'); if (el) { el.classList.remove('show'); el.hidden = true; }
}
async function doInstall() {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  try { await deferredInstall.userChoice; } catch {}
  deferredInstall = null;
  dismissInstall();
}

if ('serviceWorker' in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return; refreshing = true; location.reload();   // new version active → refresh once
  });
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      // auto-apply: as soon as a new version finishes downloading, activate it
      const applyNow = () => { if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' }); };
      if (reg.waiting && navigator.serviceWorker.controller) applyNow();
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing; if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) applyNow();
        });
      });
      // keep checking for new versions even while the app stays open
      setInterval(() => reg.update().catch(() => {}), 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    } catch {}
  });
}

setupLock();
init();
