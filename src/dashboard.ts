/**
 * Self-contained dashboard served at /dashboard.
 *
 * Design: a quiet, light "index" surface (system sans + monospace for ids and
 * dates), a left rail for sections, and one bold element — the dark relations
 * canvas. The detail drawer is the only raised surface and slides on the iOS
 * drawer curve; everything else moves only to acknowledge input.
 *
 * No inner template literals (so it can live in a TS string) and no external
 * assets (works offline, no build step).
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MemoryHub</title>
<style>
  :root {
    --bg: #eef0f4;
    --surface: #ffffff;
    --surface-2: #f6f7fa;
    --ink: #171a20;
    --muted: #667085;
    --line: #d9dce4;
    --line-strong: #c3c8d4;
    --accent: #2b59d8;
    --signal: #b45309;
    --ok: #0f7b5a;
    --canvas: #0f1116;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
    --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
    --dur-1: 120ms;
    --dur-2: 180ms;
    --dur-3: 240ms;
    --dur-4: 320ms;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .mono { font-family: var(--mono); font-size: 12px; letter-spacing: -0.01em; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
  button, input, select { font: inherit; color: inherit; }
  button { cursor: pointer; transition: transform var(--dur-1) var(--ease-out), background-color var(--dur-1) ease, border-color var(--dur-1) ease, color var(--dur-1) ease; }
  button:active { transform: scale(0.97); }
  input, select {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 11px;
    transition: border-color var(--dur-1) ease;
  }
  input:focus, select:focus { border-color: var(--line-strong); }
  input::placeholder { color: #98a0b0; }

  .app { display: grid; grid-template-columns: 236px minmax(0, 1fr); min-height: 100%; }

  /* --- left rail --- */
  .rail {
    position: sticky; top: 0; height: 100vh;
    display: flex; flex-direction: column; gap: 26px;
    padding: 26px 18px 20px 22px;
    border-right: 1px solid var(--line);
    background: #f7f8fa;
  }
  .brand { display: flex; align-items: center; gap: 10px; }
  .mark {
    width: 18px; height: 18px; border-radius: 5px;
    background: conic-gradient(from 210deg, var(--accent), #7aa2ff 40%, var(--signal) 75%, var(--accent));
  }
  .brand-name { font-weight: 650; letter-spacing: -0.015em; font-size: 15px; }
  .nav { display: flex; flex-direction: column; gap: 2px; }
  .nav-item {
    position: relative;
    text-align: left; background: none; border: 0;
    padding: 8px 10px 8px 14px; border-radius: 7px;
    color: var(--muted); font-size: 13.5px;
  }
  .nav-item::before {
    content: ""; position: absolute; left: 0; top: 50%; width: 3px; height: 0;
    background: var(--ink); border-radius: 2px; transform: translateY(-50%);
    transition: height var(--dur-2) var(--ease-out);
  }
  .nav-item:hover { color: var(--ink); background: #eef0f4; }
  .nav-item.is-active { color: var(--ink); font-weight: 600; }
  .nav-item.is-active::before { height: 15px; }
  .rail-foot { margin-top: auto; display: flex; flex-direction: column; gap: 6px; }
  .rail-stats { display: flex; flex-direction: column; gap: 3px; font-family: var(--mono); font-size: 12px; color: var(--muted); }
  .rail-stats b { color: var(--ink); font-weight: 600; }
  .rail-meta { font-size: 11.5px; color: #8b93a3; }

  /* --- main --- */
  .main { min-width: 0; padding: 30px 34px 64px; }
  .page-head { margin-bottom: 18px; }
  h1 { font-size: 22px; line-height: 1.25; letter-spacing: -0.02em; margin: 0 0 4px; font-weight: 650; }
  .lede { margin: 0; color: var(--muted); max-width: 68ch; }
  .panel { opacity: 0; transition: opacity var(--dur-1) var(--ease-out); }
  .panel.is-active { opacity: 1; }
  .panel[hidden] { display: none; }

  .toolbar {
    position: sticky; top: 0; z-index: 5;
    display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
    padding: 10px 0 12px; margin-bottom: 6px;
    background: linear-gradient(var(--bg) 72%, rgba(238,240,244,0.6));
    border-bottom: 1px solid var(--line);
  }
  .toolbar .grow { flex: 1; min-width: 220px; }
  .btn {
    background: var(--surface); border: 1px solid var(--line); border-radius: 8px;
    padding: 8px 13px; font-size: 13px; font-weight: 550;
  }
  .btn:hover { border-color: var(--line-strong); }
  .btn.primary { background: var(--ink); border-color: var(--ink); color: #fff; }
  .btn.primary:hover { background: #232833; }
  .btn.ghost { background: transparent; border-color: transparent; color: var(--muted); }
  .btn.ghost:hover { background: #e9ecf2; color: var(--ink); }
  .btn[disabled] { opacity: 0.4; cursor: default; }
  .check { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; }
  .check input { padding: 0; }

  /* --- table --- */
  .table-wrap { border-top: 1px solid var(--line); }
  table { width: 100%; border-collapse: collapse; }
  th { font-size: 12px; font-weight: 550; color: var(--muted); text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  td { padding: 11px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tbody tr { cursor: pointer; transition: background-color var(--dur-1) ease; }
  @media (hover: hover) and (pointer: fine) { tbody tr:hover { background: var(--surface); } }
  .cell-text { max-width: 58ch; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 7px; vertical-align: 1px; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px 2px 8px; border: 1px solid var(--line); border-radius: 999px; font-size: 12px; background: var(--surface); white-space: nowrap; }
  .muted { color: var(--muted); }
  .empty { padding: 26px 12px; color: var(--muted); }
  .pager { display: flex; gap: 8px; align-items: center; padding-top: 14px; }

  /* --- stat strip --- */
  .strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--surface); }
  .strip .cell { padding: 15px 17px; border-right: 1px solid var(--line); }
  .strip .cell:last-child { border-right: 0; }
  .strip .k { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .strip .v { font-family: var(--mono); font-size: 19px; font-weight: 600; letter-spacing: -0.02em; }
  .strip .v.total { font-size: 26px; }

  /* --- clusters --- */
  .cluster { margin: 0 0 9px; }
  .cluster-top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 5px; }
  .cluster-name { font-size: 13px; }
  .cluster-count { font-family: var(--mono); font-size: 12px; color: var(--muted); }
  .track { height: 7px; background: #e7eaf0; border-radius: 4px; overflow: hidden; }
  .fill { height: 100%; width: 100%; transform-origin: left center; transform: scaleX(0); transition: transform var(--dur-3) var(--ease-out); border-radius: 4px; }
  .section-title { font-size: 13px; font-weight: 600; margin: 26px 0 10px; letter-spacing: -0.01em; }
  .section-title:first-child { margin-top: 0; }

  /* --- relations canvas (the one bold surface) --- */
  .canvas-wrap { background: var(--canvas); border-radius: 14px; padding: 10px; border: 1px solid #1d2129; }
  svg#graph { display: block; width: 100%; height: min(70vh, 680px); border-radius: 9px; }
  .legend { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 10px; font-size: 12px; color: var(--muted); }
  .legend .dot { width: 7px; height: 7px; }
  .slider { display: inline-flex; align-items: center; gap: 9px; color: var(--muted); font-size: 13px; }
  input[type="range"] { accent-color: var(--accent); width: 150px; }

  /* --- drawer --- */
  .backdrop {
    position: fixed; inset: 0; background: rgba(16, 19, 26, 0.34);
    opacity: 0; transition: opacity var(--dur-3) var(--ease-out); z-index: 40;
  }
  .backdrop.is-open { opacity: 1; }
  .drawer {
    position: fixed; top: 0; right: 0; z-index: 50;
    height: 100%; width: min(620px, 94vw);
    background: var(--surface); border-left: 1px solid var(--line);
    transform: translateX(100%);
    transition: transform var(--dur-4) var(--ease-drawer);
    overflow-y: auto; padding: 24px 26px 48px;
    box-shadow: -30px 0 70px rgba(16, 19, 26, 0.12);
  }
  .drawer.is-open { transform: translateX(0); }
  .drawer.is-closing { transition-duration: var(--dur-2); transition-timing-function: var(--ease-out); }
  /* The UA [hidden] rule loses to the fixed-position rules above, so be explicit:
     otherwise the invisible backdrop swallows every click. */
  .backdrop[hidden], .drawer[hidden] { display: none; }
  .drawer h2 { font-size: 13px; font-weight: 600; margin: 22px 0 8px; letter-spacing: -0.01em; }
  .drawer h2:first-of-type { margin-top: 0; }
  .drawer-close { position: absolute; top: 16px; right: 18px; }
  .drawer-text { max-width: 72ch; }
  .meta-row { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 6px; }
  .idline { font-family: var(--mono); font-size: 11.5px; color: var(--muted); word-break: break-all; }
  .rel {
    display: flex; align-items: baseline; justify-content: space-between; gap: 14px;
    padding: 9px 0; border-bottom: 1px solid var(--line); cursor: pointer;
    transition: background-color var(--dur-1) ease;
  }
  @media (hover: hover) and (pointer: fine) { .rel:hover { background: var(--surface-2); } }
  .rel-text { min-width: 0; }
  .score { font-family: var(--mono); font-size: 11.5px; color: var(--ok); }
  .link-add { display: flex; gap: 8px; margin-top: 10px; }
  .link-add input { flex: 1; font-family: var(--mono); font-size: 12px; }
  .unlink { border: 1px solid var(--line); background: var(--surface); border-radius: 6px; padding: 2px 8px; font-size: 11.5px; color: var(--muted); }

  /* --- manage: new/edit, duplicates, settings --- */
  .drawer textarea { width: 100%; min-height: 130px; background: var(--surface-2); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 10px 11px; font: inherit; resize: vertical; }
  .form-row { display: grid; grid-template-columns: 120px 1fr; gap: 10px; align-items: center; margin: 8px 0; }
  .form-row > label { color: var(--muted); font-size: 13px; }
  .form-row input:not([type="checkbox"]), .form-row select { width: 100%; }
  .form-row input[type="checkbox"] { width: auto; }
  .dup-card { border: 1px solid var(--line); border-radius: 10px; padding: 6px 14px; margin-bottom: 10px; background: var(--surface); }
  .dup-card .rel:last-child { border-bottom: 0; }
  .config-row { display: grid; grid-template-columns: 230px minmax(0, 1fr) auto auto auto; gap: 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--line); }
  .config-key { font-family: var(--mono); font-size: 12px; color: var(--muted); }
  .config-row input[type="text"] { width: 100%; }
  .config-row .save { padding: 6px 11px; font-size: 12px; }
  .saved { color: var(--ok); font-size: 12px; }

  @media (max-width: 860px) {
    .app { grid-template-columns: 1fr; }
    .rail { position: static; height: auto; flex-direction: row; align-items: center; gap: 14px; padding: 12px 16px; border-right: 0; border-bottom: 1px solid var(--line); overflow-x: auto; }
    .nav { flex-direction: row; }
    .nav-item::before { display: none; }
    .nav-item.is-active { background: #e9ecf2; }
    .rail-foot { display: none; }
    .main { padding: 22px 16px 48px; }
    .cell-text { max-width: 40ch; }
  }

  @media (prefers-reduced-motion: reduce) {
    .panel { transition: none; }
    .drawer { transition: opacity var(--dur-1) ease; transform: none; opacity: 0; }
    .drawer.is-open { opacity: 1; }
    .drawer.is-closing { transition: none; }
    button:active { transform: none; }
    .fill { transition: none; }
  }
</style>
</head>
<body>
<div class="app">
  <aside class="rail">
    <div class="brand"><span class="mark" aria-hidden="true"></span><span class="brand-name">MemoryHub</span></div>
    <nav class="nav" role="tablist" aria-label="Views">
      <button role="tab" class="nav-item is-active" data-tab="memories" aria-selected="true">Memories</button>
      <button role="tab" class="nav-item" data-tab="clusters" aria-selected="false">Projects</button>
      <button role="tab" class="nav-item" data-tab="stats" aria-selected="false">Health</button>
      <button role="tab" class="nav-item" data-tab="relations" aria-selected="false">Relations</button>
      <button role="tab" class="nav-item" data-tab="duplicates" aria-selected="false">Duplicates</button>
      <button role="tab" class="nav-item" data-tab="settings" aria-selected="false">Settings</button>
    </nav>
    <div class="rail-foot">
      <div class="rail-stats" id="rail-stats"></div>
      <div class="rail-meta">collection <span class="mono" id="rail-collection">—</span></div>
    </div>
  </aside>

  <main class="main">
    <section class="panel is-active" id="tab-memories" role="tabpanel">
      <header class="page-head">
        <h1>Memories</h1>
        <p class="lede">Everything MemoryHub knows. Search it, filter by project or source, and open a row to see what it relates to.</p>
      </header>
      <div class="toolbar">
        <input class="grow" id="q" aria-label="Search memories" placeholder="Search memories by meaning…">
        <label class="check"><input type="checkbox" id="exact"> Exact text</label>
        <select id="project" aria-label="Filter by project"><option value="">All projects</option></select>
        <input id="source" aria-label="Filter by source" placeholder="Source" style="width:130px">
        <button class="btn primary" id="doSearch">Search</button>
        <button class="btn" id="newMemory">New memory</button>
        <span class="muted mono" id="count"></span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th style="width:52%">Memory</th><th>Project</th><th>Source</th><th>Importance</th><th>Added</th><th>Links</th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
        <div class="empty" id="empty" hidden>No memories match. Try a broader search or clear the filters.</div>
      </div>
      <div class="pager">
        <button class="btn" id="prev" disabled>Previous</button>
        <button class="btn" id="next" disabled>Next</button>
      </div>
    </section>

    <section class="panel" id="tab-clusters" role="tabpanel" hidden>
      <header class="page-head">
        <h1>Projects</h1>
        <p class="lede">Where your memories live, by project and by source.</p>
      </header>
      <div class="section-title">By project</div>
      <div id="clusters-project"></div>
      <div class="section-title">By source</div>
      <div id="clusters-source"></div>
    </section>

    <section class="panel" id="tab-stats" role="tabpanel" hidden>
      <header class="page-head">
        <h1>Health</h1>
        <p class="lede">Collection totals, expiry and memories that have aged past the review window.</p>
      </header>
      <div class="strip" id="stat-strip"></div>
      <div class="section-title">Older than 90 days</div>
      <div id="stale"></div>
    </section>

    <section class="panel" id="tab-relations" role="tabpanel" hidden>
      <header class="page-head">
        <h1>Relations</h1>
        <p class="lede">Edges are either explicit links you made or semantic neighbours above the threshold. Select a node to open it.</p>
      </header>
      <div class="toolbar">
        <label class="slider">Similarity ≥ <input type="range" id="thr" min="30" max="90" value="60"> <span class="mono" id="thrv">0.60</span></label>
        <button class="btn" id="reloadGraph">Rebuild</button>
        <span class="muted mono" id="graphinfo"></span>
      </div>
      <div class="canvas-wrap"><svg id="graph" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid meet"></svg></div>
      <div class="legend">
        <span><span class="dot" style="background:#6ea8fe"></span>similarity</span>
        <span><span class="dot" style="background:#f5a623"></span>explicit link</span>
      </div>
    </section>

    <section class="panel" id="tab-duplicates" role="tabpanel" hidden>
      <header class="page-head">
        <h1>Duplicates</h1>
        <p class="lede">Memories that say almost the same thing. Open them, then delete the one you don't need.</p>
      </header>
      <div class="toolbar">
        <label class="slider">Similarity ≥ <input type="range" id="dupThr" min="90" max="100" value="98"> <span class="mono" id="dupThrv">0.98</span></label>
        <button class="btn" id="reloadDup">Scan</button>
        <span class="muted mono" id="dupinfo"></span>
      </div>
      <div id="dup-list"></div>
    </section>

    <section class="panel" id="tab-settings" role="tabpanel" hidden>
      <header class="page-head">
        <h1>Settings</h1>
        <p class="lede">Live configuration. Changes apply immediately; leave "Save to file" ticked to keep them across restarts. Secrets are masked — type a new value to replace one.</p>
      </header>
      <div id="config-list"></div>
    </section>
  </main>
</div>

<div class="backdrop" id="backdrop" hidden></div>
<aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-label="Memory details" hidden></aside>

<script>
var TOKEN = new URLSearchParams(location.search).get('token');
function api(path, opts) {
  if (TOKEN) path += (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
  return fetch(path, opts).then(function (r) {
    if (!r.ok) return r.text().then(function (t) { throw new Error(t || ('HTTP ' + r.status)); });
    return r.json();
  });
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
function short(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function day(s) { if (!s) return ''; var d = new Date(s); return isNaN(d) ? '' : d.toISOString().slice(0, 10); }
function hue(project) {
  if (!project) return '#98a0b0';
  var h = 0; for (var i = 0; i < project.length; i++) h = (h * 31 + project.charCodeAt(i)) % 360;
  return 'hsl(' + h + ',62%,58%)';
}
var state = { q: '', exact: false, project: '', source: '', offset: null, stack: [], stats: null, next: null };

function showTab(name) {
  ['memories', 'clusters', 'stats', 'relations', 'duplicates', 'settings'].forEach(function (t) {
    var el = document.getElementById('tab-' + t);
    var on = t === name;
    if (on) { el.hidden = false; el.classList.remove('is-active'); requestAnimationFrame(function () { el.classList.add('is-active'); }); }
    else { el.hidden = true; el.classList.remove('is-active'); }
  });
  document.querySelectorAll('.nav-item').forEach(function (b) {
    var on = b.dataset.tab === name;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  if (name === 'clusters') renderClusters();
  if (name === 'stats') renderStats();
  if (name === 'relations') loadGraph();
  if (name === 'duplicates') renderDuplicates();
  if (name === 'settings') renderSettings();
}

function loadSummary() {
  return api('/api/stats').then(function (s) {
    state.stats = s;
    var projects = Object.keys(s.by_project || {}).length;
    var sources = Object.keys(s.by_source || {}).length;
    document.getElementById('rail-stats').innerHTML =
      '<div><b>' + s.vectors_count + '</b> memories</div><div><b>' + projects + '</b> projects</div><div><b>' + sources + '</b> sources</div>';
    document.getElementById('rail-collection').textContent = s.collection;
    var sel = document.getElementById('project');
    if (sel.options.length <= 1) {
      Object.keys(s.by_project || {}).sort(function (a, b) { return s.by_project[b] - s.by_project[a]; }).forEach(function (p) {
        var o = document.createElement('option'); o.value = p; o.textContent = p + ' (' + s.by_project[p] + ')'; sel.appendChild(o);
      });
    }
  }).catch(function (e) {
    document.getElementById('rail-stats').innerHTML = '<div>' + esc(e.message) + '</div>';
  });
}

function loadMemories(reset) {
  var params = new URLSearchParams();
  if (state.q) { params.set('q', state.q); if (state.exact) params.set('exact', 'true'); }
  if (state.project) params.set('project', state.project);
  if (state.source) params.set('source', state.source);
  params.set('limit', '50');
  if (reset) { state.offset = null; state.stack = []; }
  if (state.offset) params.set('offset', state.offset);
  return api('/api/memories?' + params.toString()).then(function (data) {
    var rows = document.getElementById('rows');
    rows.innerHTML = '';
    document.getElementById('empty').hidden = data.memories.length !== 0;
    document.getElementById('count').textContent = data.memories.length + (data.mode === 'search' ? ' results' : ' shown');
    data.memories.forEach(function (m) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td class="cell-text">' + esc(m.text) + '</td>' +
        '<td>' + (m.project ? '<span class="pill"><span class="dot" style="background:' + hue(m.project) + '"></span>' + esc(m.project) + '</span>' : '<span class="muted">none</span>') + '</td>' +
        '<td class="muted">' + esc(m.source || '') + '</td>' +
        '<td class="mono">' + (m.importance != null ? m.importance : '') + '</td>' +
        '<td class="mono muted">' + day(m.created_at) + '</td>' +
        '<td class="mono">' + ((m.links && m.links.length) ? m.links.length : '') + '</td>';
      tr.addEventListener('click', function () { openDrawer(m.id); });
      rows.appendChild(tr);
    });
    state.next = data.next_offset || null;
    document.getElementById('prev').disabled = state.stack.length === 0;
    document.getElementById('next').disabled = !state.next;
  }).catch(function (e) {
    document.getElementById('rows').innerHTML = '<tr><td colspan="6" class="muted">' + esc(e.message) + '</td></tr>';
  });
}

/* --- drawer --- */
var drawer = document.getElementById('drawer');
var backdrop = document.getElementById('backdrop');
function openDrawer(id) {
  drawer.hidden = false;
  backdrop.hidden = false;
  drawer.classList.remove('is-closing');
  requestAnimationFrame(function () {
    drawer.classList.add('is-open');
    backdrop.classList.add('is-open');
  });
  drawer.innerHTML = '<div class="drawer-close"><button class="btn ghost" aria-label="Close">✕</button></div><p class="muted">Loading…</p>';
  drawer.querySelector('button').addEventListener('click', closeDrawer);
  api('/api/related?id=' + encodeURIComponent(id)).then(function (r) { renderDrawer(r); }).catch(function (e) {
    drawer.innerHTML = '<div class="drawer-close"><button class="btn ghost" aria-label="Close">✕</button></div><p class="muted">' + esc(e.message) + '</p>';
    drawer.querySelector('button').addEventListener('click', closeDrawer);
  });
}
function closeDrawer() {
  drawer.classList.add('is-closing');
  drawer.classList.remove('is-open');
  backdrop.classList.remove('is-open');
  setTimeout(function () { drawer.hidden = true; backdrop.hidden = true; drawer.classList.remove('is-closing'); drawer.innerHTML = ''; }, 200);
}
backdrop.addEventListener('click', closeDrawer);
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !drawer.hidden) closeDrawer(); });

function renderDrawer(r) {
  var m = r.memory;
  var html = '<div class="drawer-close"><button class="btn ghost" aria-label="Close">✕</button></div>';
  html += '<h2>Memory</h2>';
  html += '<textarea id="editText" aria-label="Memory text">' + esc(m.text) + '</textarea>';
  html += '<div class="toolbar" style="position:static;background:none;border-bottom:0;padding:8px 0 2px"><button class="btn primary" id="saveEdit">Save</button><button class="btn" id="deleteMem">Delete</button><span class="saved" id="editInfo"></span></div>';
  html += '<div class="meta-row">' +
    (m.project ? '<span class="pill"><span class="dot" style="background:' + hue(m.project) + '"></span>' + esc(m.project) + '</span>' : '') +
    (m.source ? '<span class="pill">' + esc(m.source) + '</span>' : '') +
    (m.importance != null ? '<span class="pill">importance ' + m.importance + '</span>' : '') +
    (m.created_at ? '<span class="pill">' + day(m.created_at) + '</span>' : '') + '</div>';
  html += '<div class="idline">' + esc(m.id) + '</div>';
  html += '<h2>Explicit links</h2><div id="manual"></div>';
  html += '<div class="link-add"><input id="linkId" aria-label="Memory id to link" placeholder="Paste a memory id to link it"><button class="btn" id="addLink">Link</button></div>';
  html += '<h2>Semantically similar</h2><div id="related"></div>';
  drawer.innerHTML = html;
  drawer.querySelector('button').addEventListener('click', closeDrawer);
  document.getElementById('saveEdit').addEventListener('click', function () {
    var text = document.getElementById('editText').value.trim();
    if (!text) { document.getElementById('editInfo').textContent = 'Text is required'; return; }
    api('/api/memories', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: m.id, text: text }) })
      .then(function () { document.getElementById('editInfo').textContent = 'Saved'; loadMemories(false); loadSummary(); })
      .catch(function (e) { document.getElementById('editInfo').textContent = e.message; });
  });
  document.getElementById('deleteMem').addEventListener('click', function () {
    if (!confirm('Delete this memory?')) return;
    api('/api/memories?id=' + encodeURIComponent(m.id), { method: 'DELETE' })
      .then(function () { closeDrawer(); loadMemories(false); loadSummary(); })
      .catch(function (e) { document.getElementById('editInfo').textContent = e.message; });
  });
  renderManual(m.id, r.manual || []);
  var rel = document.getElementById('related');
  if (!r.related || r.related.length === 0) { rel.innerHTML = '<p class="muted">No neighbours above the score threshold.</p>'; }
  else {
    r.related.forEach(function (x) {
      var row = document.createElement('div');
      row.className = 'rel';
      row.innerHTML = '<span class="rel-text">' + esc(short(x.text, 110)) + '</span><span class="score">' + x.score.toFixed(3) + '</span>';
      row.addEventListener('click', function () { openDrawer(x.id); });
      rel.appendChild(row);
    });
  }
  document.getElementById('addLink').addEventListener('click', function () {
    var v = document.getElementById('linkId').value.trim();
    if (!v) return;
    api('/api/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: m.id, linkIds: [v] }) })
      .then(function () { openDrawer(m.id); });
  });
}
function renderManual(id, items) {
  var box = document.getElementById('manual');
  box.innerHTML = '';
  if (!items.length) { box.innerHTML = '<p class="muted">No explicit links yet. Paste an id below to connect two memories.</p>'; return; }
  items.forEach(function (x) {
    var row = document.createElement('div');
    row.className = 'rel';
    var text = document.createElement('span');
    text.className = 'rel-text';
    text.textContent = short(x.text, 110);
    text.addEventListener('click', function () { openDrawer(x.id); });
    var un = document.createElement('button');
    un.className = 'unlink';
    un.textContent = 'Unlink';
    un.addEventListener('click', function (ev) {
      ev.stopPropagation();
      api('/api/links', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, linkIds: [x.id] }) })
        .then(function () { openDrawer(id); });
    });
    row.appendChild(text); row.appendChild(un);
    box.appendChild(row);
  });
}

/* --- clusters --- */
function renderClusters() {
  var s = state.stats; if (!s) return;
  function bars(target, obj) {
    var el = document.getElementById(target);
    el.innerHTML = '';
    var keys = Object.keys(obj || {});
    if (!keys.length) { el.innerHTML = '<p class="muted">Nothing here yet.</p>'; return; }
    var max = Math.max.apply(null, keys.map(function (k) { return obj[k]; }).concat([1]));
    keys.sort(function (a, b) { return obj[b] - obj[a]; }).forEach(function (k) {
      var row = document.createElement('div');
      row.className = 'cluster';
      row.innerHTML = '<div class="cluster-top"><span class="cluster-name"><span class="dot" style="background:' + hue(k === 'default' ? '' : k) + '"></span>' + esc(k) + '</span><span class="cluster-count">' + obj[k] + '</span></div><div class="track"><div class="fill" style="background:' + hue(k === 'default' ? '' : k) + '"></div></div>';
      el.appendChild(row);
      var fill = row.querySelector('.fill');
      requestAnimationFrame(function () { fill.style.transform = 'scaleX(' + (obj[k] / max) + ')'; });
    });
  }
  bars('clusters-project', s.by_project);
  bars('clusters-source', s.by_source);
}

/* --- stats --- */
function renderStats() {
  var s = state.stats;
  if (!s) { loadSummary().then(renderStats); return; }
  var cells = [
    ['Memories', s.vectors_count, true],
    ['Projects', Object.keys(s.by_project || {}).length, false],
    ['Sources', Object.keys(s.by_source || {}).length, false],
    ['Expired', s.expired || 0, false],
    ['Expiring within 7 days', s.expiring_soon_7d || 0, false],
    ['Text stored', ((s.text_bytes || 0) / 1024).toFixed(1) + ' KB', false],
    ['Collection size', ((s.size_bytes || 0) / 1024 / 1024).toFixed(1) + ' MB', false]
  ];
  document.getElementById('stat-strip').innerHTML = cells.map(function (c) {
    return '<div class="cell"><div class="k">' + c[0] + '</div><div class="v' + (c[2] ? ' total' : '') + '">' + c[1] + '</div></div>';
  }).join('');
  api('/api/stale?older_than_days=90&limit=25').then(function (r) {
    var bucket = (r.buckets || {})['older_than_90d'] || {};
    var list = bucket.memories || [];
    var el = document.getElementById('stale');
    if (!list.length) { el.innerHTML = '<p class="muted">Nothing older than 90 days.</p>'; return; }
    el.innerHTML = '';
    list.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'rel';
      row.innerHTML = '<span class="rel-text">' + esc(short(m.text, 120)) + '</span><span class="mono muted">' + day(m.created_at) + '</span>';
      row.addEventListener('click', function () { openDrawer(m.id); });
      el.appendChild(row);
    });
  }).catch(function (e) { document.getElementById('stale').innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; });
}

/* --- relations graph --- */
var graphData = null;
function loadGraph() {
  var thr = (Number(document.getElementById('thr').value) / 100).toFixed(2);
  document.getElementById('thrv').textContent = thr;
  document.getElementById('graphinfo').textContent = 'building…';
  api('/api/graph?threshold=' + thr + '&maxNodes=250').then(function (g) {
    document.getElementById('graphinfo').textContent = g.nodes.length + ' nodes, ' + g.edges.length + ' edges' + (g.capped ? ' (all loaded)' : '');
    graphData = g;
    drawGraph(g);
  }).catch(function (e) { document.getElementById('graphinfo').textContent = 'error: ' + e.message; });
}
function drawGraph(g) {
  var W = 1000, H = 700;
  var nodes = g.nodes.map(function (n, i) {
    return { id: n.id, text: n.text, project: n.project, x: W / 2 + Math.cos(i) * (180 + (i % 7) * 18), y: H / 2 + Math.sin(i * 1.7) * 200, vx: 0, vy: 0 };
  });
  var idx = {}; nodes.forEach(function (n, i) { idx[n.id] = i; });
  var edges = g.edges.filter(function (e) { return idx[e.source] != null && idx[e.target] != null; });
  var N = nodes.length;
  var iterations = N > 150 ? 60 : 120;
  for (var it = 0; it < iterations; it++) {
    for (var i = 0; i < N; i++) {
      for (var j = i + 1; j < N; j++) {
        var dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y;
        var d2 = dx * dx + dy * dy + 0.01, f = 4200 / d2, d = Math.sqrt(d2);
        var fx = (dx / d) * f, fy = (dy / d) * f;
        nodes[i].vx -= fx; nodes[i].vy -= fy; nodes[j].vx += fx; nodes[j].vy += fy;
      }
    }
    edges.forEach(function (e) {
      var a = nodes[idx[e.source]], b = nodes[idx[e.target]];
      var dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01, f = (d - 90) * 0.02;
      var fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    });
    nodes.forEach(function (n) {
      n.vx += (W / 2 - n.x) * 0.002; n.vy += (H / 2 - n.y) * 0.002;
      n.x += Math.max(-14, Math.min(14, n.vx * 0.06)); n.y += Math.max(-14, Math.min(14, n.vy * 0.06));
      n.vx *= 0.6; n.vy *= 0.6;
      n.x = Math.max(18, Math.min(W - 18, n.x)); n.y = Math.max(18, Math.min(H - 18, n.y));
    });
  }
  var parts = [];
  edges.forEach(function (e) {
    var a = nodes[idx[e.source]], b = nodes[idx[e.target]];
    var col = e.kind === 'manual' ? '#f5a623' : 'rgba(110,168,254,0.42)';
    parts.push('<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '" stroke="' + col + '" stroke-width="' + (e.kind === 'manual' ? 1.5 : 0.7) + '"/>');
  });
  nodes.forEach(function (n) {
    parts.push('<circle cx="' + n.x.toFixed(1) + '" cy="' + n.y.toFixed(1) + '" r="4.5" fill="' + hue(n.project) + '" stroke="rgba(0,0,0,0.35)" stroke-width="0.6"><title>' + esc(short(n.text, 110)) + '</title></circle>');
  });
  var svg = document.getElementById('graph');
  svg.innerHTML = parts.join('');
  var circles = svg.querySelectorAll('circle');
  circles.forEach(function (c, i) { c.style.cursor = 'pointer'; c.addEventListener('click', function () { openDrawer(nodes[i].id); }); });
}

/* --- new memory --- */
function openNewMemory() {
  drawer.hidden = false;
  backdrop.hidden = false;
  drawer.classList.remove('is-closing');
  requestAnimationFrame(function () { drawer.classList.add('is-open'); backdrop.classList.add('is-open'); });
  drawer.innerHTML = '<div class="drawer-close"><button class="btn ghost" aria-label="Close">✕</button></div>' +
    '<h2>New memory</h2>' +
    '<textarea id="newText" aria-label="Memory text" placeholder="What should MemoryHub remember?"></textarea>' +
    '<div class="form-row"><label for="newProject">Project</label><input id="newProject" placeholder="optional"></div>' +
    '<div class="form-row"><label for="newSource">Source</label><input id="newSource" placeholder="optional"></div>' +
    '<div class="form-row"><label for="newImportance">Importance</label><input id="newImportance" type="number" min="0" max="1" step="0.05" placeholder="0 to 1"></div>' +
    '<div class="form-row"><label for="newDedup">Duplicates</label><label class="check"><input type="checkbox" id="newDedup" checked> merge or skip near-duplicates</label></div>' +
    '<div class="toolbar" style="position:static;background:none;border-bottom:0;padding:10px 0 2px"><button class="btn primary" id="createMem">Add memory</button><span class="saved" id="newInfo"></span></div>';
  drawer.querySelector('button').addEventListener('click', closeDrawer);
  document.getElementById('createMem').addEventListener('click', function () {
    var text = document.getElementById('newText').value.trim();
    if (!text) { document.getElementById('newInfo').textContent = 'Text is required'; return; }
    var imp = document.getElementById('newImportance').value;
    document.getElementById('newInfo').textContent = 'Adding…';
    api('/api/memories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text,
        project: document.getElementById('newProject').value.trim() || undefined,
        source: document.getElementById('newSource').value.trim() || undefined,
        importance: imp === '' ? undefined : Number(imp),
        dedup: document.getElementById('newDedup').checked
      })
    }).then(function (r) {
      document.getElementById('newInfo').textContent = 'Added ' + (r.added || 0) +
        (r.merged ? ', merged ' + r.merged : '') + (r.skipped ? ', skipped ' + r.skipped : '');
      loadMemories(true); loadSummary();
    }).catch(function (e) { document.getElementById('newInfo').textContent = e.message; });
  });
}

/* --- duplicates --- */
function renderDuplicates() {
  var thr = (Number(document.getElementById('dupThr').value) / 100).toFixed(2);
  document.getElementById('dupThrv').textContent = thr;
  document.getElementById('dupinfo').textContent = 'scanning…';
  api('/api/duplicates?threshold=' + thr + '&limit=50&maxNodes=500').then(function (r) {
    document.getElementById('dupinfo').textContent = r.pairs.length + ' pairs, scanned ' + r.scanned;
    var list = document.getElementById('dup-list');
    list.innerHTML = '';
    if (!r.pairs.length) { list.innerHTML = '<p class="muted">No near-duplicates at this threshold.</p>'; return; }
    r.pairs.forEach(function (p) {
      var card = document.createElement('div');
      card.className = 'dup-card';
      card.appendChild(dupLine(p.a, p.score));
      card.appendChild(dupLine(p.b, p.score));
      list.appendChild(card);
    });
  }).catch(function (e) { document.getElementById('dupinfo').textContent = 'error: ' + e.message; });
}
function dupLine(m, score) {
  var row = document.createElement('div');
  row.className = 'rel';
  var text = document.createElement('span');
  text.className = 'rel-text';
  text.textContent = short(m.text, 130);
  text.addEventListener('click', function () { openDrawer(m.id); });
  var right = document.createElement('span');
  right.style.display = 'flex'; right.style.gap = '10px'; right.style.alignItems = 'baseline';
  var s = document.createElement('span'); s.className = 'score'; s.textContent = score.toFixed(3);
  var del = document.createElement('button'); del.className = 'unlink'; del.textContent = 'Delete';
  del.addEventListener('click', function (ev) {
    ev.stopPropagation();
    if (!confirm('Delete this memory?')) return;
    api('/api/memories?id=' + encodeURIComponent(m.id), { method: 'DELETE' })
      .then(function () { renderDuplicates(); loadSummary(); loadMemories(false); });
  });
  right.appendChild(s); right.appendChild(del);
  row.appendChild(text); row.appendChild(right);
  return row;
}

/* --- settings --- */
var SECRET_KEYS = { LLM_KEY: 1, EMBED_KEY: 1, API_TOKEN: 1 };
function renderSettings() {
  var list = document.getElementById('config-list');
  if (list.dataset.loaded) return;
  api('/api/config').then(function (r) {
    var cfg = r.config || {};
    list.innerHTML = '';
    Object.keys(cfg).forEach(function (key) {
      var secret = !!SECRET_KEYS[key];
      var row = document.createElement('div');
      row.className = 'config-row';
      var k = document.createElement('div'); k.className = 'config-key'; k.textContent = key;
      var input = document.createElement('input');
      input.type = 'text';
      input.setAttribute('aria-label', key);
      input.placeholder = secret ? String(cfg[key]) : '';
      input.value = secret ? '' : String(cfg[key]);
      var persist = document.createElement('label'); persist.className = 'check';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true;
      persist.appendChild(cb); persist.appendChild(document.createTextNode('Save to file'));
      var save = document.createElement('button'); save.className = 'btn save'; save.textContent = 'Save';
      var info = document.createElement('span'); info.className = 'saved';
      save.addEventListener('click', function () {
        var value = input.value;
        if (secret && value === '') { info.textContent = 'unchanged'; return; }
        api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: key, value: value, persist: cb.checked }) })
          .then(function (out) {
            info.textContent = 'saved';
            if (secret) { input.value = ''; input.placeholder = String(out.value); }
            else { input.value = String(out.value); }
            loadSummary();
          })
          .catch(function (e) { info.textContent = e.message; });
      });
      row.appendChild(k); row.appendChild(input); row.appendChild(persist); row.appendChild(save); row.appendChild(info);
      list.appendChild(row);
    });
    list.dataset.loaded = '1';
  }).catch(function (e) { list.innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; });
}

document.querySelectorAll('.nav-item').forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab); }); });
document.getElementById('doSearch').addEventListener('click', function () {
  state.q = document.getElementById('q').value;
  state.exact = document.getElementById('exact').checked;
  state.project = document.getElementById('project').value;
  state.source = document.getElementById('source').value;
  loadMemories(true);
});
document.getElementById('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') document.getElementById('doSearch').click(); });
document.getElementById('prev').addEventListener('click', function () { state.offset = state.stack.pop() || null; loadMemories(false); });
document.getElementById('next').addEventListener('click', function () { if (state.next) { state.stack.push(state.offset); state.offset = state.next; loadMemories(false); } });
document.getElementById('thr').addEventListener('input', function () { document.getElementById('thrv').textContent = (Number(this.value) / 100).toFixed(2); });
document.getElementById('thr').addEventListener('change', loadGraph);
document.getElementById('reloadGraph').addEventListener('click', loadGraph);
document.getElementById('newMemory').addEventListener('click', openNewMemory);
document.getElementById('dupThr').addEventListener('input', function () { document.getElementById('dupThrv').textContent = (Number(this.value) / 100).toFixed(2); });
document.getElementById('dupThr').addEventListener('change', renderDuplicates);
document.getElementById('reloadDup').addEventListener('click', renderDuplicates);

loadSummary().then(function () { return loadMemories(true); });
</script>
</body>
</html>
`;