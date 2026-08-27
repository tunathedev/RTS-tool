# RTS Bakery App — Build Notes & Handoff

A field guide for building a similar bakery ops app. This documents an app in
production pilot at an HEB bakery: a **Ready-To-Sell (RTS)** team tool for
calculating sell-by dates, planning the daily freezer pull, and building party
platters — used on a phone, on the floor, often with gloves on.

Everything below is what I'd want to know before starting a new one.

---

## 1. What it is

A single-page **PWA** the bakery RTS team opens on their phones. Core jobs:

- **Sell-by calculator** — pick a product, enter the date it came out of the
  freezer, get the sell-by date (`pull date + shelf-life days`), color-coded by
  freshness. Some items follow the printed package date instead.
- **Pull list** — a simple checklist of what to pull from the freezer today,
  with quantities, "labeled" marks, and **holes** (empty floor spots to fill first).
- **Freezer Mode** — full-screen, glove-friendly version of the pull list for
  standing at the freezer: giant names, big check targets, sections by table.
- **Production** — party platters + sliced crème cakes. Build-to-par math,
  editable recipes, and case-pack rollup ("pull 3 boxes of X").
- **Shift hub** — a lightweight feed, claimable tasks, and a photo floor-log.
- **Profiles/login** — PIN-based identity so actions are attributed.
- **Analytics** — passive usage events to a private Google Sheet (no PII).

It syncs live across all devices, works offline, and auto-updates.

---

## 2. Stack & why

| Choice | Rationale |
|---|---|
| **Vanilla JS, no framework, no build step** | One `app.js` (~3,300 lines), `styles.css`, `index.html`, `sw.js`. Anyone can read/patch it with no toolchain. Huge for an internal tool maintained by whoever's around. Loads instantly. |
| **GitHub Pages** (deploy from `main`, repo root) | Free static hosting, HTTPS, instant deploy on push. No server to run or pay for. |
| **Firebase Realtime Database** | Global live sync with almost no backend code. Anonymous auth. Modular SDK loaded via dynamic `import()` from gstatic (no bundler). |
| **Service worker PWA** | Offline support + aggressive auto-update so the floor never runs stale code. Installable to home screen. |
| **`data/products.json`** | The catalog: 192 products across 24 categories, each with shelf-life days, UPC, optional PLU, image URL, par. Static file, network-first cached. |

Honest tradeoffs: no build means no TypeScript, no module system, no
tree-shaking — you manage one big file. For a focused internal tool that's a
feature, not a bug. If the app grew to many screens/teams I'd reconsider.

**Optional Node piece:** `server.js` is a tiny static server + HEB image proxy
(browsers can't fetch product images directly due to CORS/bot protection, so it
looks them up server-side). Not needed for the calculator; only for live images.

---

## 3. Repo layout

```
app.js                 all app logic (one file)
styles.css             all styles
index.html             markup shell
sw.js                  service worker (offline + auto-update)
sync-config.js         Firebase config + analytics URL (public by design)
data/products.json     the catalog
firebase.rules.json    Realtime DB security rules
server.js              optional static server + HEB image proxy
manifest.webmanifest   PWA manifest
tools/                 Apps Script for the analytics sheet
docs/, *.md            docs; qr*.png, icon-*.png assets
```

---

## 4. Data model

**One global `state` object** is the source of truth in memory. Key fields:

```js
const state = {
  items: [],          // flattened catalog {name, days, pkgDate, category, upc?, plu?, par?, boxQty?, _key}
  byName, byKey, byUpc,   // lookup indexes (byKey survives renames — see §5)
  pull: [],           // [{name, qty, done, labels, hole, addedTs}]
  cust: { patches:{}, added:[], deleted:[] },   // user edits over the base catalog
  prod: {},           // production: platterId -> {par, onHand, make, done}
  platters: {},       // editable platters: id -> {id, name, group, note, recipe:[{n, key, q}]}
  compBox: {},        // case-pack fallbacks: componentName -> per-box count
  profiles: {}, me,   // people + who's signed in here
  feed:{}, tasks:{}, log:[], pullHistory:{}, pullDay,
};
```

**Everything persists to `localStorage` first**, then syncs. The LS keys are
versioned (`rts.pullList.v1`, `rts.catalog.v2`, `rts.platters.v1`, …) so schema
changes are explicit.

**Product shape** (`products.json`):

```json
{ "name": "Donut Holes Glazed", "days": 2, "pkgDate": false,
  "upc": "4122091076", "plu": "…", "image": "https://…", "par": {…} }
```

**Pull item shape:** `{ name, qty, done, labels, hole, addedTs }` — `hole` flags
an empty floor spot; `addedTs` is a timestamp shown as "added 2:45 PM" and it
syncs with the item so the freezer person sees when a hole was flagged.

---

## 5. The catalog: base + customization layers (the most important pattern)

The catalog is **base data + a customization overlay**, never edited in place:

- **Base** = `products.json`, each item gets a stable key via
  `baseKeyOf(it) = it.upc ? 'u:'+normUpc(upc) : 'n:'+name`.
- **Overlay** = `state.cust = { patches, added, deleted }`. A rename is a *patch
  keyed by the stable `_key`* — the key never changes, only the displayed name.
- `effective(base, patch)` merges them; `rebuildItems()` produces `state.items`
  and the `byName` / `byKey` / `byUpc` indexes.

**Why this matters — key everything by a stable ID, never by display name.**
This is the single biggest lesson. Early on, platter recipes referenced
products by *name* (`"Sliced Loaf Lemon Creme"`). The moment someone renamed a
product in the catalog, the recipe silently stopped resolving its case pack.
The fix was to link recipe rows to the stable `_key` (`u:<upc>`) and resolve the
current product at render time:

```js
function recipeItem(c) { return (c.key && state.byKey.get(c.key)) || state.byName.get(c.n) || null; }
```

Now renames follow through everywhere. **Do this from day one.**

---

## 6. Sync architecture

Firebase Realtime DB, anonymous auth, modular SDK loaded at runtime. Two styles:

**A. Whole-document paths** (`SYNC_PATHS = ['cust','pull','prod','compBox','profiles','pullday','platters']`).
Each path stores a wrapper `{ data, ts }`. On any local change we push the whole
array/object for that path (debounced). Simple, last-write-wins.

```js
const sync = { on, applying, mod, db, seen, last:{}, timers:{}, pending:{} };

function pushSync(path, value) {         // coalesce bursts into one write
  if (sync.applying) return;             // don't echo while applying a remote update
  sync.pending[path] = value; sync.last[path] = JSON.stringify(value);
  clearTimeout(sync.timers[path]);
  sync.timers[path] = setTimeout(() => flushPush(path), 300);
}

function onRemote(path, wrapper) {
  const incoming = JSON.stringify(wrapper.data);
  if (incoming === sync.last[path]) return;     // skip our own echo / no-ops
  sync.applying = true;
  try { /* apply to state, save to LS, re-render */ }
  finally { sync.applying = false; sync.last[path] = incoming; }
}
```

Two guards keep it from looping: **`sync.applying`** (a remote apply must not
trigger an outbound push) and the **echo-skip** (`incoming === sync.last[path]`).

**B. Per-child live paths** for high-churn collaborative data — the feed
(`rts/feed/{id}`), tasks (`rts/tasks/{id}`), floor log (`rts/log/{id}`), and
archived pull history (`rts/pullHistory/{day}`). Each item is written to its own
child key so two people editing different items don't clobber each other.

**Tradeoff to decide up front:** whole-document last-write-wins is dead simple
and fine for 1–2 people editing a list. If several people edit the *same*
collection at the same second, use per-item child writes (style B). The pull
list uses style A and it's been fine for a small crew; the feed/tasks use B.

**The Firebase web API key is public by design** — it only names the project;
it grants no data access. Security is the DB rules (`firebase.rules.json`), not
the key. See §10.

---

## 7. Domain logic worth copying

- **Sell-by** = `pullDate + days`. `pkgDate` items skip the math and show
  "package date." Freshness buckets drive color: **good / sell-soon / expired**.
- **Holes** = empty floor spots. Flagging one adds it to the pull list and
  floats it into a "Fill first" section (holes get filled before walking the
  freezer).
- **Production (build-to-par):** `make = max(0, par − onHand)`. Recipes are
  `[{n, key, q}]` (q = pieces per platter). Roll each component up across all
  platters, then convert to boxes: `boxes = ceil(totalPieces / casePack)`.
  Case pack resolves from the product's `boxQty`, falling back to a seeded
  `compBox` map. Crème cakes are pull-list-driven, not par-driven.
- **Managed vs. editable data + idempotent migrations.** Default platters/recipes
  ship in code but live in synced, user-editable `state.platters`. To evolve them
  without stomping user edits, `ensureManagedPlatters()` runs on load and on every
  remote update: it replaces a known recipe **only** if it's an untouched
  placeholder or an *exact match* to a superseded old version (a `SUPERSEDE` map
  of old recipe JSON strings). It also stamps stable keys onto legacy rows. The
  whole thing is **idempotent** — once converged it makes no changes, so it never
  loops across devices. This pattern (seed-in-code, migrate-idempotently,
  never-touch-user-edits) is worth stealing.

---

## 8. UI patterns for the floor

The user is on a phone, at a freezer, possibly gloved, in bad lighting. That
shapes everything:

- **Big tap targets**, full-screen focus modes (Freezer Mode), **no pinch-zoom**
  (viewport locked) so nothing shifts under a thumb.
- **Update the DOM in place on hot paths.** Rebuilding a whole list on every tap
  caused a visible "green flash" and lost scroll position — the tapped element
  was destroyed mid-press. Toggling just the tapped card's classes fixed it.
  Only do full re-renders on structural changes.
- **O(1) lookups.** Renders that did `state.pull.find(x => x.name === …)` inside
  a loop over 192 items were O(n²). Build a `Map` once per render:
  `const byName = new Map(state.pull.map(p => [p.name, p]))`.
- **Debounce** heavy renders (search rebuild) and network writes (300ms).
- **Cache image nodes** at creation (not just on load) so re-renders reuse them
  instead of recreating `<img>` mid-download.
- **Sticky section headers**, compact "done" states so remaining work dominates.

---

## 9. PWA & deploy

- **Service worker** (`sw.js`): stale-while-revalidate for the app shell,
  network-first for `products.json` and `sync-config.js`. **Bump the cache name
  on every deploy** (`rts-ready-vNN`) or users get stuck on old code.
- **Auto-update:** the page polls for a new SW, calls `skipWaiting()`, and
  reloads on `controllerchange`. The floor always ends up on the latest build
  without anyone tapping "update."
- **Deploy = push.** GitHub Pages serves `main` from the repo root. Workflow:
  commit → push feature branch → fast-forward `main` → push `main`. Bump the SW
  cache in the same commit.

---

## 10. Auth, identity & security posture

Be honest about the threat model — this is a pilot POC, internal, low-stakes:

- **Login is a PIN**, per person, used to attribute actions and personalize.
  There's a master PIN that opens a roster picker. Profiles sync; inactive ones
  auto-archive after a few weeks. **This is a nametag, not a lock** — don't
  pretend otherwise. PINs aren't hashed (deliberately, for a POC).
- **Public repo, public Firebase web key** — both fine *by design*. Real
  protection is the **Realtime DB rules** (keep them on) and optionally Firebase
  App Check (wired but off).
- **Never log PII.** Analytics captures no location, no IP, no PIN, no message
  contents.

Don't over-engineer security for a proof of concept — but do keep the DB rules
on and keep PII out of logs.

---

## 11. Analytics (no-permission, no-PII)

Passive usage events → a private Google Sheet, so you can see *if* and *how* the
app gets used without asking permission or collecting anything sensitive:

- Events are queued per-device and sent via `navigator.sendBeacon` to a Google
  **Apps Script web app**, which appends to a private Sheet and auto-builds a
  dashboard.
- Captured: event name, screen, person's initials, coarse device info,
  timestamp. **Not** captured: location, IP, PIN, or any message content.

---

## 12. Testing

No framework — two cheap gates that caught real bugs:

- `node -c app.js` — syntax check before every deploy.
- **Headless Chromium (Playwright-core)** smoke scripts: seed `localStorage`,
  drive the UI, assert rendered output and math (e.g. "17 trays → 2 boxes of
  16"), and screenshot to eyeball layout on a 390px viewport. This caught a
  `ReferenceError` that broke Freezer Mode and verified the rename-proofing.

---

## 13. Lessons learned / what I'd do differently

1. **Stable IDs at the schema level from day one.** Keying anything by display
   name is a time bomb once users can rename things.
2. **localStorage-first, sync as an overlay.** The app is instant and works
   offline; sync reconciles in the background. Great UX, simple mental model.
3. **In-place DOM updates on hot paths**, full re-render only on structural
   change. Saves the flash, the scroll jump, and the perf.
4. **Idempotent, exact-match migrations** to evolve shipped defaults without
   stomping user edits (the `ensureManagedPlatters` / `SUPERSEDE` pattern).
5. **Pick your sync granularity per collection.** Whole-doc last-write-wins for
   simple lists; per-item child writes where people collaborate concurrently.
6. **Design for gloves and a freezer**, not a desk. Big targets, full-screen
   modes, high contrast, no accidental zoom.
7. **Auto-update aggressively, version the cache every deploy.**
8. **Be honest about security.** Public key + PIN nametag is fine for a pilot;
   just keep DB rules on and PII out.
9. **No build step is a real strength** for a small internal tool's longevity —
   weigh that before reaching for a framework.

If I started fresh: same shape — `products.json` + `localStorage` + one render
loop first; add Firebase RTDB with the wrapper + echo-skip pattern when
multi-device is needed; keep the SW simple; test headless. Just bake the stable
IDs in from the first commit.
