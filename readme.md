

# Ecwid Live Search (3DPrintronics)

A custom, high-performance live search solution for Ecwid storefronts, built to work **reliably on both desktop and mobile** — without relying on paid search apps.

This project replaces Ecwid’s default search UX with an **instant, dropdown-based live search** while preserving **native browser navigation**, especially on iOS (Safari), which is where most custom implementations fail.

---

## Why This Exists

Paid Ecwid search apps:
- Are expensive
- Do not expose internals
- Failed to implement features we explicitly wanted (e.g. SKU display, stock status)
- Often break on mobile in subtle ways

This project was built to:
- Fully control UX
- Keep navigation **browser-native**
- Be debuggable and extensible
- Work identically on **desktop + mobile**

---

## Current Features

### 🔍 Live Search Dropdown
- Search-as-you-type
- Fast API-backed results
- Clean dropdown UI
- Categories + products supported

### 🧭 Native Navigation (Critical)
- **All product links are real `<a href>` elements**
- No JS-based navigation hacks
- Long-press, open-in-new-tab, etc. work naturally
- Prevents iOS Safari tap bugs

### 📱 Mobile-Safe Interaction
- Explicit handling of:
  - `touchstart`
  - `touchend`
  - `pointerdown`
- Solves iOS issue where:
  > tap closes dropdown but does not navigate
- Navigation triggered on `touchend` fallback when `click` is swallowed

### 🧾 Rich Result Info
Each product row shows:
- Product image
- Product title
- Price
- SKU
- Stock status  
  - In Stock (green)  
  - Out of Stock (red)

---

## File Structure (Key Parts)

```
frontend/
 └── search.js        # Main live search logic (core file)
worker/
 └── index.js         # Cloudflare Worker proxy to Ecwid Storefront API
README.md
```

---

## Architectural Principles (Read This Before Editing)

### 1. Never Hijack Navigation
❌ No `window.location = ...`  
❌ No `preventDefault()` on product taps  
✅ Always use `<a href="product-url">`

### 2. Dropdown Is UI Only
JavaScript is responsible **only** for:
- Fetching results
- Rendering dropdown
- Showing / hiding

Navigation is the browser’s job.

### 3. Mobile First (Safari First)
Desktop hides bugs.  
Mobile reveals them.

Assume:
- `click` may never fire
- `touchend` may be the only reliable signal
- `blur` events fire aggressively

---

## The Critical Mobile Bug (Historical Context)

**Symptom**
- Dropdown opens
- Tapping product closes dropdown
- No navigation happens
- Long-press → “Open in new tab” works

**Root Cause**
- iOS Safari swallows `click`
- Dropdown close logic ran before navigation
- Blur + outside-click handlers interfered

**Final Fix**
- Detect `<a>` inside dropdown on `touchend`
- Trigger navigation fallback **only if click did not happen**
- Suppress dropdown close briefly during tap window

⚠️ This logic is intentional. Do not remove casually.

---

## Deployment Notes

### Frontend
- Loaded via Ecwid custom app
- Script URL (example):
  ```
  https://<your-domain>/frontend/search.js
  ```

### Backend (Cloudflare Worker)
Environment variables required:
- `ECWID_STORE_ID`
- `ECWID_TOKEN`

If search stops working everywhere:
- Reinstall the Ecwid custom app
- Rotate secrets in Cloudflare
- Do **not** assume frontend regression first

---

## Non-Goals (By Design)

- ❌ Client-side full-text indexing
- ❌ SPA routing
- ❌ JavaScript navigation
- ❌ Fighting Ecwid relevance ranking (for now)

---

## Planned Future Enhancements

### 🔤 Spelling Correction
- Detect no-result searches
- Suggest closest matches
- Lightweight dictionary-based approach

### 🔁 Synonyms
- Configurable synonym map  
  Example:
  ```
  "vslot" → "aluminium extrusion"
  "tnut" → "t nut"
  ```

### 📢 Promotions
- Boost selected SKUs for specific queries
- Example: promote kits when searching extrusion sizes

### 📊 Search Analytics
- Top search terms
- No-result queries
- Click-through rate
- Useful for catalog optimization

---

## Notes to Future Maintainers

- This implementation now performs **better than paid apps**
- Mobile behavior is the hardest part — protect it
- If something breaks:
  1. Check Ecwid app install
  2. Check Worker secrets
  3. Then check code
