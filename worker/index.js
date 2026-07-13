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
 * - ANALYTICS_ALLOWED_ORIGIN // required origin for analytics events
 */

const ECWID_API_BASE = 'https://app.ecwid.com/api/v3';
const SEARCH_CACHE_TTL_SECONDS = 5 * 60;
const SEARCH_CACHE_VERSION = 'v1';
const ANALYTICS_RETENTION_DAYS = 31;
const MAX_ANALYTICS_BODY_BYTES = 2048;
const MAX_ANALYTICS_TERM_LENGTH = 120;

// Simple in-memory categories cache (good enough for MVP)
let _catCache = { ts: 0, items: [] };
const CAT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function jsonResponse(data, { status = 200, origin = '*', extraHeaders = {} } = {}) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function okPreflight(origin = '*') {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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

function getAnalyticsOrigin(request, env) {
  const reqOrigin = request.headers.get('Origin') || '';
  const allowed = (env.ANALYTICS_ALLOWED_ORIGIN || env.ALLOWED_ORIGIN || '').trim();
  return allowed && reqOrigin === allowed ? allowed : 'null';
}

function getQ(url) {
  const q = (url.searchParams.get('q') || '').trim();
  // Normalize whitespace
  return q.replace(/\s+/g, ' ');
}

function normalizeAnalyticsTerm(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeResultCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 0;
  return Math.min(1000, Math.max(0, Math.trunc(count)));
}

function isLikelyEmail(value) {
  return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(value);
}

async function recordSearchAnalytics(env, event) {
  const storeId = (env.ECWID_STORE_ID || '').trim();
  if (!storeId || !env.STATS_DB) throw new Error('Missing ECWID_STORE_ID or STATS_DB binding');

  const now = Math.floor(Date.now() / 1000);
  const hourStart = Math.floor(now / 3600) * 3600;
  const noResult = event.productCount === 0 && event.categoryCount === 0 ? 1 : 0;

  await env.STATS_DB.prepare(
    `INSERT INTO search_terms_hourly (
       store_id,
       hour_start,
       search_term,
       search_count,
       no_result_count,
       product_result_total,
       category_result_total,
       last_searched_at
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT (store_id, hour_start, search_term) DO UPDATE SET
       search_count = search_count + 1,
       no_result_count = no_result_count + excluded.no_result_count,
       product_result_total = product_result_total + excluded.product_result_total,
       category_result_total = category_result_total + excluded.category_result_total,
       last_searched_at = excluded.last_searched_at`
  )
    .bind(
      storeId,
      hourStart,
      event.term,
      noResult,
      event.productCount,
      event.categoryCount,
      now
    )
    .run();
}

async function handleSearchAnalytics(request, env, ctx) {
  const origin = getAnalyticsOrigin(request, env);
  if (origin === 'null') {
    return jsonResponse({ error: 'CORS blocked' }, { status: 403, origin: 'null' });
  }
  if (!env.STATS_DB) {
    return jsonResponse({ error: 'Analytics unavailable' }, { status: 503, origin });
  }

  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_ANALYTICS_BODY_BYTES) {
    return jsonResponse({ error: 'Payload too large' }, { status: 413, origin });
  }

  const body = await request.text();
  if (body.length > MAX_ANALYTICS_BODY_BYTES) {
    return jsonResponse({ error: 'Payload too large' }, { status: 413, origin });
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, { status: 400, origin });
  }

  const term = normalizeAnalyticsTerm(payload?.query);
  if (term.length < 2 || term.length > MAX_ANALYTICS_TERM_LENGTH || isLikelyEmail(term)) {
    return jsonResponse({ error: 'Invalid search term' }, { status: 400, origin });
  }

  const event = {
    term,
    productCount: normalizeResultCount(payload?.productCount),
    categoryCount: normalizeResultCount(payload?.categoryCount),
  };

  ctx.waitUntil(
    recordSearchAnalytics(env, event).catch((err) => {
      console.error({
        event: 'search_analytics_error',
        message: err?.message || String(err),
      });
    })
  );

  return jsonResponse({ accepted: true }, { status: 202, origin });
}

async function deleteExpiredSearchAnalytics(env) {
  if (!env.STATS_DB) return;
  const cutoff = Math.floor(Date.now() / 1000) - ANALYTICS_RETENTION_DAYS * 24 * 60 * 60;
  await env.STATS_DB.prepare('DELETE FROM search_terms_hourly WHERE hour_start < ?')
    .bind(cutoff)
    .run();
}

function getSearchCacheKey(request, q) {
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = `/_cache/search/${SEARCH_CACHE_VERSION}`;
  cacheUrl.search = '';
  cacheUrl.searchParams.set('q', q.toLowerCase());
  return new Request(cacheUrl.toString(), { method: 'GET' });
}

function withSearchCacheStatus(response, cacheStatus, cacheMs, preserveTiming = false) {
  const headers = new Headers(response.headers);
  const cacheTiming = `cache;desc="${cacheStatus}";dur=${cacheMs.toFixed(1)}`;
  const existingTiming = preserveTiming ? headers.get('Server-Timing') : null;

  headers.set('Cache-Control', 'no-store');
  headers.set('Access-Control-Expose-Headers', 'Server-Timing, X-Search-Cache');
  headers.set('X-Search-Cache', cacheStatus);
  headers.set('Server-Timing', existingTiming ? `${cacheTiming}, ${existingTiming}` : cacheTiming);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function logSearchCache(cacheStatus, q, started, responseStatus) {
  console.log({
    event: 'search_cache',
    cacheStatus,
    queryLength: q.length,
    durationMs: Math.round(performance.now() - started),
    responseStatus,
  });
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
      inStock: typeof p?.inStock === 'boolean'
        ? p.inStock
        : (typeof p?.quantity === 'number' ? p.quantity > 0 : false),
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
  const responseFields = encodeURIComponent(
    'items(id,sku,name,defaultDisplayedPriceFormatted,price,inStock,quantity,thumbnailUrl,url,cleanUrl,media(images(image160pxUrl)))'
  );

  const params = [
    `keyword=${keyword}`,
    'searchMethod=STOREFRONT',
    'enabled=true',
    'visibleInStorefront=true',
    'sortBy=RELEVANCE',
    'limit=8',
    'cleanUrls=true',
    `responseFields=${responseFields}`,
  ].join('&');

  const searchStarted = performance.now();
  let productsMs = 0;
  let categoriesMs = 0;

  const productsStarted = performance.now();
  const productsPromise = ecwidFetch(`/products?${params}`, env).finally(() => {
    productsMs = performance.now() - productsStarted;
  });

  const categoriesStarted = performance.now();
  const categoriesPromise = getCategories(env)
    .then((allCats) => matchCategories(allCats, q, 6))
    .catch(() => [])
    .finally(() => {
      categoriesMs = performance.now() - categoriesStarted;
    });

  const [data, categories] = await Promise.all([productsPromise, categoriesPromise]);
  const products = trimProducts(Array.isArray(data?.items) ? data.items : []);
  const totalMs = performance.now() - searchStarted;

  return jsonResponse(
    { q, products, categories },
    {
      origin,
      extraHeaders: {
        'Access-Control-Expose-Headers': 'Server-Timing',
        'Server-Timing': `ecwid-products;dur=${productsMs.toFixed(1)}, categories;dur=${categoriesMs.toFixed(1)}, total;dur=${totalMs.toFixed(1)}`,
        'Timing-Allow-Origin': origin,
      },
    }
  );
}

async function handleCachedSearch(request, env, ctx) {
  const origin = getOrigin(request, env);
  const q = getQ(new URL(request.url));

  // Preserve the existing validation response and never cache rejected origins.
  if (origin === 'null' || q.length < 2) return handleSearch(request, env);

  const started = performance.now();
  const cacheKey = getSearchCacheKey(request, q);
  let cache = null;
  let cachedResponse;
  const cacheStarted = performance.now();

  try {
    cache = caches.default;
    cachedResponse = await cache.match(cacheKey);
  } catch (err) {
    console.error({
      event: 'search_cache_error',
      operation: 'match',
      message: err?.message || String(err),
    });
  }

  const cacheMs = performance.now() - cacheStarted;
  if (cachedResponse) {
    logSearchCache('HIT', q, started, cachedResponse.status);
    return withSearchCacheStatus(cachedResponse, 'HIT', cacheMs);
  }

  const response = await handleSearch(request, env);

  if (response.status === 200 && cache) {
    const cacheSource = response.clone();
    const cacheHeaders = new Headers(cacheSource.headers);
    cacheHeaders.set('Cache-Control', `public, max-age=${SEARCH_CACHE_TTL_SECONDS}`);
    cacheHeaders.delete('Server-Timing');
    cacheHeaders.delete('X-Search-Cache');

    const cacheResponse = new Response(cacheSource.body, {
      status: cacheSource.status,
      statusText: cacheSource.statusText,
      headers: cacheHeaders,
    });

    ctx.waitUntil(
      cache.put(cacheKey, cacheResponse).catch((err) => {
        console.error({
          event: 'search_cache_error',
          operation: 'put',
          message: err?.message || String(err),
        });
      })
    );
  }

  logSearchCache('MISS', q, started, response.status);
  return withSearchCacheStatus(response, 'MISS', cacheMs, true);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = url.pathname === '/analytics/search'
      ? getAnalyticsOrigin(request, env)
      : getOrigin(request, env);

    if (request.method === 'OPTIONS') {
      if (origin === 'null') return okPreflight('null');
      return okPreflight(origin);
    }

    try {
      if (url.pathname === '/search' && request.method === 'GET') {
        return await handleCachedSearch(request, env, ctx);
      }

      if (url.pathname === '/analytics/search' && request.method === 'POST') {
        return await handleSearchAnalytics(request, env, ctx);
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

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      deleteExpiredSearchAnalytics(env).catch((err) => {
        console.error({
          event: 'search_analytics_cleanup_error',
          message: err?.message || String(err),
        });
      })
    );
  },
};
