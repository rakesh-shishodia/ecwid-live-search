/**
 * Ecwid Live Search – storefront injection script (MVP)
 *
 * Loads on your Ecwid storefront and adds a typeahead dropdown under the existing search input.
 * IMPORTANT: This script must NOT contain any Ecwid secret token. It talks only to your Worker.
 */

console.log('[LS] script loaded at', location.pathname + location.hash);
// ✅ Your deployed Worker base URL
const WORKER_BASE_URL = 'https://ecwid-live-search.shishodia-rakesh.workers.dev';


const CONFIG = {
  minChars: 2,
  debounceMs: 200,
  maxProducts: 8,
  maxCategories: 6,
  dropdownOffsetPx: 8,
};

// Fallback icon for categories when no image is provided
const CATEGORY_FALLBACK_THUMB =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect x="10" y="18" width="44" height="34" rx="8" fill="%23E9EEF5"/>
      <path d="M18 18c0-3.314 2.686-6 6-6h10l4 4h8c3.314 0 6 2.686 6 6" fill="%23D7DFEA"/>
      <path d="M18 24h28" stroke="%23A9B6C6" stroke-width="3" stroke-linecap="round"/>
    </svg>`
  );

let _ecwidLiveSearchBoundInput = null;
let _ecwidLiveSearchDocHandlerBound = false;

let _ecwidLiveSearchActiveIndex = -1;
let _ecwidLiveSearchLastQuery = '';
let _ecwidLiveSearchAnchorInput = null;

function isDesktopPointer() {
  try {
    return window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  } catch {
    return true;
  }
}

function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function $(sel, root = document) {
  return root.querySelector(sel);
}

function findSearchInput() {
  // Prefer the actual header search field used by your theme
  const selectors = [
    'input.ins-header__search-field[name="keyword"]',
    'form[role="search"] input.ins-header__search-field[name="keyword"]',
    'input[name="keyword"]',
    'form[action*="search"] input[name="keyword"]',
    '.ec-store__search input[name="keyword"]',
    '.ecwid-search input[name="keyword"]',
    // Fallbacks
    'input[type="search"]',
  ];

  const isVisible = (el) => {
    if (!el) return false;
    if (el.disabled) return false;
    // offsetParent null usually means display:none or not in layout
    if (el.offsetParent === null) return false;
    const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (cs && (cs.visibility === 'hidden' || cs.display === 'none')) return false;
    return true;
  };

  for (const s of selectors) {
    const el = $(s);
    if (el && el.tagName === 'INPUT' && isVisible(el)) return el;
  }

  // Final fallback: heuristics across all inputs, but only visible ones.
  const inputs = Array.from(document.querySelectorAll('input'));
  return (
    inputs.find((i) => {
      if (!isVisible(i)) return false;
      const type = (i.getAttribute('type') || '').toLowerCase();
      const name = (i.getAttribute('name') || '').toLowerCase();
      const placeholder = (i.getAttribute('placeholder') || '').toLowerCase();
      const looks = type === 'search' || name.includes('search') || name.includes('keyword') || placeholder.includes('search');
      return looks;
    }) || null
  );
}

function ensureDropdown(anchorInput) {
  _ecwidLiveSearchAnchorInput = anchorInput;

  let dd = document.getElementById('ecwid-live-search-dd');

  const position = () => {
    const a = _ecwidLiveSearchAnchorInput;
    if (!a || !dd) return;
    const r = a.getBoundingClientRect();
    dd.style.left = `${Math.round(r.left + window.scrollX)}px`;
    dd.style.top = `${Math.round(r.bottom + window.scrollY + CONFIG.dropdownOffsetPx)}px`;
    dd.style.width = `${Math.round(r.width)}px`;
  };

  if (dd) {
    // Re-anchor + reposition for the current page/layout
    try { position(); } catch {}
    // Store position fn so we can reuse it
    dd._lsPosition = position;
    return dd;
  }

  dd = document.createElement('div');
  dd.id = 'ecwid-live-search-dd';
  dd.style.position = 'absolute';
  dd.style.zIndex = '999999';
  dd.style.background = '#fff';
  dd.style.border = '1px solid rgba(0,0,0,0.12)';
  dd.style.borderRadius = '10px';
  dd.style.boxShadow = '0 10px 25px rgba(0,0,0,0.12)';
  dd.style.overflow = 'hidden';
  dd.style.display = 'none';

  document.body.appendChild(dd);

  // Store position fn and bind global listeners once
  dd._lsPosition = position;
  position();

  if (!window.__lsDropdownPositionBound) {
    window.__lsDropdownPositionBound = true;
    window.addEventListener('resize', () => {
      const d = document.getElementById('ecwid-live-search-dd');
      if (d && d._lsPosition) d._lsPosition();
    });
    window.addEventListener('scroll', () => {
      const d = document.getElementById('ecwid-live-search-dd');
      if (d && d._lsPosition) d._lsPosition();
    }, true);
  }

  // Reposition when input focuses (layout may shift)
  try { anchorInput.addEventListener('focus', position); } catch {}

  return dd;
}

function hideDropdown(dd, { clear = true } = {}) {
  hideInlineLoading(dd);
  dd.style.display = 'none';
  if (clear) dd.innerHTML = '';
  _ecwidLiveSearchActiveIndex = -1;
  delete dd.dataset.lsHasResults;
}

function getResultRows(dd) {
  return Array.from(dd.querySelectorAll('a[data-ls-row="1"]'));
}

function setActiveRow(dd, index) {
  const rows = getResultRows(dd);
  if (!rows.length) {
    _ecwidLiveSearchActiveIndex = -1;
    return;
  }

  const clamped = Math.max(0, Math.min(index, rows.length - 1));
  _ecwidLiveSearchActiveIndex = clamped;

  rows.forEach((r, i) => {
    if (i === clamped) {
      r.dataset.lsActive = '1';
      r.style.background = 'rgba(0,0,0,0.06)';
    } else {
      delete r.dataset.lsActive;
      r.style.background = 'transparent';
    }
  });

  // Ensure active row is visible
  const active = rows[clamped];
  try { active.scrollIntoView({ block: 'nearest' }); } catch {}
}

function getActiveHref(dd) {
  const rows = getResultRows(dd);
  if (_ecwidLiveSearchActiveIndex < 0 || _ecwidLiveSearchActiveIndex >= rows.length) return null;
  const a = rows[_ecwidLiveSearchActiveIndex];
  return a ? (a.href || a.getAttribute('href')) : null;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightNode(text, q) {
  const s = String(text || '');
  const query = String(q || '').trim();
  if (!query) return document.createTextNode(s);

  const re = new RegExp(escapeRegExp(query), 'ig');
  const parts = s.split(re);
  const matches = s.match(re);
  if (!matches) return document.createTextNode(s);

  const frag = document.createDocumentFragment();
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) frag.appendChild(document.createTextNode(parts[i]));
    if (i < matches.length) {
      const m = document.createElement('mark');
      m.textContent = matches[i];
      m.style.background = 'rgba(255, 230, 150, 0.85)';
      m.style.padding = '0 2px';
      m.style.borderRadius = '4px';
      frag.appendChild(m);
    }
  }
  return frag;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === null || v === undefined) continue;
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else if (c) node.appendChild(c);
  }
  return node;
}

function sectionTitle(txt) {
  return el(
    'div',
    {
      style: {
        padding: '10px 12px 6px',
        fontSize: '11px',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        opacity: '0.7',
        fontWeight: '700',
      },
    },
    [txt]
  );
}

function renderLoading(dd) {
  dd.innerHTML = '';
  dd.appendChild(sectionTitle('Search'));
  dd.appendChild(
    el('div', { style: { padding: '12px', fontSize: '13px', opacity: '0.8' } }, ['Searching…'])
  );
  delete dd.dataset.lsHasResults;
  dd.style.display = 'block';
}

function showInlineLoading(dd) {
  // Non-destructive loader: keep current results and show a subtle footer.
  let footer = dd.querySelector('[data-ls-loading="1"]');
  if (!footer) {
    footer = el(
      'div',
      {
        style: {
          padding: '8px 12px',
          fontSize: '12px',
          opacity: '0.75',
          borderTop: '1px solid rgba(0,0,0,0.08)',
        },
      },
      ['Searching…']
    );
    footer.setAttribute('data-ls-loading', '1');
    dd.appendChild(footer);
  }
}

function hideInlineLoading(dd) {
  const footer = dd.querySelector('[data-ls-loading="1"]');
  if (footer) footer.remove();
}

function itemRow({ title, subtitle, thumb, href, dataAttrs = {} }) {
  const row = el('a', {
    href,
    style: {
      display: 'flex',
      gap: '10px',
      alignItems: 'center',
      padding: '10px 12px',
      textDecoration: 'none',
      color: '#111',
    },
    onmouseenter: (e) => (e.currentTarget.style.background = 'rgba(0,0,0,0.04)'),
    onmouseleave: (e) => (e.currentTarget.style.background = 'transparent'),
  });

  // Attach metadata for Ecwid navigation
  for (const [k, v] of Object.entries(dataAttrs)) {
    if (v === null || v === undefined) continue;
    row.dataset[k] = String(v);
  }

  // Mark as a navigable result row
  row.dataset.lsRow = '1';

  // Desktop UX: hovering a row updates the active index
  row.addEventListener('mouseenter', () => {
    if (!isDesktopPointer()) return;
    const dd = document.getElementById('ecwid-live-search-dd');
    if (!dd) return;
    const rows = getResultRows(dd);
    const idx = rows.indexOf(row);
    if (idx >= 0) setActiveRow(dd, idx);
  });

  const img = el('div', {
    style: {
      width: '42px',
      height: '42px',
      borderRadius: '8px',
      background: 'rgba(0,0,0,0.06)',
      flex: '0 0 42px',
      overflow: 'hidden',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
  });

  if (thumb) {
    const im = new Image();
    im.src = thumb;
    im.alt = title;
    im.style.width = '100%';
    im.style.height = '100%';
    im.style.objectFit = 'cover';
    img.appendChild(im);
  }

  const text = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } });
  const titleDiv = el('div', { style: { fontSize: '13px', fontWeight: '600' } });
  if (title && typeof title === 'object' && title.nodeType) titleDiv.appendChild(title);
  else if (title && typeof title === 'object' && title instanceof DocumentFragment) titleDiv.appendChild(title);
  else titleDiv.appendChild(document.createTextNode(String(title || '')));
  text.appendChild(titleDiv);
  if (subtitle) text.appendChild(el('div', { style: { fontSize: '12px', opacity: '0.75' } }, [subtitle]));


  row.appendChild(img);
  row.appendChild(text);
  return row;
}

function absUrlMaybe(u) {
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('/')) return `${window.location.origin}${u}`;
  return u;
}

function buildProductHref(p) {
  const u = absUrlMaybe(p.url);
  if (u) return u;
  if (p.id) return `${window.location.origin}/#!/p/${p.id}`;
  return '#';
}

function buildCategoryHref(c) {
  const u = absUrlMaybe(c.url);
  if (u) return u;
  if (c.id) return `${window.location.origin}/#!/c/${c.id}`;
  return '#';
}

async function fetchResults(q, signal) {
  const base = WORKER_BASE_URL.replace(/\/$/, '');
  const url = `${base}/search?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  return res.json();
}

function render(dd, data) {
  const products = (data.products || []).slice(0, CONFIG.maxProducts);
  const categories = (data.categories || []).slice(0, CONFIG.maxCategories);

  _ecwidLiveSearchLastQuery = (data && data.q) ? String(data.q) : '';
  _ecwidLiveSearchActiveIndex = -1;

  // STEP 3.1: Ensure inline loading is hidden before clearing
  hideInlineLoading(dd);
  dd.innerHTML = '';

  if (!products.length && !categories.length) {
    dd.appendChild(el('div', { style: { padding: '12px', fontSize: '13px', opacity: '0.8' } }, ['No results']));
    // STEP 3.2: Ensure inline loading is hidden before showing
    hideInlineLoading(dd);
    dd.style.display = 'block';
    return;
  }

  if (products.length) {
    dd.appendChild(sectionTitle('Products'));
    for (const p of products) {
      dd.appendChild(
        itemRow({
          title: highlightNode(p.name || 'Product', _ecwidLiveSearchLastQuery),
          subtitle: p.price ? String(p.price) : p.sku ? `SKU: ${p.sku}` : '',
          thumb: p.thumb,
          href: buildProductHref(p),
          dataAttrs: { ecwidType: 'product', ecwidId: p.id },
        })
      );
    }
  }

  if (categories.length) {
    dd.appendChild(sectionTitle('Categories'));
    for (const c of categories) {
      dd.appendChild(
        itemRow({
          title: highlightNode(c.name || 'Category', _ecwidLiveSearchLastQuery),
          subtitle: 'Category',
          thumb: c.thumb || CATEGORY_FALLBACK_THUMB,
          href: buildCategoryHref(c),
          dataAttrs: { ecwidType: 'category', ecwidId: c.id },
        })
      );
    }
  }

  dd.dataset.lsHasResults = '1';
  // STEP 3.2: Ensure inline loading is hidden before showing
  hideInlineLoading(dd);
  dd.style.display = 'block';
}

function initLiveSearchOnce() {
  console.log('[LS] initLiveSearchOnce()', { path: location.pathname + location.hash, time: Date.now() });
  const input = findSearchInput();
  console.log('[LS] search input', input ? 'FOUND' : 'NOT FOUND', input);
  if (!input) return false;

  const existingDd = document.getElementById('ecwid-live-search-dd');

  console.log('[LS] guard check', {
    sameInput: _ecwidLiveSearchBoundInput === input,
    hasDropdown: !!existingDd,
    boundInput: _ecwidLiveSearchBoundInput,
    currentInput: input,
  });

  const dropdownIsAlive = existingDd && document.body.contains(existingDd);

  if (_ecwidLiveSearchBoundInput === input && dropdownIsAlive) {
    // Even when skipping init, ensure dropdown is anchored to the current input (SPA nav)
    try { ensureDropdown(input); } catch {}
    console.log('[LS] EARLY RETURN — skipping init (dropdown alive)');
    return true;
  }

  _ecwidLiveSearchBoundInput = input;

  const dd = ensureDropdown(input);
  let abort = null;

  const run = debounce(async () => {
    const q = (input.value || '').trim();
    if (q.length < CONFIG.minChars) {
      hideDropdown(dd);
      return;
    }

    if (abort) abort.abort();
    abort = new AbortController();

    const loadingTimer = setTimeout(() => {
      if (dd.dataset.lsHasResults) {
        // Solution A: keep results visible; show subtle footer loader.
        showInlineLoading(dd);
      } else {
        // First load (no results yet): show the small skeleton.
        renderLoading(dd);
      }
    }, 120);

    try {
      const data = await fetchResults(q, abort.signal);
      clearTimeout(loadingTimer);
      hideInlineLoading(dd);
      render(dd, data);
    } catch {
      clearTimeout(loadingTimer);
      hideInlineLoading(dd);
      hideDropdown(dd);
    }
  }, CONFIG.debounceMs);

  // STEP 1: store runner on the input so delegated listeners can call it even if Ecwid replaces listeners
  input._lsRun = run;

  input.addEventListener('input', run);

  if (!_ecwidLiveSearchDocHandlerBound) {
    _ecwidLiveSearchDocHandlerBound = true;

    // STEP 2: Delegated input handler (SPA-safe). Ensures typing always triggers live search.
    if (!window.__lsDelegatedInputBound) {
      window.__lsDelegatedInputBound = true;
      document.addEventListener(
        'input',
        (e) => {
          const t = e.target;
          if (!t || t.tagName !== 'INPUT') return;
          if (!t.classList || !t.classList.contains('ins-header__search-field')) return;
          if (t.name !== 'keyword') return;

          console.log('[LS] delegated input fired', { path: location.pathname + location.hash, value: t.value });

          // Treat this as the active input
          _ecwidLiveSearchBoundInput = t;

          // Ensure dropdown exists/anchored
          try { ensureDropdown(t); } catch {}

          // If runner missing (input replaced), rebuild once
          if (typeof t._lsRun !== 'function') {
            try { initLiveSearchOnce(); } catch {}
          }

          if (typeof t._lsRun === 'function') {
            t._lsRun();
          }
        },
        true
      );
    }

    document.addEventListener('click', (e) => {
      const activeInput = _ecwidLiveSearchBoundInput;
      const dropdown = document.getElementById('ecwid-live-search-dd');
      if (!activeInput || !dropdown) return;

      if (e.target === activeInput) return;

      // If click/tap is inside dropdown, do NOT hide/clear here.
      // On mobile, destroying the tapped <a> can cancel navigation.
      if (dropdown.contains(e.target)) {
        return;
      }

      hideDropdown(dropdown);
    });
  }

  // Extra mobile safety: avoid tearing down dropdown during <a> tap/click sequence
  if (!dd.dataset.ecwidLiveSearchClickBound) {
    dd.dataset.ecwidLiveSearchClickBound = '1';

    dd.addEventListener(
      'click',
      (e) => {
        const a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (!a) return;

        // Deterministic navigation: use the actual href. This avoids Ecwid Storefront API CORS issues.
        const href = a.href || a.getAttribute('href');
        if (!href) return;

        // Prevent any other handlers from interfering, then navigate.
        e.preventDefault();
        e.stopPropagation();

        // Use assign() so it behaves like a normal link navigation.
        window.location.assign(href);
      },
      true
    );
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideDropdown(dd);
      return;
    }

    // Desktop-only keyboard navigation
    if (!isDesktopPointer()) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const rows = getResultRows(dd);
      if (!rows.length) return;
      const next = (_ecwidLiveSearchActiveIndex < 0) ? 0 : _ecwidLiveSearchActiveIndex + 1;
      setActiveRow(dd, next);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = getResultRows(dd);
      if (!rows.length) return;
      const prev = (_ecwidLiveSearchActiveIndex <= 0) ? 0 : _ecwidLiveSearchActiveIndex - 1;
      setActiveRow(dd, prev);
      return;
    }

    if (e.key === 'Enter') {
      const href = getActiveHref(dd);
      if (!href) return;
      e.preventDefault();
      window.location.assign(href);
    }
  });

  return true;
}

// STEP 4 DIAGNOSTIC: Detect if our dropdown is removed during SPA navigation/rerenders
if (!window.__lsObserverInstalled) {
  window.__lsObserverInstalled = true;

  try {
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.removedNodes) {
          if (n && n.id === 'ecwid-live-search-dd') {
            console.warn('[LS] DROPDOWN REMOVED from DOM', {
              path: location.pathname + location.hash,
              time: Date.now(),
            });
          }
        }
      }
    });

    mo.observe(document.body, { childList: true, subtree: true });
  } catch (e) {
    console.warn('[LS] MutationObserver setup failed', e);
  }
}

(function bindEcwidLifecycle() {
  // Re-init when Ecwid changes pages (Instant Site SPA)
  if (window.Ecwid && window.Ecwid.OnPageLoaded && typeof window.Ecwid.OnPageLoaded.add === 'function') {
    if (!window.__ecwidLiveSearchOnPageLoadedBound) {
      window.__ecwidLiveSearchOnPageLoadedBound = true;
      window.Ecwid.OnPageLoaded.add(function () {
        // slight delay to allow DOM to settle
        setTimeout(() => {
          try { initLiveSearchOnce(); } catch {}
        }, 50);
      });
    }
  }
})();

(function boot() {
  const startedAt = Date.now();

  // Refinement 2: warm up the Worker (and its category cache) in the background
  try {
    fetch(`${WORKER_BASE_URL.replace(/\/$/, '')}/warm`, { method: 'GET', mode: 'cors' }).catch(() => {});
  } catch {}

  const timer = setInterval(() => {
    const ok = initLiveSearchOnce();
    if (ok) {
      // Do NOT stop polling. Ecwid may replace the search input after interactions (especially on mobile).
      // Keeping this running allows automatic re-bind.
      return;
    }
    // Keep polling indefinitely (low overhead). Ecwid can replace the search input long after page load.
    // If you want to reduce overhead later, we can switch to MutationObserver.
  }, 800);
})();
