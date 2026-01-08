/**
 * Ecwid Live Search – storefront injection script (MVP)
 *
 * Loads on your Ecwid storefront and adds a typeahead dropdown under the existing search input.
 * IMPORTANT: This script must NOT contain any Ecwid secret token. It talks only to your Worker.
 */

// ✅ Your deployed Worker base URL
const WORKER_BASE_URL = 'https://ecwid-live-search.shishodia-rakesh.workers.dev';

const CONFIG = {
  minChars: 2,
  debounceMs: 200,
  maxProducts: 8,
  maxCategories: 6,
  dropdownOffsetPx: 8,
};

let _ecwidLiveSearchBoundInput = null;
let _ecwidLiveSearchDocHandlerBound = false;

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
  const selectors = [
    'input[type="search"]',
    'input[name="keyword"]',
    'form[action*="search"] input',
    '.ec-store__search input',
    '.ecwid-search input',
    '.search input',
  ];

  for (const s of selectors) {
    const el = $(s);
    if (el && el.tagName === 'INPUT') return el;
  }

  const inputs = Array.from(document.querySelectorAll('input'));
  return (
    inputs.find((i) => {
      const type = (i.getAttribute('type') || '').toLowerCase();
      const name = (i.getAttribute('name') || '').toLowerCase();
      const placeholder = (i.getAttribute('placeholder') || '').toLowerCase();
      const looks = type === 'search' || name.includes('search') || name.includes('keyword') || placeholder.includes('search');
      const visible = i.offsetParent !== null;
      return looks && visible;
    }) || null
  );
}

function ensureDropdown(anchorInput) {
  let dd = document.getElementById('ecwid-live-search-dd');
  if (dd) return dd;

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

  function position() {
    const r = anchorInput.getBoundingClientRect();
    dd.style.left = `${Math.round(r.left + window.scrollX)}px`;
    dd.style.top = `${Math.round(r.bottom + window.scrollY + CONFIG.dropdownOffsetPx)}px`;
    dd.style.width = `${Math.round(r.width)}px`;
  }

  position();
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);

  return dd;
}

function hideDropdown(dd, { clear = true } = {}) {
  dd.style.display = 'none';
  if (clear) dd.innerHTML = '';
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
  text.appendChild(el('div', { style: { fontSize: '13px', fontWeight: '600' } }, [title]));
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

  dd.innerHTML = '';

  if (!products.length && !categories.length) {
    dd.appendChild(el('div', { style: { padding: '12px', fontSize: '13px', opacity: '0.8' } }, ['No results']));
    dd.style.display = 'block';
    return;
  }

  if (products.length) {
    dd.appendChild(sectionTitle('Products'));
    for (const p of products) {
      dd.appendChild(
        itemRow({
          title: p.name || 'Product',
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
          title: c.name || 'Category',
          subtitle: 'Category',
          thumb: null,
          href: buildCategoryHref(c),
          dataAttrs: { ecwidType: 'category', ecwidId: c.id },
        })
      );
    }
  }

  dd.style.display = 'block';
}

function initLiveSearchOnce() {
  const input = findSearchInput();
  if (!input) return false;

  // Ecwid can replace the search input node (especially on mobile). Re-bind if it changes.
  if (_ecwidLiveSearchBoundInput === input) return true;
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

    try {
      const data = await fetchResults(q, abort.signal);
      render(dd, data);
    } catch {
      hideDropdown(dd);
    }
  }, CONFIG.debounceMs);

  input.addEventListener('input', run);

  if (!_ecwidLiveSearchDocHandlerBound) {
    _ecwidLiveSearchDocHandlerBound = true;

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
    if (e.key === 'Escape') hideDropdown(dd);
  });

  return true;
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
