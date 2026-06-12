# RTS Sell-By Date Calculator

A quick tool for bakery **Ready-to-Eat (RTE)** items: pick a product, enter the
date it was pulled from the freezer, and instantly get the **sell-by date**.
Built from the *RTS Shelf Life Quick Sheet (sorted by Category)* —
**117 products across 28 categories**.

It also pulls **product images from HEB.com** for the selected item.

![type: web app](https://img.shields.io/badge/type-web%20app-ee3124)

## Features

- 🔎 **Search & browse** all RTE products by name or category.
- 🗓️ **Sell-by calculator** — `sell-by = date pulled from freezer + shelf-life days`.
  - Color-coded result (good / sell soon / expired) with days remaining.
  - Items marked **"Pkg date"** correctly tell you to follow the printed package
    date instead of calculating.
- 🖼️ **HEB.com images** for the selected product (see *Images* below).
- 🖨️ **Print a label** with the product name, pull date, and sell-by date.
- 📱 Works on phones/tablets for use on the store floor.
- ⚠️ Prominent reminder: *all RTE items must be dated immediately once taken out
  of the freezer.*

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
| `app.js` | Calculator, search, image loading, printing |
| `server.js` | Static server + HEB image proxy (optional) |
| `data/products.json` | Shelf-life dataset |
| `data/heb-overrides.json` | Optional manual image pins |
| `data/image-cache.json` | Auto-generated image lookup cache |
