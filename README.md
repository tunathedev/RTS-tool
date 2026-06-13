# RTS Sell-By Date Calculator

A quick tool for bakery **Ready-to-Eat (RTE)** items: pick a product, enter the
date it was pulled from the freezer, and instantly get the **sell-by date**.
Built from the *RTS Shelf Life Quick Sheet (sorted by Category)* —
**117 products across 28 categories**.

It also pulls **product images from HEB.com** for the selected item.

![type: web app](https://img.shields.io/badge/type-web%20app-ee3124)

## Features

- 📱 **Mobile-first** — built to use on your phone while walking the floor.
- 🔎 **Search & browse** all RTE products by name or category.
- 🗓️ **Sell-by calculator** — `sell-by = date pulled from freezer + shelf-life days`,
  shown as **MM/DD/YYYY**.
  - Color-coded result (good / sell soon / expired) with days remaining.
  - Items marked **"Pkg date"** correctly tell you to follow the printed package
    date instead of calculating.
- 🧺 **Morning pull list** — tap ＋ on the items you need to pull from the freezer.
  The **Pull List** tab shows each item's sell-by date, lets you set quantities,
  check items off as you pull them, and **copy/share** the whole list as text.
  Your list is saved on the device (localStorage).
- 📷 **UPC scanner** — tap the floating **Scan** button to scan a product
  barcode with the device camera; the matching product card opens automatically.
  (Uses ZXing; works on iOS Safari / Android Chrome over HTTPS or localhost.)
- 📦 **Par levels** — each product can show its par as *how many tall × how many
  deep* with a cute icon grid.
- 🌤️ **Weather** — San Antonio 78252, three 3-hour blocks + a demand "sell tip".
- 🖼️ **Product images** — a direct image URL per product (from the data), with an
  HEB.com lookup / "View on HEB.com" fallback (see *Images* below).
- ⚠️ Prominent reminder: *date all RTE items immediately when pulled from the
  freezer.*

### Product data fields

Each item in `data/products.json` supports:

| Field | Meaning |
|-------|---------|
| `name` | Product name |
| `days` / `pkgDate` | Shelf life in days, or follow printed package date |
| `image` | Direct product image URL |
| `upc` | Barcode digits (matched by the scanner) |
| `par` | `{ "tall": N, "deep": M }` — par level layout |

Populate `image`, `upc`, and `par` in bulk from a spreadsheet:

```bash
node tools/import-csv.js path/to/products.csv
```

CSV columns (header row): `name, image_url, upc, par_tall, par_deep` (+ optional
`category`). Rows merge onto existing products by name.

## Run it

**Option A — with images (recommended):**

```bash
node server.js
# then open http://localhost:3500
```

`server.js` is zero-dependency (Node built-ins only). It serves the app and
provides a small `/api/heb-image` proxy that looks up product images on HEB.com
server-side (a browser can't do this directly because of CORS / bot protection).
Results are cached to `data/image-cache.json`.

**Option B — calculator only (no server):**

```bash
# any static server works, e.g.
python3 -m http.server 8000
# then open http://localhost:8000
```

Opened this way (or as a static site / GitHub Pages), the calculator is fully
functional. The image panel falls back to a placeholder plus an always-working
**"View on HEB.com"** button that opens the product search in your browser.

## Images

HEB has no public image API, so there are three layers, tried in order:

1. **Manual pins** — `data/heb-overrides.json` lets you lock an exact image/URL
   per product:
   ```json
   {
     "H-E-B Brioche Bread": {
       "image": "https://images.heb.com/is/image/HEBGrocery/001789552",
       "url": "https://www.heb.com/product-detail/h-e-b-brioche-bread/1789552"
     }
   }
   ```
2. **Live lookup** via `server.js` (`/api/heb-image`), cached to disk.
3. **Fallback link** — "View on HEB.com" search, which always works in a real
   browser.

> HEB images display via standard `<img>` tags, which is not subject to CORS.
> The CORS / bot-protection limitation only affects *searching* for the image,
> which is why that step runs server-side.

## Data

`data/products.json` is the structured dataset parsed from the source PDF:

```jsonc
{
  "categories": [
    {
      "category": "Bread/Buns",
      "items": [
        { "name": "H-E-B Brioche Bread", "days": 7, "pkgDate": false },
        { "name": "Biscotti",            "days": null, "pkgDate": true }
      ]
    }
  ]
}
```

- `days` — shelf life in days from the freezer-pull date.
- `pkgDate: true` — follow the printed package date (no calculation).

Source sheet last updated **3/31/2026**.

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell |
| `styles.css` | Styling (HEB-red theme, print label, responsive) |
| `app.js` | Calculator, search, pull list, image loading |
| `server.js` | Static server + HEB image proxy (optional) |
| `data/products.json` | Shelf-life dataset |
| `data/heb-overrides.json` | Optional manual image pins |
| `data/image-cache.json` | Auto-generated image lookup cache |
