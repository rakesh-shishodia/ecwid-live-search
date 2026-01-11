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

  // Request image-related fields explicitly so category thumbnails are available when set in Ecwid.
  // Ecwid supports `responseFields` to limit/shape the response.
  const responseFields = encodeURIComponent(
    'items(id,name,url,thumbnailUrl,imageUrl,image(url,url160px,url320px)),count,limit,offset,total'
  );

  const data = await ecwidFetch(
    `/categories?hidden_categories=false&limit=250&responseFields=${responseFields}`,
    env
  );
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
      const thumb =
        c.thumbnailUrl ||
        c.imageUrl ||
        c.image?.url160px ||
        c.image?.url320px ||
        c.image?.url ||
        null;

      out.push({
        id: c.id,
        name,
        url: c.url || null,
        thumb,
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
      inStock: typeof p?.quantity === 'number'
        ? p.quantity > 0
        : p?.inStock === true,
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

      // Warmup endpoint: primes category cache (reduces first-search latency)
      if (url.pathname === '/warm' && request.method === 'GET') {
        await getCategories(env);
        return jsonResponse({ ok: true, warmed: true }, { origin });
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
