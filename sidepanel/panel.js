// panel.js — DorkWay side panel controller.
import { TAG_COLORS } from '../lib/tags.js';

const $ = (id) => document.getElementById(id);
const msg = (m) => chrome.runtime.sendMessage(m);

const state = {
  settings: {},
  activeSessionId: null,
  results: [],
  filtered: [],
  filters: {
    include: { root: new Set(), sub: new Set(), ft: new Set(), tags: new Set(), status: new Set() },
    exclude: { root: new Set(), sub: new Set(), ft: new Set(), tags: new Set(), status: new Set() },
    keyword: ''
  },
  collapsed: new Set()
};

const SUB_NONE = '(root)';
const FT_NONE = '(none)';

// ---- bootstrap ---------------------------------------------------------------

init();

async function init() {
  const boot = await msg({ type: 'GET_BOOTSTRAP' });
  state.settings = boot.settings || {};
  state.activeSessionId = boot.activeSessionId;
  renderSessions(boot.sessions);
  applySettingsToForm();

  if (!state.settings.firstRunDone) showDisclaimer();
  wireTabs();
  wireResults();
  wireBuilder();
  wireExport();
  wireSettings();
  wireTriage();
  wireRuntimeEvents();

  if (boot.job && boot.job.active) setStatusLine(`Auto-pagination active for: ${boot.job.query}`);
  await loadResults();
}

// ---- disclaimer --------------------------------------------------------------

function showDisclaimer() {
  $('disclaimer').classList.remove('hidden');
  $('disclaimer-ack').addEventListener('change', (e) => {
    $('disclaimer-ok').disabled = !e.target.checked;
  });
  $('disclaimer-ok').addEventListener('click', async () => {
    state.settings.firstRunDone = true;
    await msg({ type: 'SAVE_SETTINGS', settings: { firstRunDone: true } });
    $('disclaimer').classList.add('hidden');
  });
}

// ---- sessions ----------------------------------------------------------------

function renderSessions(sessions) {
  const sel = $('session-select');
  sel.innerHTML = '';
  for (const s of sessions || []) {
    const opt = document.createElement('option');
    opt.value = s.sessionId;
    opt.textContent = s.name;
    if (s.sessionId === state.activeSessionId) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.onchange = async () => {
    state.activeSessionId = sel.value;
    await msg({ type: 'SELECT_SESSION', sessionId: sel.value });
    await loadResults();
  };
  $('new-session').onclick = async () => {
    const name = prompt('New session name:', `Session ${new Date().toLocaleString()}`);
    if (name === null) return;
    const r = await msg({ type: 'CREATE_SESSION', name });
    state.activeSessionId = r.session.sessionId;
    const list = await msg({ type: 'LIST_SESSIONS' });
    renderSessions(list.sessions);
    await loadResults();
  };
}

// ---- tabs --------------------------------------------------------------------

function wireTabs() {
  document.querySelectorAll('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });
}

// ---- results: load, filter, render ------------------------------------------

async function loadResults() {
  const r = await msg({ type: 'GET_RESULTS', sessionId: state.activeSessionId });
  state.results = (r.results || []).sort((a, b) => (a.rank || 0) - (b.rank || 0));
  $('count-badge').textContent = state.results.length;
  updateTriageMeta();
  buildFacets();
  applyFilters();
}

function buildFacets() {
  const facets = { root: new Map(), sub: new Map(), ft: new Map(), tags: new Map(), status: new Map() };
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

  // Cross-filtering: each facet only counts results that pass every *other* active
  // filter, so selecting a root narrows the subdomain/file/tag lists to matches.
  const addFacet = (name, fill) => {
    for (const r of state.results) if (passesFiltersExcept(r, name)) fill(r);
    // Keep any included/excluded value present so its chip stays toggleable even at count 0.
    for (const v of state.filters.include[name]) if (!facets[name].has(v)) facets[name].set(v, 0);
    for (const v of state.filters.exclude[name]) if (!facets[name].has(v)) facets[name].set(v, 0);
  };
  addFacet('root', (r) => bump(facets.root, r.rootDomain || '(unknown)'));
  addFacet('sub', (r) => bump(facets.sub, r.subdomain || SUB_NONE));
  addFacet('ft', (r) => bump(facets.ft, r.fileType || FT_NONE));
  addFacet('tags', (r) => { for (const t of r.tags || []) bump(facets.tags, t); });
  addFacet('status', (r) => bump(facets.status, String(r.statusCode || 0)));

  renderChips('filter-root', facets.root, 'root');
  renderChips('filter-sub', facets.sub, 'sub');
  renderChips('filter-ft', facets.ft, 'ft');
  renderChips('filter-tags', facets.tags, 'tags', true);
  renderChips('filter-status', facets.status, 'status', false, statusLabel);
}

function statusLabel(code) {
  return code === '0' ? 'unchecked' : code;
}

function renderChips(containerId, facetMap, name, isTag = false, labelFn = (x) => x) {
  const el = $(containerId);
  el.innerHTML = '';
  const incSet = state.filters.include[name];
  const excSet = state.filters.exclude[name];
  const entries = [...facetMap.entries()].sort((a, b) => b[1] - a[1]);
  for (const [value, count] of entries) {
    const included = incSet.has(value);
    const excluded = excSet.has(value);
    const chip = document.createElement('span');
    chip.className = 'chip' + (included ? ' on' : '') + (excluded ? ' ex' : '');
    chip.textContent = `${excluded ? '−' : ''}${labelFn(value)} (${count})`;
    chip.title = excluded
      ? 'Excluded — click to include, right-click to clear'
      : included
        ? 'Included — click to clear, right-click to exclude'
        : 'Click to include · right-click to exclude';
    if (isTag && TAG_COLORS[value] && included) {
      chip.style.background = TAG_COLORS[value];
      chip.style.borderColor = TAG_COLORS[value];
    }
    // Left-click cycles include on/off (clearing any exclude on this value).
    chip.onclick = () => {
      excSet.delete(value);
      incSet.has(value) ? incSet.delete(value) : incSet.add(value);
      applyFilters();
      buildFacets();
    };
    // Right-click cycles exclude on/off (clearing any include on this value).
    chip.oncontextmenu = (e) => {
      e.preventDefault();
      incSet.delete(value);
      excSet.has(value) ? excSet.delete(value) : excSet.add(value);
      applyFilters();
      buildFacets();
    };
    el.appendChild(chip);
  }
}

// Checks every filter except the named facet (pass null to check all). Excluding a
// facet lets that facet's chip list show all values consistent with the other filters.
// Within a facet: include is OR (any selected value matches), exclude always wins.
function passesFiltersExcept(r, except) {
  const f = state.filters;
  const inc = f.include, exc = f.exclude;
  const root = r.rootDomain || '(unknown)';
  const sub = r.subdomain || SUB_NONE;
  const ft = r.fileType || FT_NONE;
  const tags = r.tags || [];
  const status = String(r.statusCode || 0);

  if (except !== 'root') {
    if (exc.root.has(root)) return false;
    if (inc.root.size && !inc.root.has(root)) return false;
  }
  if (except !== 'sub') {
    if (exc.sub.has(sub)) return false;
    if (inc.sub.size && !inc.sub.has(sub)) return false;
  }
  if (except !== 'ft') {
    if (exc.ft.has(ft)) return false;
    if (inc.ft.size && !inc.ft.has(ft)) return false;
  }
  if (except !== 'tags') {
    if (tags.some((t) => exc.tags.has(t))) return false;
    if (inc.tags.size && !tags.some((t) => inc.tags.has(t))) return false;
  }
  if (except !== 'status') {
    if (exc.status.has(status)) return false;
    if (inc.status.size && !inc.status.has(status)) return false;
  }
  if (f.keyword) {
    const hay = `${r.title}\n${r.snippet}\n${r.path}`.toLowerCase();
    if (!hay.includes(f.keyword.toLowerCase())) return false;
  }
  return true;
}

function passesFilters(r) {
  return passesFiltersExcept(r, null);
}

function applyFilters() {
  state.filtered = state.results.filter(passesFilters);
  $('result-summary').textContent = `${state.filtered.length} of ${state.results.length} shown`;
  $('export-count').textContent = state.filtered.length;
  renderTree();
}

function renderTree() {
  const tree = $('tree');
  tree.innerHTML = '';
  $('empty').classList.toggle('hidden', state.results.length > 0);
  if (!state.filtered.length) return;

  // group: rootDomain -> subdomain -> leaves
  const byRoot = new Map();
  for (const r of state.filtered) {
    const root = r.rootDomain || '(unknown)';
    const sub = r.subdomain || SUB_NONE;
    if (!byRoot.has(root)) byRoot.set(root, new Map());
    const subs = byRoot.get(root);
    if (!subs.has(sub)) subs.set(sub, []);
    subs.get(sub).push(r);
  }

  const roots = [...byRoot.keys()].sort();
  for (const root of roots) {
    const subs = byRoot.get(root);
    const rootCount = [...subs.values()].reduce((n, a) => n + a.length, 0);
    const rootEl = makeGroup(root, rootCount, `root:${root}`, true);
    const body = rootEl.querySelector('.group-body');

    for (const sub of [...subs.keys()].sort()) {
      const leaves = subs.get(sub).sort((a, b) => (a.rank || 0) - (b.rank || 0));
      const subEl = makeGroup(sub, leaves.length, `sub:${root}:${sub}`, false);
      const subBody = subEl.querySelector('.group-body');
      for (const r of leaves) subBody.appendChild(makeLeaf(r));
      body.appendChild(subEl);
    }
    tree.appendChild(rootEl);
  }
}

function makeGroup(label, count, key, isRoot) {
  const g = document.createElement('div');
  g.className = `group ${isRoot ? 'dom-group' : 'sub-group'}` + (state.collapsed.has(key) ? ' collapsed' : '');
  const head = document.createElement('div');
  head.className = 'group-head';
  head.innerHTML = `<span class="caret">▾</span><span class="group-label"></span> <span class="group-count">(${count})</span>`;
  head.querySelector('.group-label').textContent = label;
  head.onclick = () => {
    g.classList.toggle('collapsed');
    g.classList.contains('collapsed') ? state.collapsed.add(key) : state.collapsed.delete(key);
  };
  const body = document.createElement('div');
  body.className = 'group-body';
  g.append(head, body);
  return g;
}

function makeLeaf(r) {
  const leaf = document.createElement('div');
  leaf.className = 'leaf';

  const title = document.createElement('div');
  title.className = 'leaf-title';
  const dot = document.createElement('span');
  dot.className = `dot s${r.statusCode || 0}`;
  dot.title = r.statusCode ? `HTTP ${r.statusCode}` : 'unchecked';
  for (const t of r.tags || []) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = t;
    tag.style.background = TAG_COLORS[t] || '#475569';
    title.appendChild(tag);
  }
  const a = document.createElement('a');
  a.href = r.url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = r.title || '(no title)';
  title.append(dot, a);

  const snip = document.createElement('div');
  snip.className = 'leaf-snippet';
  snip.textContent = r.snippet || '';

  const url = document.createElement('div');
  url.className = 'leaf-url';
  url.textContent = r.url;

  const meta = document.createElement('div');
  meta.className = 'leaf-meta';
  meta.textContent = `#${r.rank} · p${r.page}${r.fileType ? ' · .' + r.fileType : ''}${r.statusCode ? ' · ' + r.statusCode : ''}`;

  leaf.append(title, snip, url, meta);
  return leaf;
}

function wireResults() {
  $('filter-keyword').addEventListener('input', (e) => {
    state.filters.keyword = e.target.value.trim();
    applyFilters();
    buildFacets();
  });
  $('toggle-filters').addEventListener('click', () => $('filters').classList.toggle('hidden'));
  $('clear-filters').addEventListener('click', () => {
    for (const k of ['root', 'sub', 'ft', 'tags', 'status']) {
      state.filters.include[k].clear();
      state.filters.exclude[k].clear();
    }
    state.filters.keyword = '';
    $('filter-keyword').value = '';
    buildFacets();
    applyFilters();
  });
  $('expand-all').addEventListener('click', () => { state.collapsed.clear(); renderTree(); });
  $('collapse-all').addEventListener('click', () => {
    document.querySelectorAll('.group').forEach((g) => g.classList.add('collapsed'));
    for (const r of state.filtered) {
      state.collapsed.add(`root:${r.rootDomain || '(unknown)'}`);
      state.collapsed.add(`sub:${r.rootDomain || '(unknown)'}:${r.subdomain || SUB_NONE}`);
    }
  });
}

// ---- dork builder ------------------------------------------------------------

function composeQuery() {
  const parts = [];
  const site = $('b-site').value.trim();
  const inurl = $('b-inurl').value.trim();
  const intitle = $('b-intitle').value.trim();
  const ft = $('b-filetype').value;
  const after = $('b-after').value;
  const before = $('b-before').value;
  const free = $('b-free').value.trim();
  if (site) parts.push(`site:${site}`);
  if (inurl) parts.push(`inurl:${inurl}`);
  if (intitle) parts.push(`intitle:${intitle}`);
  if (ft) parts.push(`filetype:${ft}`);
  if (after) parts.push(`after:${after}`);
  if (before) parts.push(`before:${before}`);
  if (free) parts.push(free);
  return parts.join(' ');
}

function wireBuilder() {
  const update = () => ($('query-preview').textContent = composeQuery() || '(empty)');
  ['b-site', 'b-inurl', 'b-intitle', 'b-filetype', 'b-after', 'b-before', 'b-free'].forEach((id) =>
    $(id).addEventListener('input', update)
  );
  update();

  $('b-open').addEventListener('click', async () => {
    const q = composeQuery();
    if (!q) return;
    await msg({ type: 'OPEN_QUERY', query: q, startPagination: $('b-autopage').checked, allPages: true, maxPages: state.settings.maxPages });
  });

  $('start-pagination').addEventListener('click', async () => {
    const r = await msg({ type: 'START_PAGINATION', allPages: true, maxPages: state.settings.maxPages });
    if (!r.ok) setStatusLine(r.error, true);
    else setStatusLine(`Auto-paginating: ${r.query} (until Google runs out of results)`);
  });
  $('stop-pagination').addEventListener('click', async () => {
    await msg({ type: 'STOP_PAGINATION' });
    setStatusLine('Auto-pagination stopped');
  });

  $('skip-query').addEventListener('click', async () => {
    const r = await msg({ type: 'SKIP_QUERY' });
    if (!r.ok) setStatusLine(r.error, true);
    else if (r.stopped) setStatusLine('Skipped — no more queued queries, run stopped');
    else setStatusLine(`Skipped to: ${r.query}${r.remaining ? ` · ${r.remaining} queued` : ''}`);
  });

  $('pause-pagination').addEventListener('click', async () => {
    if ($('pause-pagination').dataset.mode === 'resume') {
      const r = await msg({ type: 'RESUME_PAGINATION' });
      if (r.ok) { setPauseButton(false); setStatusLine('Resumed'); }
    } else {
      const r = await msg({ type: 'PAUSE_PAGINATION' });
      if (!r.ok) setStatusLine(r.error, true);
      else { setPauseButton(true); setStatusLine('Paused — Resume to continue'); }
    }
  });

  $('suggest-splits').addEventListener('click', async () => {
    const q = composeQuery() || (state.results[0] && state.results[0].sourceQuery) || '';
    const r = await msg({ type: 'SUGGEST_SPLITS', query: q });
    renderSplits(r.suggestions || []);
  });

  $('auto-split').addEventListener('click', async () => {
    const q = composeQuery() || (state.results[0] && state.results[0].sourceQuery) || '';
    const r = await msg({ type: 'SUGGEST_SPLITS', query: q });
    const suggestions = r.suggestions || [];
    renderSplits(suggestions);
    if (!suggestions.length) return;
    const queries = suggestions.map((s) => s.query);
    const res = await msg({ type: 'AUTO_SPLIT', queries, maxPages: state.settings.maxPages });
    if (!res.ok) setStatusLine(res.error, true);
    else setStatusLine(`Auto-splitting ${res.total} queries · starting: ${res.first}`);
  });
}

function renderSplits(suggestions) {
  const box = $('splits');
  box.innerHTML = '';
  if (!suggestions.length) {
    box.innerHTML = '<p class="muted small">No split suggestions. Add a <code>site:</code> term or capture more results first.</p>';
    return;
  }
  for (const s of suggestions) {
    const item = document.createElement('div');
    item.className = 'split-item';
    item.title = s.label || s.query;
    item.innerHTML = `<span class="split-kind">${s.kind}</span><code></code>`;
    item.querySelector('code').textContent = s.query;
    const run = document.createElement('button');
    run.className = 'small';
    run.textContent = 'Run';
    run.onclick = () => msg({ type: 'OPEN_QUERY', query: s.query, startPagination: true, allPages: true, maxPages: state.settings.maxPages });
    item.appendChild(run);
    box.appendChild(item);
  }
}

// ---- export ------------------------------------------------------------------

function wireExport() {
  $('export-json').addEventListener('click', () => download('dorkway.json', 'application/json', toJSON()));
  $('export-csv').addEventListener('click', () => download('dorkway.csv', 'text/csv', toCSV()));
  $('export-md').addEventListener('click', () => download('dorkway-report.md', 'text/markdown', toMarkdown()));

  $('push-webhook').addEventListener('click', async () => {
    $('push-result').textContent = 'Sending…';
    const r = await msg({ type: 'PUSH_WEBHOOK', sessionId: state.activeSessionId, entities: cleanForExport() });
    $('push-result').textContent = r.ok
      ? `✓ Sent ${r.sent}/${r.total} results.`
      : `⚠ ${r.error || `Sent ${r.sent || 0}/${r.total || 0}; failed batches: ${(r.failedBatches || []).join(', ')}`}`;
  });
}

function cleanForExport() {
  return state.filtered.map(({ compositeKey, ...rest }) => rest);
}

function toJSON() {
  return JSON.stringify(cleanForExport(), null, 2);
}

function toCSV() {
  const fields = ['id', 'title', 'url', 'rootDomain', 'subdomain', 'path', 'fileType', 'queryParams', 'snippet', 'tags', 'sourceQuery', 'rank', 'page', 'statusCode', 'capturedAt'];
  const esc = (v) => {
    const s = Array.isArray(v) ? v.join('|') : v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [fields.join(',')];
  for (const r of state.filtered) rows.push(fields.map((f) => esc(r[f])).join(','));
  return rows.join('\n');
}

function toMarkdown() {
  const byRoot = new Map();
  for (const r of state.filtered) {
    const root = r.rootDomain || '(unknown)';
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(r);
  }
  let md = `# DorkWay recon report\n\n`;
  md += `- Generated: ${new Date().toISOString()}\n`;
  md += `- Results: ${state.filtered.length}\n`;
  md += `- Domains: ${byRoot.size}\n\n`;
  for (const root of [...byRoot.keys()].sort()) {
    md += `## ${root}\n\n`;
    const items = byRoot.get(root).sort((a, b) => (a.subdomain || '').localeCompare(b.subdomain || ''));
    for (const r of items) {
      const tags = (r.tags || []).map((t) => `\`${t}\``).join(' ');
      const status = r.statusCode ? ` _(HTTP ${r.statusCode})_` : '';
      md += `- **[${escMd(r.title)}](${r.url})**${status} ${tags}\n`;
      if (r.snippet) md += `  - ${escMd(r.snippet)}\n`;
      md += `  - \`${r.url}\` — from \`${(r.sourceQuery || '').split('\n')[0]}\`\n`;
    }
    md += `\n`;
  }
  return md;
}

function escMd(s) {
  return String(s || '').replace(/([\\`*_\[\]])/g, '\\$1');
}

function download(name, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---- settings ----------------------------------------------------------------

function applySettingsToForm() {
  const s = state.settings;
  $('s-webhook').value = s.webhookUrl || '';
  $('s-secret').value = s.webhookSecret || '';
  $('s-status').checked = !!s.statusCheckEnabled;
  $('s-maxpages').value = s.maxPages ?? 10;
  $('s-mindelay').value = s.minDelayMs ?? 1500;
  $('s-maxdelay').value = s.maxDelayMs ?? 4000;
  $('s-filter').checked = s.disableFilter !== false;
}

function wireSettings() {
  $('save-settings').addEventListener('click', async () => {
    const settings = {
      webhookUrl: $('s-webhook').value.trim(),
      webhookSecret: $('s-secret').value,
      statusCheckEnabled: $('s-status').checked,
      maxPages: clampInt($('s-maxpages').value, 1, 50, 10),
      minDelayMs: clampInt($('s-mindelay').value, 0, 60000, 1500),
      maxDelayMs: clampInt($('s-maxdelay').value, 0, 60000, 4000),
      disableFilter: $('s-filter').checked
    };
    const r = await msg({ type: 'SAVE_SETTINGS', settings });
    state.settings = { ...state.settings, ...r.settings };
    $('settings-saved').textContent = '✓ Saved';
    setTimeout(() => ($('settings-saved').textContent = ''), 2000);
  });

  $('run-status').addEventListener('click', async () => {
    if (!$('s-status').checked) {
      $('status-progress').textContent = 'Enable status checks first, then Save settings.';
      return;
    }
    // HEAD probes need broad host access — request it from this user gesture.
    const granted = await chrome.permissions.request({ origins: ['*://*/*'] }).catch(() => false);
    if (!granted) {
      $('status-progress').textContent = 'Host permission denied — cannot probe targets.';
      return;
    }
    $('status-progress').textContent = 'Checking…';
    const r = await msg({ type: 'CHECK_STATUS', sessionId: state.activeSessionId });
    $('status-progress').textContent = r.ok ? `✓ Checked ${r.checked} URLs.` : `⚠ ${r.error}`;
    await loadResults();
  });
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// ---- AI Triage ---------------------------------------------------------------

const BASEURL_HINTS = {
  anthropic: 'Blank → https://api.anthropic.com. Model e.g. claude-opus-4-8.',
  openai: 'Blank → https://api.openai.com/v1. OpenRouter: https://openrouter.ai/api/v1 (model e.g. anthropic/claude-opus-4-8).'
};

function applyLlmSettingsToForm() {
  const s = state.settings;
  $('llm-provider').value = s.llmProvider || 'anthropic';
  $('llm-baseurl').value = s.llmBaseUrl || '';
  $('llm-key').value = s.llmApiKey || '';
  $('llm-model').value = s.llmModel || '';
  $('llm-maxtokens').value = s.llmMaxTokens ?? 16000;
  $('llm-thinking').checked = s.llmThinking !== false;
  $('llm-baseurl-hint').textContent = BASEURL_HINTS[$('llm-provider').value] || '';
}

function updateTriageMeta() {
  const s = state.settings;
  const provider = s.llmProvider === 'openai' ? 'OpenAI-compatible' : 'Anthropic';
  const model = s.llmModel || (s.llmProvider === 'openai' ? 'gpt-4o' : 'claude-opus-4-8');
  const key = s.llmApiKey ? '' : ' · ⚠ no API key set';
  $('triage-meta').textContent =
    `${state.results.length} results · ${provider} (${model})${key}`;
}

function wireTriage() {
  applyLlmSettingsToForm();
  updateTriageMeta();

  // Settings modal.
  $('llm-settings-open').addEventListener('click', () => {
    applyLlmSettingsToForm();
    $('llm-settings').classList.remove('hidden');
  });
  $('llm-settings-close').addEventListener('click', () => $('llm-settings').classList.add('hidden'));
  $('llm-provider').addEventListener('change', () => {
    $('llm-baseurl-hint').textContent = BASEURL_HINTS[$('llm-provider').value] || '';
  });
  $('llm-settings-save').addEventListener('click', async () => {
    const settings = {
      llmProvider: $('llm-provider').value,
      llmBaseUrl: $('llm-baseurl').value.trim(),
      llmApiKey: $('llm-key').value.trim(),
      llmModel: $('llm-model').value.trim(),
      llmMaxTokens: clampInt($('llm-maxtokens').value, 256, 128000, 16000),
      llmThinking: $('llm-thinking').checked
    };
    const r = await msg({ type: 'SAVE_SETTINGS', settings });
    state.settings = { ...state.settings, ...r.settings };
    updateTriageMeta();
    $('llm-settings-saved').textContent = '✓ Saved';
    setTimeout(() => ($('llm-settings-saved').textContent = ''), 2000);
  });

  // Run / stop / copy.
  $('run-triage').addEventListener('click', runTriage);
  $('stop-triage').addEventListener('click', () => msg({ type: 'STOP_TRIAGE' }));
  $('copy-triage').addEventListener('click', () => {
    navigator.clipboard.writeText($('triage-output').textContent || '').catch(() => {});
  });
}

// Compact a result to the fields the agent needs for its initial (filtered)
// context. Snippet is truncated to keep the payload small; the agent pulls more
// of the captured corpus itself via the get_results tool.
function triageEntity(r) {
  return {
    title: r.title,
    url: r.url,
    rootDomain: r.rootDomain,
    subdomain: r.subdomain,
    path: r.path,
    fileType: r.fileType,
    tags: r.tags,
    sourceQuery: r.sourceQuery,
    statusCode: r.statusCode,
    snippet: (r.snippet || '').slice(0, 200)
  };
}

async function runTriage() {
  if (!state.results.length) {
    setTriageStatus('No results in this session — capture some first.', true);
    return;
  }
  if (!state.settings.llmApiKey) {
    setTriageStatus('No API key — open LLM Settings and add one.', true);
    return;
  }

  // A custom base URL may point anywhere; request host access from this gesture.
  const base = state.settings.llmBaseUrl;
  if (base) {
    let origin;
    try { origin = new URL(base).origin + '/*'; } catch (_) { origin = null; }
    if (origin) {
      const has = await chrome.permissions.contains({ origins: [origin] }).catch(() => false);
      if (!has) {
        const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
        if (!granted) { setTriageStatus('Host permission denied for the configured endpoint.', true); return; }
      }
    }
  }

  // Hand the agent the operator's current filtered view as its starting context;
  // it pulls more of the captured corpus itself via get_results. Fall back to all
  // results if the filters currently hide everything.
  const initial = state.filtered.length ? state.filtered : state.results;
  const entities = initial.map(triageEntity);
  resetTriageOutput();
  setTriageRunning(true);
  setTriageStatus(`Agent triaging — ${entities.length} filtered of ${state.results.length} captured…`);

  const r = await msg({ type: 'RUN_TRIAGE', entities });
  // The stream drives the UI via broadcasts; only surface a synchronous failure here.
  if (r && r.ok === false && !$('triage-output').textContent) {
    setTriageStatus(`⚠ ${r.error}`, true);
    setTriageRunning(false);
  }
}

// Streamed output is built from typed blocks (thinking / tool / answer) so each
// can be styled, while staying XSS-safe (createElement + textContent, no innerHTML).
let triageBlock = null;

function resetTriageOutput() {
  const out = $('triage-output');
  out.textContent = '';
  out.classList.remove('hidden');
  triageBlock = null;
}

function appendTriage(kind, text) {
  const out = $('triage-output');
  if (!triageBlock || triageBlock.kind !== kind) {
    const el = document.createElement('div');
    el.className = `triage-${kind}`;
    out.appendChild(el);
    triageBlock = { kind, el };
  }
  triageBlock.el.textContent += text;
  out.scrollTop = out.scrollHeight;
}

function addTriageNote(text) {
  const out = $('triage-output');
  const el = document.createElement('div');
  el.className = 'triage-tool';
  el.textContent = text;
  out.appendChild(el);
  triageBlock = null; // force a fresh block for whatever streams next
  out.scrollTop = out.scrollHeight;
}

// Compact one-line rendering of the agent's get_results arguments.
function triageToolArgs(input) {
  if (!input || typeof input !== 'object') return '';
  return Object.entries(input)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
}

function setTriageRunning(running) {
  $('run-triage').disabled = running;
  $('stop-triage').disabled = !running;
}

function setTriageStatus(text, warn = false) {
  const el = $('triage-status');
  el.textContent = text;
  el.style.color = warn ? '#fca5a5' : '';
}

// ---- runtime events ----------------------------------------------------------

function wireRuntimeEvents() {
  chrome.runtime.onMessage.addListener((m) => {
    switch (m.type) {
      case 'RESULTS_UPDATED':
        if (!m.sessionId || m.sessionId === state.activeSessionId) loadResults();
        break;
      case 'PAGINATION_STATE':
        setPauseButton(!!m.paused);
        if (m.active && m.paused) {
          setStatusLine(`Paused · ${m.query || ''} — Resume to continue`);
        } else if (m.active && m.autoSplit) {
          const left = m.remaining ? ` · ${m.remaining} queries queued` : ' · last query';
          setStatusLine(`Auto-split · ${m.query || ''}${left} · ${m.sessionTotal || 0} captured`);
        } else if (m.active) {
          setStatusLine(`Auto-paginating · page ${m.page || ''} · ${m.sessionTotal || ''} captured`);
        } else {
          setStatusLine(`Pagination stopped${m.reason ? ' — ' + m.reason : ''}`);
        }
        break;
      case 'CAP_HIT':
        showCapBanner(m.query);
        break;
      case 'CAPTCHA':
        setPauseButton(true);
        setStatusLine('⚠ CAPTCHA on the search tab — solve it, then Resume.', true);
        break;
      case 'STATUS_PROGRESS':
        $('status-progress').textContent = `Checking… ${m.checked}/${m.total}`;
        break;
      case 'TRIAGE_THINKING':
        appendTriage('think', m.text);
        break;
      case 'TRIAGE_DELTA':
        appendTriage('answer', m.text);
        break;
      case 'TRIAGE_TOOL':
        addTriageNote(`🔧 get_results(${triageToolArgs(m.input)})`);
        break;
      case 'TRIAGE_TOOL_RESULT':
        addTriageNote(`↳ ${m.count}${m.total > m.count ? ' of ' + m.total : ''} captured result${m.total === 1 ? '' : 's'}`);
        break;
      case 'TRIAGE_DONE': {
        setTriageRunning(false);
        const tok = m.usage ? ` · ${m.usage.output_tokens ?? m.usage.completion_tokens ?? '?'} output tokens` : '';
        setTriageStatus(m.aborted ? 'Stopped.' : `✓ Triage complete${m.note ? ' (' + m.note + ')' : ''}${tok}`);
        break;
      }
      case 'TRIAGE_ERROR':
        setTriageRunning(false);
        setTriageStatus(`⚠ ${m.error}`, true);
        break;
    }
  });
}

function setPauseButton(isPaused) {
  const btn = $('pause-pagination');
  if (!btn) return;
  btn.textContent = isPaused ? 'Resume' : 'Pause';
  btn.dataset.mode = isPaused ? 'resume' : 'pause';
}

function setStatusLine(text, warn = false) {
  const el = $('status-line');
  el.textContent = text;
  el.classList.remove('hidden');
  el.style.background = warn ? '#7c2d12' : '#0b3a67';
}

function showCapBanner(query) {
  const el = $('cap-banner');
  el.classList.remove('hidden');
  el.innerHTML = `Result cap reached for <b></b>. Slice the query to go deeper.`;
  el.querySelector('b').textContent = query;
  const btn = document.createElement('button');
  btn.className = 'small';
  btn.textContent = 'Suggest splits';
  btn.onclick = async () => {
    document.querySelector('.tabs button[data-tab="build"]').click();
    const r = await msg({ type: 'SUGGEST_SPLITS', query });
    renderSplits(r.suggestions || []);
  };
  el.appendChild(btn);
}
