/Users/rakeshshishodia/ecwid-live-search/worker/index.js
/**
 * Ecwid Live Search – Cloudflare Worker proxy
 *
 * REQUIRED env vars (set in Cloudflare Worker settings):
 * - ECWID_STORE_ID   (e.g. 12345678)
 * - ECWID_TOKEN      (Ecwid secret token with read_catalog scope)
 * - App being used is Custom App #6
 *
 * OPTIONAL env vars:
 * - ALLOWED_ORIGIN   (e.g. https://www.3dprintronics.com)  // enables strict CORS
 */

const ECWID_API_BASE = 'https://app.ecwid.com/api/v3';

// Simple in-memory categories cache (good enough for MVP)
let _catCache = { ts: 0, items: [] };
const CAT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function jsonResponse(data, { status = 200, origin = '*' } = {}) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  return new Response(JSON.stringify(data), { status, headers });
}

function okPreflight(origin = '*') {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function getOrigin(request, env) {
  const reqOrigin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGIN || '').trim();

  // If ALLOWED_ORIGIN is set, only allow that origin.
  if (allowed) return reqOrigin === allowed ? allowed : 'null';

  // MVP: permissive CORS. Tighten later.
  return '*';
}

function getQ(url) {
  const q = (url.searchParams.get('q') || '').trim();
  // Normalize whitespace
  return q.replace(/\s+/g, ' ');
}

async function ecwidFetch(path, env) {
  const storeId = (env.ECWID_STORE_ID || '').trim();
  const token = (env.ECWID_TOKEN || '').trim();
  if (!storeId || !token) {
    throw new Error('Missing ECWID_STORE_ID or ECWID_TOKEN in Worker environment variables');
  }

  const url = `${ECWID_API_BASE}/${storeId}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Ecwid API error ${res.status}: ${txt.slice(0, 300)}`);
  }

  return res.json();
}

async function getCategories(env) {
  const now = Date.now();
  if (_catCache.items.length && (now - _catCache.ts) < CAT_TTL_MS) {
    return _catCache.items;
  }

  const data = await ecwidFetch('/categories?hidden_categories=false&limit=250', env);
  const items = Array.isArray(data?.items) ? data.items : [];

  _catCache = { ts: now, items };
  return items;
}

function matchCategories(allCats, q, limit = 6) {
  const needle = q.toLowerCase();
  const out = [];
  for (const c of allCats) {
    const name = (c?.name || '').toString();
    if (!name) continue;
    if (name.toLowerCase().includes(needle)) {
      out.push({
        id: c.id,
        name,
        url: c.url || null,
      });
      if (out.length >= limit) break;
    }
  }
  return out;
}

function trimProducts(items = []) {
  return items.map((p) => {
    const price = p?.defaultDisplayedPriceFormatted || p?.price;
    const thumb = p?.thumbnailUrl || (Array.isArray(p?.media?.images) ? p.media.images[0]?.image160pxUrl : null);
    const url = p?.url || p?.cleanUrl || null;

    return {
      id: p?.id,
      sku: p?.sku || null,
      name: p?.name || '',
      price: price ?? null,
      thumb: thumb || null,
      url,
    };
  });
}

async function handleSearch(request, env) {
  const origin = getOrigin(request, env);
  if (origin === 'null') return jsonResponse({ error: 'CORS blocked' }, { status: 403, origin: 'null' });

  const url = new URL(request.url);
  const q = getQ(url);

  if (q.length < 2) {
    return jsonResponse({ q, products: [], categories: [] }, { origin });
  }

  const keyword = encodeURIComponent(`${q}*`);

  const params = [
    `keyword=${keyword}`,
    'searchMethod=STOREFRONT',
    'enabled=true',
    'visibleInStorefront=true',
    'sortBy=RELEVANCE',
    'limit=8',
    'cleanUrls=true',
  ].join('&');

  const data = await ecwidFetch(`/products?${params}`, env);
  const products = trimProducts(Array.isArray(data?.items) ? data.items : []);

  let categories = [];
  try {
    const allCats = await getCategories(env);
    categories = matchCategories(allCats, q, 6);
  } catch {
    categories = [];
  }

  return jsonResponse({ q, products, categories }, { origin });
}

export default {
  async fetch(request, env) {
    const origin = getOrigin(request, env);

    if (request.method === 'OPTIONS') {
      if (origin === 'null') return okPreflight('null');
      return okPreflight(origin);
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/search' && request.method === 'GET') {
        return await handleSearch(request, env);
      }

      if (url.pathname === '/' && request.method === 'GET') {
        return jsonResponse({ ok: true, service: 'ecwid-live-search-worker' }, { origin });
      }

      return jsonResponse({ error: 'Not found' }, { status: 404, origin });
    } catch (err) {
      return jsonResponse(
        {
          error: 'Internal error',
          message: err?.message || String(err),
        },
        { status: 500, origin }
      );
    }
  },
};

/Users/rakeshshishodia/ecwid-live-search/frontend/search.js
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

function hideDropdown(dd) {
  dd.style.display = 'none';
  dd.innerHTML = '';
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

function itemRow({ title, subtitle, thumb, href }) {
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
        })
      );
    }
  }

  dd.style.display = 'block';
}

function initLiveSearchOnce() {
  const input = findSearchInput();
  if (!input) return false;

  if (input.dataset.ecwidLiveSearchInit === '1') return true;
  input.dataset.ecwidLiveSearchInit = '1';

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

  document.addEventListener('click', (e) => {
    if (e.target === input) return;
    if (dd.contains(e.target)) return;
    hideDropdown(dd);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideDropdown(dd);
  });

  return true;
}

(function boot() {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const ok = initLiveSearchOnce();
    if (ok) {
      clearInterval(timer);
      return;
    }
    if (Date.now() - startedAt > 30000) clearInterval(timer);
  }, 300);
})();

/Users/rakeshshishodia/ecwid-live-search/wrangler.toml
name = "ecwid-live-search"
main = "worker/index.js"
compatibility_date = "2026-01-08"
