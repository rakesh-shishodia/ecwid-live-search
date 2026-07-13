export const SEARCH_ANALYTICS_DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Search Intelligence</title>
  <style>
    :root {
      --ink: #17221d;
      --muted: #637069;
      --paper: #f4f1e8;
      --card: #fffdf7;
      --line: #d9d5c9;
      --green: #176b4d;
      --orange: #d85a31;
      --yellow: #f4c95d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at 85% 8%, rgba(244, 201, 93, .35), transparent 24rem),
        linear-gradient(135deg, #f8f5ec 0%, var(--paper) 62%, #e7eee7 100%);
      font-family: Georgia, "Times New Roman", serif;
      min-height: 100vh;
    }
    main { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 44px 0 64px; }
    header { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
    .eyebrow { color: var(--green); font: 700 12px/1.2 ui-monospace, monospace; letter-spacing: .14em; text-transform: uppercase; }
    h1 { max-width: 700px; margin: 8px 0 0; font-size: clamp(34px, 6vw, 68px); font-weight: 500; line-height: .95; letter-spacing: -.04em; }
    .periods { display: flex; padding: 4px; border: 1px solid var(--line); border-radius: 999px; background: rgba(255, 253, 247, .8); }
    button { border: 0; border-radius: 999px; padding: 10px 15px; color: var(--muted); background: transparent; cursor: pointer; font: 700 13px/1 ui-monospace, monospace; }
    button.active { color: white; background: var(--green); }
    .status { min-height: 22px; color: var(--muted); font: 13px/1.4 ui-monospace, monospace; }
    .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 10px 0 28px; }
    .card { min-height: 130px; padding: 20px; border: 1px solid var(--line); border-radius: 18px; background: rgba(255, 253, 247, .86); box-shadow: 0 12px 35px rgba(23, 34, 29, .05); }
    .card strong { display: block; margin-top: 18px; font-size: clamp(30px, 4vw, 45px); font-weight: 500; line-height: 1; }
    .label { color: var(--muted); font: 12px/1.3 ui-monospace, monospace; text-transform: uppercase; letter-spacing: .06em; }
    .tables { display: grid; grid-template-columns: 1.35fr 1fr; gap: 18px; }
    section { overflow: hidden; border: 1px solid var(--line); border-radius: 20px; background: var(--card); }
    section h2 { margin: 0; padding: 20px 22px; border-bottom: 1px solid var(--line); font-size: 22px; font-weight: 500; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 13px 22px; border-bottom: 1px solid #ebe7dc; text-align: left; }
    th { color: var(--muted); font: 700 11px/1.2 ui-monospace, monospace; letter-spacing: .06em; text-transform: uppercase; }
    td { font-size: 15px; }
    td.number, th.number { text-align: right; font-family: ui-monospace, monospace; }
    tr:last-child td { border-bottom: 0; }
    .term { max-width: 330px; overflow-wrap: anywhere; }
    .zero { color: var(--green); }
    .miss { color: var(--orange); font-weight: 700; }
    .empty { padding: 38px 22px; color: var(--muted); text-align: center; font-style: italic; }
    footer { margin-top: 18px; color: var(--muted); font: 12px/1.5 ui-monospace, monospace; }
    @media (max-width: 800px) {
      main { width: min(100% - 20px, 680px); padding-top: 26px; }
      header { display: block; }
      .periods { width: max-content; margin-top: 22px; }
      .cards { grid-template-columns: repeat(2, 1fr); }
      .tables { grid-template-columns: 1fr; }
      th, td { padding: 12px 14px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <div class="eyebrow">3DPrintronics / Live Search</div>
        <h1>Search intelligence</h1>
      </div>
      <nav class="periods" aria-label="Reporting period">
        <button data-days="1" class="active">24 hours</button>
        <button data-days="7">7 days</button>
        <button data-days="30">30 days</button>
      </nav>
    </header>

    <div id="status" class="status">Loading current search data...</div>
    <div class="cards">
      <article class="card"><span class="label">Total searches</span><strong id="total">-</strong></article>
      <article class="card"><span class="label">Unique terms</span><strong id="unique">-</strong></article>
      <article class="card"><span class="label">No-result searches</span><strong id="misses">-</strong></article>
      <article class="card"><span class="label">No-result rate</span><strong id="rate">-</strong></article>
    </div>

    <div class="tables">
      <section>
        <h2>Most searched</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Search term</th><th class="number">Searches</th><th class="number">No result</th><th>Last searched (IST)</th></tr></thead>
          <tbody id="popular"></tbody>
        </table></div>
      </section>
      <section>
        <h2>Demand without results</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Search term</th><th class="number">Misses</th><th class="number">Total</th></tr></thead>
          <tbody id="no-results"></tbody>
        </table></div>
      </section>
    </div>
    <footer>Counts are aggregated by hour. Data refreshes whenever this page or its period is reloaded. Search collection remains independent of this dashboard.</footer>
  </main>
  <script>
    const formatNumber = new Intl.NumberFormat('en-IN');

    function cell(row, value, className = '') {
      const td = document.createElement('td');
      td.className = className;
      td.textContent = value;
      row.appendChild(td);
    }

    function showEmpty(tbody, columns, message) {
      const row = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = columns;
      td.className = 'empty';
      td.textContent = message;
      row.appendChild(td);
      tbody.replaceChildren(row);
    }

    function render(data) {
      const summary = data.summary;
      document.querySelector('#total').textContent = formatNumber.format(summary.totalSearches);
      document.querySelector('#unique').textContent = formatNumber.format(summary.uniqueTerms);
      document.querySelector('#misses').textContent = formatNumber.format(summary.noResultSearches);
      document.querySelector('#rate').textContent = summary.noResultPercentage + '%';

      const popular = document.querySelector('#popular');
      popular.replaceChildren();
      for (const item of data.popularTerms) {
        const row = document.createElement('tr');
        cell(row, item.term, 'term');
        cell(row, formatNumber.format(item.searches), 'number');
        cell(row, formatNumber.format(item.noResultSearches), item.noResultSearches ? 'number miss' : 'number zero');
        cell(row, item.lastSearchedIst);
        popular.appendChild(row);
      }
      if (!data.popularTerms.length) showEmpty(popular, 4, 'No searches recorded in this period yet.');

      const noResults = document.querySelector('#no-results');
      noResults.replaceChildren();
      for (const item of data.noResultTerms) {
        const row = document.createElement('tr');
        cell(row, item.term, 'term');
        cell(row, formatNumber.format(item.noResultSearches), 'number miss');
        cell(row, formatNumber.format(item.searches), 'number');
        noResults.appendChild(row);
      }
      if (!data.noResultTerms.length) showEmpty(noResults, 3, 'No unmet searches in this period.');
    }

    async function load(days) {
      const status = document.querySelector('#status');
      status.textContent = 'Loading current search data...';
      try {
        const response = await fetch('/analytics/stats?days=' + days, { cache: 'no-store' });
        if (!response.ok) throw new Error('Request failed (' + response.status + ')');
        const data = await response.json();
        render(data);
        status.textContent = 'Updated ' + data.generatedAtIst + ' · ' + data.periodLabel;
      } catch (error) {
        status.textContent = 'Could not load statistics: ' + error.message;
      }
    }

    document.querySelector('.periods').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-days]');
      if (!button) return;
      document.querySelectorAll('.periods button').forEach((item) => item.classList.toggle('active', item === button));
      load(button.dataset.days);
    });

    load(1);
  </script>
</body>
</html>`;
