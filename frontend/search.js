/**
 * 3DP Live Search – Ecwid storefront injection script
 *
 * Key design choice:
 * - Do NOT rely on input/keyup events (Ecwid can suppress them on some routes).
 * - Primary trigger is polling while the search box is focused.
 *
 * No secrets here. Talks only to your Cloudflare Worker.
 */

// ✅ Your deployed Worker base URL
const WORKER_BASE_URL = "https://ecwid-live-search.shishodia-rakesh.workers.dev";

const CONFIG = {
  minChars: 2,
  debounceMs: 200,
  pollMs: 150,
  maxProducts: 8,
  maxCategories: 6,
  dropdownOffsetPx: 8,
  loadingDelayMs: 120,
};

// Fallback icon for categories when no image is provided
const CATEGORY_FALLBACK_THUMB =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect x="10" y="18" width="44" height="34" rx="8" fill="%23E9EEF5"/>
      <path d="M18 18c0-3.314 2.686-6 6-6h10l4 4h8c3.314 0 6 2.686 6 6" fill="%23D7DFEA"/>
      <path d="M18 24h28" stroke="%23A9B6C6" stroke-width="3" stroke-linecap="round"/>
    </svg>`
  );

const LS = {
  activeInput: null,
  dd: null,
  abort: null,
  pollTimer: null,
  lastValue: "",
  activeIndex: -1,
  docHandlersBound: false,
  warmCalled: false,
};

function isDesktopPointer() {
  try {
    return window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
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

function isVisible(el) {
  if (!el) return false;
  if (el.disabled) return false;
  if (el.offsetParent === null) return false;
  const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
  if (cs && (cs.visibility === "hidden" || cs.display === "none")) return false;
  return true;
}

/**
 * IMPORTANT:
 * We keep input selection simple and deterministic for your theme.
 * We do NOT use the “first visible input” heuristic anymore (too risky).
 */
function findSearchInput() {
  const el = document.querySelector('input.ins-header__search-field[name="keyword"]');
  if (el && isVisible(el)) return el;

  // Backup selector (still strict)
  const el2 = document.querySelector('form[role="search"] input[name="keyword"]');
  if (el2 && isVisible(el2)) return el2;

  return null;
}

function ensureDropdown(anchorInput) {
  LS.dd = LS.dd || document.getElementById("ecwid-live-search-dd");

  if (!LS.dd) {
    const dd = document.createElement("div");
    dd.id = "ecwid-live-search-dd";
    dd.style.position = "absolute";
    dd.style.zIndex = "999999";
    dd.style.background = "#fff";
    dd.style.border = "1px solid rgba(0,0,0,0.12)";
    dd.style.borderRadius = "10px";
    dd.style.boxShadow = "0 10px 25px rgba(0,0,0,0.12)";
    dd.style.overflow = "hidden";
    dd.style.display = "none";
    document.body.appendChild(dd);
    LS.dd = dd;
  }

  positionDropdown(anchorInput);

  // Bind resize/scroll once
  if (!window.__lsDropdownPositionBound) {
    window.__lsDropdownPositionBound = true;
    window.addEventListener("resize", () => {
      if (LS.activeInput) positionDropdown(LS.activeInput);
    });
    window.addEventListener(
      "scroll",
      () => {
        if (LS.activeInput) positionDropdown(LS.activeInput);
      },
      true
    );
  }

  return LS.dd;
}

function positionDropdown(anchorInput) {
  if (!LS.dd || !anchorInput) return;
  const r = anchorInput.getBoundingClientRect();
  LS.dd.style.left = `${Math.round(r.left + window.scrollX)}px`;
  LS.dd.style.top = `${Math.round(r.bottom + window.scrollY + CONFIG.dropdownOffsetPx)}px`;
  LS.dd.style.width = `${Math.round(r.width)}px`;
}

function hideDropdown({ clear = true } = {}) {
  if (!LS.dd) return;
  hideInlineLoading();
  LS.dd.style.display = "none";
  if (clear) LS.dd.innerHTML = "";
  LS.activeIndex = -1;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") Object.assign(node.style, v);
    else if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v === null || v === undefined) continue;
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else if (c) node.appendChild(c);
  }
  return node;
}

function sectionTitle(txt) {
  return el(
    "div",
    {
      style: {
        padding: "10px 12px 6px",
        fontSize: "11px",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        opacity: "0.7",
        fontWeight: "700",
      },
    },
    [txt]
  );
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightNode(text, q) {
  const s = String(text || "");
  const query = String(q || "").trim();
  if (!query) return document.createTextNode(s);

  const re = new RegExp(escapeRegExp(query), "ig");
  const parts = s.split(re);
  const matches = s.match(re);
  if (!matches) return document.createTextNode(s);

  const frag = document.createDocumentFragment();
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) frag.appendChild(document.createTextNode(parts[i]));
    if (i < matches.length) {
      const m = document.createElement("mark");
      m.textContent = matches[i];
      m.style.background = "rgba(255, 230, 150, 0.85)";
      m.style.padding = "0 2px";
      m.style.borderRadius = "4px";
      frag.appendChild(m);
    }
  }
  return frag;
}

function itemRow({ titleNode, subtitle, thumb, href }) {
  const row = el("a", {
    href,
    style: {
      display: "flex",
      gap: "10px",
      alignItems: "center",
      padding: "10px 12px",
      textDecoration: "none",
      color: "#111",
    },
  });

  row.dataset.lsRow = "1";

  const img = el("div", {
    style: {
      width: "42px",
      height: "42px",
      borderRadius: "8px",
      background: "rgba(0,0,0,0.06)",
      flex: "0 0 42px",
      overflow: "hidden",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    },
  });

  if (thumb) {
    const im = new Image();
    im.src = thumb;
    im.alt = "Thumb";
    im.style.width = "100%";
    im.style.height = "100%";
    im.style.objectFit = "cover";
    img.appendChild(im);
  }

  const text = el("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } });
  const titleDiv = el("div", { style: { fontSize: "13px", fontWeight: "600" } });
  titleDiv.appendChild(titleNode || document.createTextNode(""));
  text.appendChild(titleDiv);

  if (subtitle) {
    text.appendChild(el("div", { style: { fontSize: "12px", opacity: "0.75" } }, [subtitle]));
  }

  row.appendChild(img);
  row.appendChild(text);

  // Desktop hover updates active selection
  row.addEventListener("mouseenter", () => {
    if (!isDesktopPointer()) return;
    const rows = getResultRows();
    const idx = rows.indexOf(row);
    if (idx >= 0) setActiveRow(idx);
  });

  return row;
}

function getResultRows() {
  if (!LS.dd) return [];
  return Array.from(LS.dd.querySelectorAll('a[data-ls-row="1"]'));
}

function setActiveRow(index) {
  const rows = getResultRows();
  if (!rows.length) {
    LS.activeIndex = -1;
    return;
  }
  const clamped = Math.max(0, Math.min(index, rows.length - 1));
  LS.activeIndex = clamped;

  rows.forEach((r, i) => {
    r.style.background = i === clamped ? "rgba(0,0,0,0.06)" : "transparent";
  });

  try {
    rows[clamped].scrollIntoView({ block: "nearest" });
  } catch {}
}

function getActiveHref() {
  const rows = getResultRows();
  if (LS.activeIndex < 0 || LS.activeIndex >= rows.length) return null;
  const a = rows[LS.activeIndex];
  return a ? a.href || a.getAttribute("href") : null;
}

/**
 * Non-destructive loading footer (Solution A)
 */
function showInlineLoading() {
  if (!LS.dd) return;
  let footer = LS.dd.querySelector('[data-ls-loading="1"]');
  if (footer) return;

  footer = el(
    "div",
    {
      style: {
        padding: "8px 12px",
        fontSize: "12px",
        opacity: "0.75",
        borderTop: "1px solid rgba(0,0,0,0.08)",
      },
    },
    ["Searching…"]
  );
  footer.setAttribute("data-ls-loading", "1");
  LS.dd.appendChild(footer);
}

function hideInlineLoading() {
  if (!LS.dd) return;
  const footer = LS.dd.querySelector('[data-ls-loading="1"]');
  if (footer) footer.remove();
}

/**
 * Call Worker
 */
async function fetchResults(q, signal) {
  const base = WORKER_BASE_URL.replace(/\/$/, "");
  const url = `${base}/search?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  return res.json();
}

function renderResults(payload) {
  const dd = LS.dd;
  if (!dd) return;

  const q = payload && payload.q ? String(payload.q) : "";
  LS.activeIndex = -1;

  const products = (payload.products || []).slice(0, CONFIG.maxProducts);
  const categories = (payload.categories || []).slice(0, CONFIG.maxCategories);

  dd.innerHTML = "";
  hideInlineLoading();

  if (!products.length && !categories.length) {
    dd.appendChild(el("div", { style: { padding: "12px", fontSize: "13px", opacity: "0.8" } }, ["No results"]));
    dd.style.display = "block";
    return;
  }

  if (products.length) {
    dd.appendChild(sectionTitle("Products"));
    for (const p of products) {
      dd.appendChild(
        itemRow({
          titleNode: highlightNode(p.name || "Product", q),
          subtitle: p.price ? String(p.price) : p.sku ? `SKU: ${p.sku}` : "",
          thumb: p.thumb || null,
          href: p.url || "#",
        })
      );
    }
  }

  if (categories.length) {
    dd.appendChild(sectionTitle("Categories"));
    for (const c of categories) {
      dd.appendChild(
        itemRow({
          titleNode: highlightNode(c.name || "Category", q),
          subtitle: "Category",
          thumb: c.thumb || CATEGORY_FALLBACK_THUMB,
          href: c.url || "#",
        })
      );
    }
  }

  dd.style.display = "block";
}

const runSearch = debounce(async () => {
  const input = LS.activeInput;
  if (!input) return;

  ensureDropdown(input);

  const q = (input.value || "").trim();
  if (q.length < CONFIG.minChars) {
    hideDropdown({ clear: true });
    return;
  }

  // Abort previous request
  if (LS.abort) LS.abort.abort();
  LS.abort = new AbortController();

  const loadingTimer = setTimeout(() => {
    if (LS.dd && LS.dd.style.display !== "none" && LS.dd.innerHTML.trim().length > 0) {
      showInlineLoading();
    } else {
      // first open: show a tiny skeleton
      LS.dd.innerHTML = "";
      LS.dd.appendChild(sectionTitle("Search"));
      LS.dd.appendChild(el("div", { style: { padding: "12px", fontSize: "13px", opacity: "0.8" } }, ["Searching…"]));
      LS.dd.style.display = "block";
    }
  }, CONFIG.loadingDelayMs);

  try {
    const data = await fetchResults(q, LS.abort.signal);
    clearTimeout(loadingTimer);
    hideInlineLoading();
    renderResults(data);
  } catch {
    clearTimeout(loadingTimer);
    hideInlineLoading();
    // If request fails, do not be noisy; just hide
    hideDropdown({ clear: false });
  }
}, CONFIG.debounceMs);

/**
 * Polling: the unstoppable trigger.
 * Runs only while the search input is focused.
 */
function startPolling(input) {
  LS.activeInput = input;
  LS.lastValue = input.value || "";
  ensureDropdown(input);

  if (LS.pollTimer) return;
  LS.pollTimer = setInterval(() => {
    const el = LS.activeInput;
    if (!el) return;
    if (document.activeElement !== el) return;

    const v = el.value || "";
    if (v === LS.lastValue) return;
    LS.lastValue = v;

    runSearch();
  }, CONFIG.pollMs);
}

function stopPolling() {
  if (LS.pollTimer) {
    clearInterval(LS.pollTimer);
    LS.pollTimer = null;
  }
}

/**
 * Global handlers (installed once)
 */
function bindGlobalHandlers() {
  if (LS.docHandlersBound) return;
  LS.docHandlersBound = true;

  // Close dropdown when clicking outside
  document.addEventListener(
    "click",
    (e) => {
      const input = LS.activeInput;
      const dd = LS.dd;
      if (!input || !dd) return;

      if (e.target === input) return;
      if (dd.contains(e.target)) return;

      hideDropdown({ clear: false });
    },
    true
  );

  // Navigate when clicking a dropdown item
  document.addEventListener(
    "click",
    (e) => {
      const dd = LS.dd;
      if (!dd) return;
      const a = e.target && e.target.closest ? e.target.closest("#ecwid-live-search-dd a") : null;
      if (!a) return;

      const href = a.href || a.getAttribute("href");
      if (!href) return;

      const isCoarse = (() => {
        try {
          return window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        } catch {
          return false;
        }
      })();

      if (isCoarse) {
        // Mobile/touch: allow native <a> navigation. Do not interfere.
        return;
      }

      // Desktop: programmatic navigation is fine.
      e.preventDefault();
      e.stopPropagation();
      window.location.assign(href);
    },
    true
  );

  // Focus-based polling trigger (works even if input events are suppressed)
  document.addEventListener(
    "focusin",
    (e) => {
      const t = e.target;
      if (!t || t.tagName !== "INPUT") return;
      if (!t.classList || !t.classList.contains("ins-header__search-field")) return;
      if (t.name !== "keyword") return;

      startPolling(t);
    },
    true
  );

  document.addEventListener(
    "focusout",
    (e) => {
      const t = e.target;
      if (!t || t.tagName !== "INPUT") return;
      if (!t.classList || !t.classList.contains("ins-header__search-field")) return;
      if (t.name !== "keyword") return;

      stopPolling();
    },
    true
  );

  // Desktop keyboard nav
  document.addEventListener(
    "keydown",
    (e) => {
      if (!isDesktopPointer()) return;
      if (!LS.activeInput || document.activeElement !== LS.activeInput) return;
      if (!LS.dd || LS.dd.style.display === "none") return;

      if (e.key === "Escape") {
        hideDropdown({ clear: false });
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveRow(LS.activeIndex < 0 ? 0 : LS.activeIndex + 1);
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveRow(LS.activeIndex <= 0 ? 0 : LS.activeIndex - 1);
        return;
      }

      if (e.key === "Enter") {
        const href = getActiveHref();
        if (!href) return;
        e.preventDefault();
        window.location.assign(href);
      }
    },
    true
  );
}

/**
 * Warmup worker (optional perf)
 */
function warmWorkerOnce() {
  if (LS.warmCalled) return;
  LS.warmCalled = true;
  try {
    fetch(`${WORKER_BASE_URL.replace(/\/$/, "")}/warm`, { method: "GET", mode: "cors" }).catch(() => {});
  } catch {}
}

/**
 * Boot: bind handlers, warm worker, and keep input reference fresh.
 * We poll lightly just to keep LS.activeInput fresh if Ecwid swaps header nodes.
 */
(function boot() {
  bindGlobalHandlers();
  warmWorkerOnce();

  // Keep LS.activeInput updated if header input is swapped by SPA
  setInterval(() => {
    const input = findSearchInput();
    if (input) {
      // If user is currently focused in the search box, keep the anchor updated
      if (document.activeElement === input) {
        LS.activeInput = input;
        ensureDropdown(input);
      }
    }
  }, 800);
})();