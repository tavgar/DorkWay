// background.js — DorkWay service worker (MV3, ES module).
// Owns: persistent store writes, the active session, auto-pagination coordination,
// opt-in status-code enrichment, and webhook/DB push.

import {
  createSession,
  listSessions,
  getSession,
  addQueryToSession,
  upsertResult,
  getResults,
  updateResultStatus,
  countResults
} from './lib/db.js';

// Hard ceiling for "all pages" mode — a safety net against runaway loops if the
// natural stop conditions (no results / cap / empty page) ever fail to fire.
// Google itself caps at ~300 results (~30 pages), so this is rarely reached.
const HARD_PAGE_CEILING = 100;

const DEFAULT_SETTINGS = {
  webhookUrl: '',
  webhookSecret: '',
  statusCheckEnabled: false,
  maxPages: 10,
  minDelayMs: 1500,
  maxDelayMs: 4000,
  disableFilter: true,
  firstRunDone: false,
  // AI Triage / LLM. Blank baseUrl resolves to the provider default at request time.
  llmProvider: 'anthropic',
  llmBaseUrl: '',
  llmApiKey: '',
  llmModel: 'claude-opus-4-8',
  llmMaxTokens: 16000,
  llmThinking: true
};

// ---- lifecycle ---------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (_) {}
  const cur = await getSettings();
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...cur } });
});

chrome.runtime.onStartup?.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (_) {}
});

chrome.action.onClicked?.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (_) {}
});

// ---- settings & session helpers ----------------------------------------------

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function getActiveSessionId() {
  let { activeSessionId } = await chrome.storage.local.get('activeSessionId');
  if (!activeSessionId) {
    const sessions = await listSessions();
    if (sessions.length) {
      activeSessionId = sessions[0].sessionId;
    } else {
      const s = await createSession('Default session');
      activeSessionId = s.sessionId;
    }
    await chrome.storage.local.set({ activeSessionId });
  }
  return activeSessionId;
}

async function getJob() {
  const { paginationJob } = await chrome.storage.session.get('paginationJob');
  return paginationJob || { active: false };
}

async function setJob(job) {
  await chrome.storage.session.set({ paginationJob: job });
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {}); // panel may be closed; ignore.
  // A triage run is long and the user has usually switched away — fire an OS
  // notification on completion/failure so they don't have to watch the panel.
  // Skip aborts (the user pressed Stop, so they already know).
  if (msg.type === 'TRIAGE_DONE' && !msg.aborted) {
    const extra = [msg.note, triageUsageSummary(msg.usage)].filter(Boolean).join(' · ');
    notify('✓ AI Triage complete', extra || 'Your unique-asset report is ready.');
  } else if (msg.type === 'TRIAGE_ERROR') {
    notify('⚠ AI Triage failed', String(msg.error || '').slice(0, 180));
  }
}

function notify(title, message) {
  try {
    chrome.notifications.create('', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message: message || '',
      priority: 1
    }, () => void chrome.runtime.lastError); // swallow "permission" / focus errors
  } catch { /* notifications unavailable */ }
}

function triageUsageSummary(usage) {
  if (!usage) return '';
  const out = usage.output_tokens ?? usage.completion_tokens;
  return out != null ? `${out} output tokens` : '';
}

function jitter(min, max) {
  return Math.floor(min + Math.random() * Math.max(0, max - min));
}

function buildPageUrl(currentUrl, start, disableFilter) {
  const u = new URL(currentUrl);
  u.searchParams.set('start', String(start));
  if (disableFilter) u.searchParams.set('filter', '0');
  return u.toString();
}

// ---- message router ----------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then((r) => sendResponse(r))
    .catch((err) => {
      console.error('[DorkWay bg]', msg?.type, err);
      sendResponse({ ok: false, error: String(err && err.message || err) });
    });
  return true; // async response
});

async function handle(msg, sender) {
  switch (msg.type) {
    case 'CAPTURE_PAGE':
      return onCapturePage(msg.payload);
    case 'OPEN_PANEL':
      try {
        await chrome.sidePanel.open({ tabId: sender.tab?.id });
      } catch (_) {}
      return { ok: true };
    case 'GET_BOOTSTRAP':
      return onGetBootstrap();
    case 'GET_RESULTS':
      return { ok: true, results: await getResults(msg.sessionId || (await getActiveSessionId())) };
    case 'LIST_SESSIONS':
      return { ok: true, sessions: await listSessions(), activeSessionId: await getActiveSessionId() };
    case 'CREATE_SESSION': {
      const s = await createSession(msg.name);
      await chrome.storage.local.set({ activeSessionId: s.sessionId });
      return { ok: true, session: s };
    }
    case 'SELECT_SESSION':
      await chrome.storage.local.set({ activeSessionId: msg.sessionId });
      return { ok: true };
    case 'SAVE_SETTINGS': {
      const merged = { ...(await getSettings()), ...msg.settings };
      await chrome.storage.local.set({ settings: merged });
      return { ok: true, settings: merged };
    }
    case 'START_PAGINATION':
      return onStartPagination(msg);
    case 'STOP_PAGINATION': {
      const job = await getJob();
      await setJob({ ...job, active: false });
      broadcast({ type: 'PAGINATION_STATE', active: false });
      return { ok: true };
    }
    case 'PAUSE_PAGINATION': {
      const job = await getJob();
      if (!job.active) return { ok: false, error: 'No active run to pause.' };
      await setJob({ ...job, paused: true });
      broadcast({ type: 'PAGINATION_STATE', active: true, paused: true, query: job.query });
      return { ok: true };
    }
    case 'RESUME_PAGINATION': {
      const job = await getJob();
      await setJob({ ...job, active: true, paused: false });
      // Re-enter the walk loop by reloading the paused SERP: the content script
      // re-captures it (deduped) and the next-page navigation continues from here.
      const tab = sender?.tab || (await getTargetTab(msg.tabId));
      if (tab) { try { await chrome.tabs.reload(tab.id); } catch (_) {} }
      broadcast({ type: 'PAGINATION_STATE', active: true, paused: false, query: job.query });
      return { ok: true };
    }
    case 'SKIP_QUERY':
      return onSkipQuery(msg, sender);
    case 'OPEN_QUERY':
      return onOpenQuery(msg);
    case 'SUGGEST_SPLITS':
      return onSuggestSplits(msg);
    case 'AUTO_SPLIT':
      return onAutoSplit(msg);
    case 'CHECK_STATUS':
      return onCheckStatus(msg);
    case 'PUSH_WEBHOOK':
      return onPushWebhook(msg);
    case 'RUN_TRIAGE':
      return onRunTriage(msg);
    case 'STOP_TRIAGE': {
      if (triageController) triageController.abort();
      return { ok: true };
    }
    default:
      return { ok: false, error: 'unknown message ' + msg.type };
  }
}

// ---- capture + pagination ----------------------------------------------------

async function onCapturePage(payload) {
  const { query, start, page, url, state, entities } = payload;
  const sessionId = await getActiveSessionId();
  const settings = await getSettings();

  // Persist entities (stamp the active session; dedup/merge happens in db layer).
  let inserted = 0;
  for (const e of entities || []) {
    const res = await upsertResult({ ...e, sessionId });
    if (res === 'inserted') inserted++;
  }
  if (query) await addQueryToSession(sessionId, query);
  const sessionTotal = await countResults(sessionId);
  broadcast({ type: 'RESULTS_UPDATED', sessionId, inserted, sessionTotal });

  const job = await getJob();

  // CAPTCHA: pause everything, ask the user to solve & resume.
  if (state?.captcha) {
    await setJob({ ...job, active: job.active, paused: true });
    broadcast({ type: 'CAPTCHA', query, sessionTotal });
    return { action: 'captcha', sessionTotal };
  }

  const jobMatches = job.active && job.query && query && job.query === query;
  if (!jobMatches) {
    return { action: 'stop', sessionTotal, reason: 'single page' };
  }

  // User-initiated pause: stop walking but keep the job so Resume can continue.
  if (job.paused) {
    broadcast({ type: 'PAGINATION_STATE', active: true, paused: true, query, sessionTotal });
    return { action: 'stop', sessionTotal, reason: 'paused' };
  }

  if (state?.noResults) {
    const advance = await nextQueuedQuery(job, settings, sessionTotal);
    if (advance) return advance;
    await setJob({ ...job, active: false });
    broadcast({ type: 'PAGINATION_STATE', active: false, reason: 'no results' });
    return { action: 'stop', sessionTotal, reason: 'no results' };
  }

  // Result cap hit (omitted notice). In "all pages" mode Google's omitted notice
  // and reported page count are unreliable — more pages keep appearing as you walk
  // forward — so we ignore it and keep going (as long as the page still has results)
  // until a genuinely empty page stops us below. In normal mode we halt and prompt
  // for query slicing.
  if (state?.omitted && !job.allPages) {
    await setJob({ ...job, active: false, capHit: true });
    broadcast({ type: 'CAP_HIT', query, sessionTotal });
    return { action: 'stop', sessionTotal, reason: 'result cap — slice the query', capHit: true };
  }

  // Empty page beyond the first => exhausted.
  if ((entities || []).length === 0 && start > 0) {
    const advance = await nextQueuedQuery(job, settings, sessionTotal);
    if (advance) return advance;
    await setJob({ ...job, active: false });
    broadcast({ type: 'PAGINATION_STATE', active: false, reason: 'exhausted' });
    return { action: 'stop', sessionTotal, reason: 'no more results' };
  }

  // In "all pages" mode we walk until Google naturally exhausts the query
  // (handled by the no-results / cap / empty-page branches above), guarded only
  // by a hard safety ceiling. Otherwise we stop at the configured max.
  const limit = job.allPages ? HARD_PAGE_CEILING : (job.maxPages || settings.maxPages);
  if (page >= limit) {
    const advance = await nextQueuedQuery(job, settings, sessionTotal);
    if (advance) return advance;
    await setJob({ ...job, active: false });
    const reason = job.allPages ? `safety ceiling (${limit} pages)` : `reached max ${limit} pages`;
    broadcast({ type: 'PAGINATION_STATE', active: false, reason });
    return { action: 'stop', sessionTotal, reason };
  }

  const nextStart = start + 10;
  const nextUrl = buildPageUrl(url, nextStart, settings.disableFilter);
  const delayMs = jitter(settings.minDelayMs, settings.maxDelayMs);
  await setJob({ ...job, lastStart: start });
  broadcast({ type: 'PAGINATION_STATE', active: true, page, sessionTotal });
  return { action: 'navigate', url: nextUrl, delayMs, sessionTotal, autoSplit: !!job.autoSplit, remaining: (job.queue || []).length };
}

async function onStartPagination(msg) {
  const settings = await getSettings();
  const tab = await getTargetTab(msg.tabId);
  if (!tab || !/\/search/.test(tab.url || '')) {
    return { ok: false, error: 'Active tab is not a Google search results page.' };
  }
  const u = new URL(tab.url);
  const query = u.searchParams.get('q') || '';
  if (!query) return { ok: false, error: 'No query found on the active tab.' };

  const allPages = !!msg.allPages;
  const maxPages = msg.maxPages || settings.maxPages;
  console.log('[DorkWay] START_PAGINATION', { query, allPages, maxPages });
  await setJob({ active: true, paused: false, query, maxPages, allPages, capHit: false });

  // Restart from page 1 with the omission filter disabled.
  const firstUrl = buildPageUrl(tab.url, 0, settings.disableFilter);
  await chrome.tabs.update(tab.id, { url: firstUrl });
  return { ok: true, query, maxPages, allPages };
}

async function onOpenQuery(msg) {
  const settings = await getSettings();
  const q = msg.query || '';
  const base = msg.googleBase || 'https://www.google.com/search';
  const url = `${base}?q=${encodeURIComponent(q)}${settings.disableFilter ? '&filter=0' : ''}`;

  if (msg.startPagination) {
    await setJob({ active: true, paused: false, query: q, maxPages: msg.maxPages || settings.maxPages, allPages: !!msg.allPages, capHit: false });
  }
  const tab = await getTargetTab(msg.tabId);
  if (tab && /\/search/.test(tab.url || '') && msg.reuseTab !== false) {
    await chrome.tabs.update(tab.id, { url });
    return { ok: true, tabId: tab.id };
  }
  const created = await chrome.tabs.create({ url });
  return { ok: true, tabId: created.id };
}

async function getTargetTab(tabId) {
  if (tabId) {
    try {
      return await chrome.tabs.get(tabId);
    } catch (_) {}
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

// ---- query splitting ---------------------------------------------------------

// Dork pattern catalog — each entry is a focused attack-surface probe that gets
// scoped to the current site:. `kind` is the badge shown in the panel; `pat` is
// the operator clause appended to the base query. Grouped loosely by what they
// surface: auth/forms, files, params, exposure.
const PATTERN_SPLITS = [
  // --- forms, buttons & interactive entry points ---
  { kind: 'login-forms', pat: '(inurl:login OR inurl:signin OR inurl:logon OR intitle:login OR intitle:"sign in")' },
  { kind: 'admin-panels', pat: '(inurl:admin OR inurl:administrator OR inurl:cpanel OR intitle:dashboard OR intitle:"control panel")' },
  { kind: 'register-forms', pat: '(inurl:register OR inurl:signup OR inurl:registration OR intitle:register OR intext:"create an account")' },
  { kind: 'submit-forms', pat: '(intext:"submit" OR intitle:form OR inurl:form) (inurl:contact OR inurl:feedback OR inurl:apply)' },
  { kind: 'upload-forms', pat: '(inurl:upload OR intext:"choose file" OR intext:"browse..." OR intitle:upload)' },
  { kind: 'search-forms', pat: '(inurl:search OR inurl:q= OR inurl:query= OR intitle:search)' },
  { kind: 'login-fields', pat: 'intext:"username" intext:"password"' },
  { kind: 'password-reset', pat: '(inurl:reset OR inurl:forgot OR intext:"forgot password" OR intext:"reset your password")' },
  { kind: 'contact-forms', pat: '(inurl:contact OR intitle:"contact us" OR intext:"send message")' },
  // --- files & directories ---
  { kind: 'directory-listing', pat: 'intitle:"index of"' },
  { kind: 'config-files', pat: '(ext:env OR ext:ini OR ext:conf OR ext:cfg OR ext:yml OR inurl:config OR inurl:web.config)' },
  { kind: 'backups-dumps', pat: '(ext:sql OR ext:bak OR ext:old OR ext:backup OR ext:gz OR inurl:backup OR inurl:dump)' },
  { kind: 'logs', pat: '(ext:log OR inurl:log OR intext:"begin error log")' },
  { kind: 'documents', pat: '(ext:pdf OR ext:doc OR ext:docx OR ext:xls OR ext:xlsx OR ext:csv OR ext:ppt)' },
  { kind: 'spreadsheets', pat: '(ext:xls OR ext:xlsx OR ext:csv) (intext:password OR intext:email OR intext:user)' },
  // --- parameters / injectable surface ---
  { kind: 'id-params', pat: '(inurl:id= OR inurl:uid= OR inurl:user= OR inurl:account= OR inurl:order=)' },
  { kind: 'file-params', pat: '(inurl:file= OR inurl:path= OR inurl:page= OR inurl:document= OR inurl:include= OR inurl:dir=)' },
  { kind: 'redirect-params', pat: '(inurl:redirect= OR inurl:url= OR inurl:next= OR inurl:return= OR inurl:goto= OR inurl:dest=)' },
  { kind: 'api-endpoints', pat: '(inurl:api OR inurl:graphql OR inurl:rest OR inurl:/v1/ OR inurl:/v2/ OR inurl:swagger OR inurl:openapi)' },
  // --- exposure & misconfig ---
  { kind: 'git-exposure', pat: '(inurl:.git OR inurl:.gitignore OR inurl:.svn OR intitle:"index of" intext:.git)' },
  { kind: 'debug-errors', pat: '(intext:"stack trace" OR intext:"fatal error" OR intext:"warning:" OR intext:"sql syntax" OR inurl:debug)' },
  { kind: 'phpinfo', pat: '(intitle:phpinfo OR intext:"php version" intext:"configuration")' },
  { kind: 'db-admin', pat: '(inurl:phpmyadmin OR inurl:adminer OR intitle:phpmyadmin OR inurl:pgadmin)' },
  { kind: 'secrets', pat: '(intext:apikey OR intext:"api_key" OR intext:"secret_key" OR intext:"access_token" OR intext:"BEGIN RSA PRIVATE KEY")' },
  { kind: 'env-files', pat: '(inurl:.env OR ext:env OR intext:"DB_PASSWORD" OR intext:"APP_KEY")' },
  { kind: 'cms-wordpress', pat: '(inurl:wp-content OR inurl:wp-admin OR inurl:wp-login OR inurl:wp-json)' }
];

async function onSuggestSplits(msg) {
  const sessionId = await getActiveSessionId();
  const results = await getResults(sessionId);
  const baseQuery = (msg.query || '').trim();
  // Wildcard-scoped variant of the base query: rewrite site:host → site:*.host
  // (stripping any www. and skipping hosts already wildcarded) so derived
  // slices sweep every subdomain, not just the apex.
  const wildcardBase = baseQuery.replace(/site:([^\s]+)/i, (m, host) =>
    /^\*\./.test(host) ? m : `site:*.${host.replace(/^www\./, '')}`
  );

  const suggestions = [];

  // 1) Subdomain walk — if site: is in play, enumerate discovered subdomains.
  const siteMatch = baseQuery.match(/site:([^\s]+)/i);
  if (siteMatch) {
    const root = siteMatch[1].replace(/^www\./, '');
    const subs = new Set();
    for (const r of results) {
      if (r.rootDomain && root.endsWith(r.rootDomain) && r.subdomain) subs.add(r.subdomain);
    }
    const stripped = baseQuery.replace(/site:[^\s]+/i, '').trim();

    // Wildcard subdomain sweeps — any single-level (*.root) and nested
    // (*.*.root) subdomain. Useful when no concrete subdomains are known yet.
    for (const pat of [`*.${root}`, `*.*.${root}`]) {
      suggestions.push({ kind: 'wildcard', label: `site:${pat}`, query: `site:${pat} ${stripped}`.trim() });
    }

    for (const sub of subs) {
      suggestions.push({ kind: 'subdomain', label: `site:*.${sub}.${root}`, query: `site:*.${sub}.${root} ${stripped}`.trim() });
    }

    // Discover *new* subdomains: search the root while excluding www and every
    // subdomain already found, so Google has to surface the ones we don't have.
    const excludeSubs = new Set(['www', ...subs]);
    const exclusions = [...excludeSubs].map((s) => `-site:${s}.${root}`);
    suggestions.push({
      kind: 'exclude-known',
      label: `site:*.${root} ${[...excludeSubs].map((s) => '-' + s).join(' ')}`,
      query: `site:*.${root} ${exclusions.join(' ')} ${stripped}`.trim()
    });

    // Dork pattern catalog — scope each attack-surface probe to *.root so it
    // sweeps every subdomain (not just the apex): forms, panels, exposed
    // files, injectable params, etc.
    for (const { kind, pat } of PATTERN_SPLITS) {
      suggestions.push({ kind, label: `site:*.${root} ${pat}`, query: `site:*.${root} ${pat} ${stripped}`.trim() });
    }
  }

  // 2) Filetype slices — split a broad query by common sensitive file types.
  if (!/filetype:/i.test(baseQuery)) {
    for (const ft of ['pdf', 'sql', 'xml', 'json', 'csv', 'env', 'bak', 'log', 'xls', 'txt']) {
      suggestions.push({ kind: 'filetype', label: `filetype:${ft}`, query: `${wildcardBase} filetype:${ft}`.trim() });
    }
  }

  // 3) Date bisection — split a wide window into halves (recurse client-side as needed).
  const now = new Date();
  const dateSlices = bisectDates(new Date(now.getFullYear() - 5, 0, 1), now, 2);
  for (const [a, b] of dateSlices) {
    suggestions.push({
      kind: 'date',
      label: `after:${a} before:${b}`,
      query: `${wildcardBase} after:${a} before:${b}`.trim()
    });
  }

  return { ok: true, suggestions };
}

// Build a search URL for a query's first page (start=0, omission filter optional).
function buildQueryUrl(query, disableFilter) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}${disableFilter ? '&filter=0' : ''}`;
}

// Auto-split: queue every split query and walk them back-to-back, fully
// paginating each one before moving to the next. Reuses the pagination job —
// `queue` holds the remaining queries; nextQueuedQuery() advances it whenever a
// query naturally exhausts. The whole run shares one tab so it looks like a
// single continuous crawl.
async function onAutoSplit(msg) {
  const settings = await getSettings();

  let queries = Array.isArray(msg.queries) ? msg.queries : null;
  if (!queries) {
    const { suggestions } = await onSuggestSplits(msg);
    queries = suggestions.map((s) => s.query);
  }
  // Normalize + dedup so we don't re-walk identical slices.
  queries = [...new Set(queries.map((q) => (q || '').trim()).filter(Boolean))];
  if (!queries.length) return { ok: false, error: 'No split queries to run.' };

  const [first, ...rest] = queries;
  const maxPages = msg.maxPages || settings.maxPages;
  await setJob({
    active: true,
    paused: false,
    query: first,
    maxPages,
    allPages: true,
    capHit: false,
    autoSplit: true,
    queue: rest
  });

  const url = buildQueryUrl(first, settings.disableFilter);
  const tab = await getTargetTab(msg.tabId);
  if (tab && /\/search/.test(tab.url || '')) {
    await chrome.tabs.update(tab.id, { url });
  } else {
    await chrome.tabs.create({ url });
  }
  broadcast({ type: 'PAGINATION_STATE', active: true, autoSplit: true, query: first, remaining: rest.length });
  return { ok: true, total: queries.length, first, remaining: rest.length };
}

// If an auto-split queue still has queries, set up the next one and return a
// navigate action so the content script drives the shared tab to it. Returns
// null when there's nothing queued (caller then stops the job as usual).
async function nextQueuedQuery(job, settings, sessionTotal) {
  if (!job.autoSplit || !job.queue || !job.queue.length) return null;
  const [next, ...remaining] = job.queue;
  await setJob({
    active: true,
    paused: false,
    query: next,
    maxPages: job.maxPages,
    allPages: job.allPages,
    capHit: false,
    autoSplit: true,
    queue: remaining
  });
  const delayMs = jitter(settings.minDelayMs, settings.maxDelayMs);
  broadcast({ type: 'PAGINATION_STATE', active: true, autoSplit: true, query: next, remaining: remaining.length, sessionTotal });
  return { action: 'navigate', url: buildQueryUrl(next, settings.disableFilter), delayMs, sessionTotal, autoSplit: true, remaining: remaining.length };
}

// Skip the query currently being walked and jump straight to the next one in the
// auto-split queue. Unlike STOP, this keeps the run going — it just abandons the
// remaining pages of the current query. With nothing queued, it stops the run.
// Drives the shared tab directly so it takes effect immediately, mid-walk,
// without waiting for the next page capture.
async function onSkipQuery(msg, sender) {
  const settings = await getSettings();
  const job = await getJob();
  if (!job.active) return { ok: false, error: 'No active query run to skip.' };

  const sessionTotal = await countResults(await getActiveSessionId());
  const tab = sender?.tab || (await getTargetTab(msg.tabId));

  if (job.autoSplit && job.queue && job.queue.length) {
    const [next, ...remaining] = job.queue;
    await setJob({
      active: true,
      paused: false,
      query: next,
      maxPages: job.maxPages,
      allPages: job.allPages,
      capHit: false,
      autoSplit: true,
      queue: remaining
    });
    if (tab) await chrome.tabs.update(tab.id, { url: buildQueryUrl(next, settings.disableFilter) });
    broadcast({ type: 'PAGINATION_STATE', active: true, autoSplit: true, query: next, remaining: remaining.length, sessionTotal });
    return { ok: true, query: next, remaining: remaining.length };
  }

  // Nothing queued — skipping the only/last query just ends the run.
  await setJob({ ...job, active: false });
  broadcast({ type: 'PAGINATION_STATE', active: false, reason: 'skipped' });
  return { ok: true, stopped: true };
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

// Split [start,end] into 2^depth contiguous slices.
function bisectDates(start, end, depth) {
  let ranges = [[start, end]];
  for (let i = 0; i < depth; i++) {
    const next = [];
    for (const [a, b] of ranges) {
      const mid = new Date((a.getTime() + b.getTime()) / 2);
      next.push([a, mid], [new Date(mid.getTime() + 86400000), b]);
    }
    ranges = next;
  }
  return ranges.map(([a, b]) => [fmt(a), fmt(b)]);
}

// ---- status-code enrichment (opt-in, throttled to 2 concurrent) --------------

let statusRunning = false;

async function onCheckStatus(msg) {
  if (statusRunning) return { ok: false, error: 'A status check is already running.' };
  const sessionId = msg.sessionId || (await getActiveSessionId());
  const all = await getResults(sessionId);
  const targets = all.filter((r) => !r.statusCode || msg.recheck);
  if (!targets.length) return { ok: true, checked: 0 };

  statusRunning = true;
  let checked = 0;
  const CONCURRENCY = 2;

  const queue = targets.slice();
  async function worker() {
    while (queue.length) {
      const r = queue.shift();
      const code = await probe(r.url);
      await updateResultStatus(sessionId, r.id, code);
      checked++;
      if (checked % 5 === 0) broadcast({ type: 'STATUS_PROGRESS', sessionId, checked, total: targets.length });
    }
  }
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    statusRunning = false;
  }
  broadcast({ type: 'RESULTS_UPDATED', sessionId });
  return { ok: true, checked };
}

async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    let resp = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: controller.signal });
    // Some servers reject HEAD; fall back to a ranged GET.
    if (resp.status === 405 || resp.status === 0) {
      resp = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: controller.signal });
    }
    return resp.status || 0;
  } catch (_) {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

// ---- webhook / DB push (chunks of 100, retry x3 with backoff) -----------------

async function onPushWebhook(msg) {
  const settings = await getSettings();
  if (!settings.webhookUrl) return { ok: false, error: 'No webhook URL configured in settings.' };

  const sessionId = msg.sessionId || (await getActiveSessionId());
  const entities = msg.entities && msg.entities.length ? msg.entities : await getResults(sessionId);
  if (!entities.length) return { ok: false, error: 'Nothing to send.' };

  const session = await getSession(sessionId);
  const chunks = chunk(entities, 100);
  let sent = 0;
  const failures = [];

  for (let i = 0; i < chunks.length; i++) {
    const body = JSON.stringify({
      session: session ? { sessionId: session.sessionId, name: session.name } : null,
      batch: i + 1,
      batches: chunks.length,
      results: chunks[i].map(stripInternal)
    });
    const ok = await postWithRetry(settings.webhookUrl, settings.webhookSecret, body);
    if (ok) sent += chunks[i].length;
    else failures.push(i + 1);
  }

  return { ok: failures.length === 0, sent, total: entities.length, failedBatches: failures };
}

function stripInternal(r) {
  const { compositeKey, ...rest } = r;
  return rest;
}

async function postWithRetry(url, secret, body, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { 'X-DorkWay-Secret': secret } : {})
        },
        body
      });
      if (resp.ok) return true;
    } catch (_) {}
    // Exponential backoff: 0.5s, 1s, 2s.
    await sleep(500 * Math.pow(2, i));
  }
  return false;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function onGetBootstrap() {
  return {
    ok: true,
    settings: await getSettings(),
    sessions: await listSessions(),
    activeSessionId: await getActiveSessionId(),
    job: await getJob()
  };
}

// ---- AI Triage (agentic LLM) -------------------------------------------------

// Safety cap on tool-use rounds, so a misbehaving model can't loop forever.
const TRIAGE_MAX_ITERS = 8;

// Recon-analyst persona. The model is an AGENT: it starts from the operator's
// filtered results and calls get_results to pull more of the captured corpus,
// deciding for itself what is interesting, before writing the final report.
const TRIAGE_SYSTEM = `You are a senior offensive-security / OSINT reconnaissance analyst operating as an autonomous agent. The operator is running DorkWay on an AUTHORISED engagement and has captured Google-dork search results into a session. The user is not watching in real time — investigate on your own and only stop when you have produced the final report.

You are given, up front: the dork queries that were run, and an INVENTORY OVERVIEW of the captured corpus. The overview's \`byRootDomain\` is a correlation map — for each root domain, its result count, distinct-subdomain count, top tags and notable file types — so you can see at a glance where the interesting attack surface concentrates. Below it are flat whole-corpus legends (rootDomains, subdomains, fileTypes, tags, statuses) and a status-enrichment flag. You are NOT given the raw records; you must retrieve them yourself.

Tools (all operate only over the ALREADY-CAPTURED data — no new Google searches):
- get_stats(groupBy, <filters>) — counts the corpus grouped by a facet (rootDomain | subdomain | tag | fileType | status), optionally pre-filtered. Costs NO record payload. Use it to drill into the overview cheaply (e.g. "which subdomains carry the admin tag", "filetype breakdown for target.com").
- get_results(rootDomain?, subdomain?, tag?, fileType?, keyword?, status?, sortBy?, order?, countOnly?, limit?) — returns the matching records (URL, title, snippet, path, queryParams, rank, tags, status). Filters are case-insensitive; multi-value fields (rootDomain, subdomain, tag, fileType, status) accept a comma-separated list for OR. Use countOnly:true to size a query before pulling, and sortBy:"rank" to see the most relevant first. This is the only way to see actual URLs.
- check_status(urls) — IF AVAILABLE to you: probes whether specific captured assets are live (outbound request, captured URLs only) and records the HTTP status. Use it sparingly, only to confirm that genuinely high-value findings (admin panels, exposed files/configs, secrets) are reachable before you report them. It is omitted when status checks aren't authorised — do not assume it exists.

Tag glossary (auto-assigned from path + query string): login/register/account/password = auth surface; admin = admin or control panels; api = API/GraphQL/REST/swagger endpoints; upload = file-upload surface; payment = checkout/billing; search = search/query endpoints; form = contact/feedback/subscribe forms; config = .env/.conf/.ini/.yml/web.config; backup = .bak/.old/dumps/archives; database = phpmyadmin/adminer/.sql/db admin; cms = WordPress/Joomla/Drupal/etc.; debug = stack traces/phpinfo/error pages/test endpoints; git = exposed .git/.svn; redirect = open-redirect params (url=, next=, return=…); traversal = path/file params (file=, path=, page=…); idor = numeric id params (id=, uid=, order=…); sensitive = secret/token/apikey/credential markers; exposed-file = data files (sql/csv/xls/json/log/bak/dump). statusCode is 0 (unchecked) unless the overview's statusEnriched flag is true.

Work like an analyst: read \`byRootDomain\` and the queries, use get_stats to triage where the risk is, then issue targeted get_results calls (sensitive tags, unusual subdomains, exposed file types, injectable params in queryParams, anomalous hosts). Don't dump the corpus blindly — query with intent, guided by the counts. When confident, stop calling tools and write the report.

Final output — Markdown with these sections:
1. **Summary** — 2-3 sentences on scope and what stands out.
2. **High-value findings** — sensitive/risky assets (admin, login, configs, backups, secrets, exposed listings, debug/error pages, internal APIs, injectable params) with a one-line rationale and the URL; note liveness if you checked it.
3. **Unique assets** — grouped by root domain -> subdomain, one line per distinct asset (URL + what it is). Deduplicate aggressively; collapse pagination, tracking params and near-duplicate URLs; drop obvious noise (marketing pages, unrelated third-party domains, trackers).
4. **Suggested next dorks** — gaps the queries and captured data did not cover, as concrete runnable Google dork strings. Use real operators — site:, site:*.root (subdomain sweep), inurl:, intitle:, intext:, filetype:/ext:, after:/before:, and -site: exclusions — scoped to the roots/subdomains actually in scope.

Rules: assert only what the data supports — never invent hosts, paths or findings. Be concise. This is authorised security research; do not refuse triage of the supplied data.`;

// JSON Schema for the get_results filter, shared by both providers' wrappers.
// Multi-value fields accept a comma-separated list (OR semantics) — kept as plain
// strings so the schema validates identically on Anthropic and OpenAI-compatible APIs.
const GET_RESULTS_SCHEMA = {
  type: 'object',
  properties: {
    rootDomain: { type: 'string', description: 'Registrable domain(s) to match, e.g. "target.com". Comma-separate for OR: "a.com,b.com".' },
    subdomain: { type: 'string', description: 'Substring match on the subdomain, e.g. "api". Comma-separate for OR.' },
    tag: { type: 'string', description: 'Inferred tag(s): login, admin, api, config, backup, database, idor, traversal, redirect, git, sensitive, exposed-file, debug, etc. Comma-separate for OR.' },
    fileType: { type: 'string', description: 'File extension(s), e.g. "sql,env,bak". Comma-separate for OR.' },
    keyword: { type: 'string', description: 'Case-insensitive substring across title, snippet, url, path and query params.' },
    status: { type: 'string', description: 'HTTP status code(s) to match, e.g. "200,403"; 0 means unchecked. Comma-separate for OR.' },
    sortBy: { type: 'string', enum: ['rank', 'capturedAt'], description: 'Sort the matches: "rank" (Google relevance, best first) or "capturedAt" (newest first).' },
    order: { type: 'string', enum: ['asc', 'desc'], description: 'Override the default sort direction.' },
    countOnly: { type: 'boolean', description: 'If true, return only the match count (no records) — cheap probing before pulling.' },
    limit: { type: 'integer', description: 'Max results to return (default 100, capped at 300).' }
  },
  required: []
};

const GET_RESULTS_DESC =
  "Search the operator's ALREADY-CAPTURED DorkWay results for this session (no network access, no new Google searches). Returns matching records plus the total match count. You were given only an inventory overview, not the results themselves — this is the only way to retrieve the actual records. Use countOnly first to gauge size, then pull with intent.";

// JSON Schema for get_stats — same filter fields as get_results, plus the facet to
// group by. Lets the agent navigate the corpus by counts without pulling records.
const GET_STATS_SCHEMA = {
  type: 'object',
  properties: {
    groupBy: { type: 'string', enum: ['rootDomain', 'subdomain', 'tag', 'fileType', 'status'], description: 'Facet to group the (optionally filtered) results by.' },
    rootDomain: { type: 'string', description: 'Optional pre-filter — registrable domain(s), comma-separated for OR.' },
    subdomain: { type: 'string', description: 'Optional pre-filter — subdomain substring(s), comma-separated for OR.' },
    tag: { type: 'string', description: 'Optional pre-filter — tag(s), comma-separated for OR.' },
    fileType: { type: 'string', description: 'Optional pre-filter — file extension(s), comma-separated for OR.' },
    keyword: { type: 'string', description: 'Optional pre-filter — substring across title, snippet, url, path and query params.' },
    status: { type: 'string', description: 'Optional pre-filter — HTTP status code(s), comma-separated for OR.' }
  },
  required: ['groupBy']
};

const GET_STATS_DESC =
  "Aggregate the operator's ALREADY-CAPTURED results: count them grouped by a facet (rootDomain, subdomain, tag, fileType or status), optionally narrowed by the same filters as get_results. No network access. Use this to explore the corpus by the numbers — it costs no record payload, so prefer it over dumping records when you only need to know what exists and how much.";

// JSON Schema for check_status — the one OUTBOUND tool. Only offered to the agent
// when status checks are enabled AND the broad host permission is already granted.
const CHECK_STATUS_SCHEMA = {
  type: 'object',
  properties: {
    urls: { type: 'array', items: { type: 'string' }, description: 'Captured asset URLs to probe for liveness (max 25 per call). URLs not in the captured corpus are ignored.' }
  },
  required: ['urls']
};

const CHECK_STATUS_DESC =
  "Probe whether captured assets are LIVE (HTTP HEAD/ranged-GET). This makes outbound network requests — only to URLs already captured in this session — and persists the resulting status codes. Use it sparingly to confirm that high-value findings (admin panels, exposed files, configs) are reachable before reporting them. Returns {url, statusCode} for each (0 = unreachable/timeout).";

// Max URLs the agent may probe per check_status call.
const CHECK_STATUS_MAX = 25;

// One run at a time; STOP_TRIAGE aborts via this controller.
let triageController = null;

async function onRunTriage(msg) {
  const settings = await getSettings();
  if (!settings.llmApiKey) {
    return { ok: false, error: 'No API key — open LLM Settings and add one.' };
  }

  const sessionId = await getActiveSessionId();
  const all = await getResults(sessionId);
  if (!all.length) return { ok: false, error: 'No results to triage in this session.' };
  const session = await getSession(sessionId);

  // Queries the agent gets to reason about: the session's recorded dork queries,
  // unioned with the distinct sourceQuery seen across the captured results.
  const queries = new Set((session?.queries || []).filter(Boolean));
  for (const r of all) {
    for (const q of String(r.sourceQuery || '').split('\n')) {
      if (q.trim()) queries.add(q.trim());
    }
  }

  // The agent is NOT handed raw results (would overload its context). It gets an
  // inventory overview — a per-root-domain correlation map plus flat facet legends —
  // and pulls the actual records itself via get_results / explores counts via get_stats.
  const initialPayload = JSON.stringify({
    session: { name: session?.name || '' },
    queries: [...queries],
    note: `This is an inventory overview of the ${all.length} captured result(s) in this session. \`byRootDomain\` correlates each root domain with its subdomain count, top tags and file types — your primary map of where the interesting surface is; the flat lists below it are whole-corpus legends. You were NOT given the raw records. Use get_stats to explore counts cheaply and get_results to pull the actual records for whatever you decide to investigate.`,
    totalCount: all.length,
    overview: buildTriageOverview(all)
  });

  // check_status is the one OUTBOUND tool — gate it on the existing authorised-use
  // flag AND the broad host permission already being granted (the agent has no user
  // gesture to request it mid-loop). If either is missing, the tool isn't offered.
  let allowCheckStatus = false;
  if (settings.statusCheckEnabled) {
    allowCheckStatus = await chrome.permissions
      .contains({ origins: ['*://*/*'] })
      .catch(() => false);
  }
  const ctx = { sessionId, allowCheckStatus };

  triageController = new AbortController();
  try {
    if (settings.llmProvider === 'openai') {
      await runOpenAIAgent(settings, initialPayload, all, ctx);
    } else {
      await runAnthropicAgent(settings, initialPayload, all, ctx);
    }
    return { ok: true };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      broadcast({ type: 'TRIAGE_DONE', aborted: true });
    } else {
      broadcast({ type: 'TRIAGE_ERROR', error: String((err && err.message) || err) });
    }
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    triageController = null;
  }
}

// Aggregate the captured corpus into the agent's MAP of what exists. Beyond the
// flat per-facet legend (the same facets as the Results filter tab), it correlates
// per root domain — count, distinct subdomains, top tags and file types — so the
// agent can see *where* the interesting surface is without spending tool rounds to
// find out. Each value renders as a compact "value (count)" string sorted by count.
// It then pulls the actual records via get_results / explores counts via get_stats.
// Capped per facet (and per-root) to keep the agent's context small.
function buildTriageOverview(all) {
  const root = new Map(), sub = new Map(), ft = new Map(), tags = new Map(), status = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  // Per-root sub-aggregations: subdomain set, tag counts, filetype counts.
  const perRoot = new Map(); // rootDomain -> { count, subs:Set, tags:Map, fts:Map }
  let checked = 0;
  for (const r of all) {
    const rd = r.rootDomain || '(unknown)';
    bump(root, rd);
    bump(sub, r.subdomain || '(root)');
    if (r.fileType) bump(ft, r.fileType);
    for (const t of r.tags || []) bump(tags, t);
    if (r.statusCode) { bump(status, String(r.statusCode)); checked++; }

    let pr = perRoot.get(rd);
    if (!pr) { pr = { count: 0, subs: new Set(), tags: new Map(), fts: new Map() }; perRoot.set(rd, pr); }
    pr.count++;
    pr.subs.add(r.subdomain || '(root)');
    for (const t of r.tags || []) bump(pr.tags, t);
    if (r.fileType) bump(pr.fts, r.fileType);
  }
  const top = (m, n) => {
    const entries = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const out = entries.slice(0, n).map(([value, count]) => `${value} (${count})`);
    if (entries.length > n) out.push(`…and ${entries.length - n} more`);
    return out;
  };

  // Cross-faceted per-root breakdown, biggest roots first, capped.
  const PER_ROOT_CAP = 40;
  const rootsByCount = [...perRoot.entries()].sort((a, b) => b[1].count - a[1].count);
  const byRootDomain = rootsByCount.slice(0, PER_ROOT_CAP).map(([rd, pr]) => ({
    rootDomain: rd,
    count: pr.count,
    subdomains: pr.subs.size,
    topTags: top(pr.tags, 12),
    fileTypes: top(pr.fts, 12)
  }));
  if (rootsByCount.length > PER_ROOT_CAP) {
    byRootDomain.push({ note: `…and ${rootsByCount.length - PER_ROOT_CAP} more root domains` });
  }

  return {
    // Per-root correlation map — the agent's primary navigation aid.
    byRootDomain,
    // Flat legends for quick reference across the whole corpus.
    rootDomains: top(root, 60),
    subdomains: top(sub, 100),
    fileTypes: top(ft, 40),
    tags: top(tags, 40),
    statuses: top(status, 20),
    // statusCode is 0 until the operator runs the status check — tell the agent
    // whether it's meaningful so it doesn't read into unchecked 0s.
    statusEnriched: checked > 0,
    statusChecked: checked,
    statusUnchecked: all.length - checked
  };
}

// Normalize a filter arg into a lowercased string list. Accepts an array, a
// comma-separated string, or a single value. Empty -> null (no constraint).
function toList(v) {
  if (v == null || v === '') return null;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  return out.length ? out : null;
}

// Like toList but numeric, for status codes (0 = unchecked is a valid value).
function toStatusList(v) {
  if (v == null || v === '') return null;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = arr.map((s) => parseInt(String(s).trim(), 10)).filter((n) => !Number.isNaN(n));
  return out.length ? out : null;
}

// Shared predicate for get_results and get_stats. Multi-value fields use OR; the
// distinct fields combine with AND. Pure, case-insensitive.
function matchesFilter(r, f) {
  if (!f) return true;
  const roots = toList(f.rootDomain);
  if (roots && !roots.includes(String(r.rootDomain || '').toLowerCase())) return false;

  const subs = toList(f.subdomain);
  if (subs) {
    const rs = String(r.subdomain || '').toLowerCase();
    if (!subs.some((s) => rs.includes(s))) return false;
  }

  const fts = toList(f.fileType);
  if (fts && !fts.includes(String(r.fileType || '').toLowerCase())) return false;

  const tagFilters = toList(f.tag);
  if (tagFilters) {
    const rtags = (r.tags || []).map((t) => String(t).toLowerCase());
    if (!tagFilters.some((t) => rtags.includes(t))) return false;
  }

  const statuses = toStatusList(f.status);
  if (statuses && !statuses.includes(Number(r.statusCode || 0))) return false;

  if (f.keyword) {
    const kw = String(f.keyword).toLowerCase();
    const hay = `${r.title || ''}\n${r.snippet || ''}\n${r.url || ''}\n${r.path || ''}\n${r.queryParams || ''}`.toLowerCase();
    if (!hay.includes(kw)) return false;
  }
  return true;
}

// Run get_results against the full captured corpus. Pure in-memory filtering —
// no network. Returns { total, returned, results } (or just a count) as a plain object.
function executeGetResults(input, all) {
  const f = input || {};
  let matches = all.filter((r) => matchesFilter(r, f));

  // Optional sort: rank (Google relevance, best first by default) or capturedAt
  // (newest first by default); `order` overrides the direction.
  if (f.sortBy === 'rank' || f.sortBy === 'capturedAt') {
    const dir = f.order === 'asc' ? 1 : f.order === 'desc' ? -1 : (f.sortBy === 'rank' ? 1 : -1);
    matches = matches.slice().sort((a, b) => {
      if (f.sortBy === 'rank') return ((a.rank || Infinity) - (b.rank || Infinity)) * dir;
      return String(a.capturedAt || '').localeCompare(String(b.capturedAt || '')) * dir;
    });
  }

  if (f.countOnly) return { total: matches.length, returned: 0, countOnly: true };

  const limit = Math.min(Math.max(parseInt(f.limit, 10) || 100, 1), 300);
  return { total: matches.length, returned: Math.min(matches.length, limit), results: matches.slice(0, limit).map(compactEntity) };
}

// Run get_stats: count the (optionally filtered) corpus grouped by one facet.
// Pure in-memory, no network, no record payload. Returns { groupBy, total, groups }.
function executeGetStats(input, all) {
  const f = input || {};
  const groupBy = f.groupBy || 'tag';
  const matches = all.filter((r) => matchesFilter(r, f));
  const counts = new Map();
  const bump = (k) => counts.set(k, (counts.get(k) || 0) + 1);
  for (const r of matches) {
    if (groupBy === 'tag') {
      const tags = r.tags || [];
      if (!tags.length) bump('(untagged)');
      for (const t of tags) bump(t);
    } else if (groupBy === 'rootDomain') {
      bump(r.rootDomain || '(unknown)');
    } else if (groupBy === 'subdomain') {
      bump(r.subdomain || '(root)');
    } else if (groupBy === 'fileType') {
      bump(r.fileType || '(none)');
    } else if (groupBy === 'status') {
      bump(String(r.statusCode || 0));
    }
  }
  const groups = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, count }));
  return { groupBy, total: matches.length, groups };
}

// Run check_status: probe liveness for a set of CAPTURED URLs and persist the
// codes. Outbound network — gated at the call site (only registered when
// ctx.allowCheckStatus). Restricts targets to URLs already in the corpus (no
// probing arbitrary URLs), caps the batch, throttles to CONCURRENCY workers, and
// honours the abort signal.
async function executeCheckStatus(input, all, sessionId, signal) {
  const requested = Array.isArray(input?.urls) ? input.urls.map((u) => String(u).trim()) : [];
  const byUrl = new Map(all.map((r) => [r.url, r]));
  // Only probe URLs that exist in the captured corpus; dedupe; cap the batch.
  const targets = [...new Set(requested)].filter((u) => byUrl.has(u)).slice(0, CHECK_STATUS_MAX);
  if (!targets.length) return { checked: 0, results: [], note: 'No requested URLs matched the captured corpus.' };

  const out = [];
  const CONCURRENCY = 2;
  const queue = targets.slice();
  async function worker() {
    while (queue.length) {
      if (signal && signal.aborted) return;
      const url = queue.shift();
      const code = await probe(url);
      const r = byUrl.get(url);
      if (r) await updateResultStatus(sessionId, r.id, code);
      out.push({ url, statusCode: code });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  // Let the panel's Results view reflect the freshly-checked statuses.
  broadcast({ type: 'RESULTS_UPDATED', sessionId });
  return { checked: out.length, results: out };
}

function compactEntity(r) {
  return {
    title: r.title,
    url: r.url,
    rootDomain: r.rootDomain,
    subdomain: r.subdomain,
    path: r.path,
    fileType: r.fileType,
    // queryParams is the injectable surface the idor/traversal/redirect tags flag —
    // useless to omit for a security analyst. rank is Google's relevance ordering.
    queryParams: r.queryParams,
    rank: r.rank,
    tags: r.tags,
    statusCode: r.statusCode,
    sourceQuery: r.sourceQuery,
    snippet: (r.snippet || '').slice(0, 200)
  };
}

// Generic SSE reader: line-buffers and calls onData(parsedJson) per `data:` line,
// onData(null) on the OpenAI `[DONE]` sentinel.
async function readSSE(stream, onData) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { onData(null); return; }
      let evt;
      try { evt = JSON.parse(data); } catch (_) { continue; }
      onData(evt);
    }
  }
}

// --- Agent tool surface (shared by both providers) ---

// Build the per-provider tool definitions. check_status (outbound) is included
// only when the call site cleared the authorised-use gate (ctx.allowCheckStatus).
function anthropicTools(ctx) {
  const tools = [
    { name: 'get_results', description: GET_RESULTS_DESC, input_schema: GET_RESULTS_SCHEMA },
    { name: 'get_stats', description: GET_STATS_DESC, input_schema: GET_STATS_SCHEMA }
  ];
  if (ctx.allowCheckStatus) tools.push({ name: 'check_status', description: CHECK_STATUS_DESC, input_schema: CHECK_STATUS_SCHEMA });
  return tools;
}

function openaiTools(ctx) {
  const fn = (name, description, parameters) => ({ type: 'function', function: { name, description, parameters } });
  const tools = [
    fn('get_results', GET_RESULTS_DESC, GET_RESULTS_SCHEMA),
    fn('get_stats', GET_STATS_DESC, GET_STATS_SCHEMA)
  ];
  if (ctx.allowCheckStatus) tools.push(fn('check_status', CHECK_STATUS_DESC, CHECK_STATUS_SCHEMA));
  return tools;
}

// Route a tool call to its executor. check_status is async + outbound (gated);
// get_stats and get_results are pure in-memory over the captured corpus.
async function runTriageTool(name, input, all, ctx) {
  if (name === 'get_stats') return executeGetStats(input, all);
  if (name === 'check_status') {
    if (!ctx.allowCheckStatus) return { error: 'check_status is unavailable (status checks disabled or host permission not granted).' };
    return executeCheckStatus(input, all, ctx.sessionId, triageController && triageController.signal);
  }
  return executeGetResults(input, all);
}

// Derive the panel TRIAGE_TOOL_RESULT fields from a tool's output (tool-aware).
function toolResultMeta(name, out) {
  if (name === 'get_stats') return { name, count: (out.groups || []).length, total: out.total || 0 };
  if (name === 'check_status') {
    const live = (out.results || []).filter((x) => x.statusCode >= 200 && x.statusCode < 400).length;
    return { name, count: out.checked || 0, live };
  }
  return { name, count: out.countOnly ? 0 : (out.returned || 0), total: out.total || 0, countOnly: !!out.countOnly };
}

// Place a single Anthropic cache breakpoint on the most recent user tool_result
// message, clearing any earlier one, so the whole growing conversation prefix is
// served from cache each round. Only touches user-role tool_result blocks — never
// assistant/thinking blocks (modifying those is rejected on replay).
function setMessagesCacheBreakpoint(messages) {
  let marked = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user' || !Array.isArray(m.content) || !m.content.length) continue;
    if (!marked) {
      m.content[m.content.length - 1].cache_control = { type: 'ephemeral' };
      marked = true;
    } else {
      for (const b of m.content) { if (b && b.cache_control) delete b.cache_control; }
    }
  }
}

// --- Anthropic agent loop ---

async function runAnthropicAgent(settings, initialPayload, all, ctx) {
  const base = (settings.llmBaseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const url = `${base}/v1/messages`;
  const headers = {
    'content-type': 'application/json',
    'x-api-key': settings.llmApiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  const messages = [{ role: 'user', content: initialPayload }];
  // tools + system are static across the loop; the cache_control breakpoint on the
  // system block caches both (tools render before system). The growing message
  // prefix is cached via setMessagesCacheBreakpoint() each round.
  const tools = anthropicTools(ctx);
  const system = [{ type: 'text', text: TRIAGE_SYSTEM, cache_control: { type: 'ephemeral' } }];
  let usage = null;

  for (let i = 0; i < TRIAGE_MAX_ITERS; i++) {
    setMessagesCacheBreakpoint(messages);
    const body = {
      model: settings.llmModel || 'claude-opus-4-8',
      max_tokens: settings.llmMaxTokens || 16000,
      stream: true,
      system,
      tools,
      messages
    };
    if (settings.llmThinking) {
      body.thinking = { type: 'adaptive', display: 'summarized' };
      body.output_config = { effort: 'medium' };
    }

    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: triageController.signal });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      broadcast({ type: 'TRIAGE_ERROR', error: `HTTP ${resp.status} ${resp.statusText}${text ? ' — ' + text.slice(0, 300) : ''}` });
      return;
    }

    const turn = await parseAnthropicStream(resp.body);
    usage = turn.usage || usage;
    if (turn.stopReason !== 'tool_use') { broadcast({ type: 'TRIAGE_DONE', usage }); return; }

    messages.push({ role: 'assistant', content: turn.content });
    const toolResults = [];
    for (const b of turn.content) {
      if (b.type !== 'tool_use') continue;
      broadcast({ type: 'TRIAGE_TOOL', name: b.name, input: b.input });
      const out = await runTriageTool(b.name, b.input, all, ctx);
      broadcast({ type: 'TRIAGE_TOOL_RESULT', ...toolResultMeta(b.name, out) });
      toolResults.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out) });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  broadcast({ type: 'TRIAGE_DONE', usage, note: 'stopped at iteration cap' });
}

// Accumulate one streamed Anthropic message into content blocks, broadcasting
// text/thinking deltas as they arrive. Returns { content, stopReason, usage }.
async function parseAnthropicStream(stream) {
  const blocks = [];
  let stopReason = null;
  let usage = null;
  let streamError = null;

  await readSSE(stream, (evt) => {
    if (!evt) return;
    switch (evt.type) {
      case 'content_block_start': {
        const cb = evt.content_block || {};
        if (cb.type === 'tool_use') blocks[evt.index] = { type: 'tool_use', id: cb.id, name: cb.name, _json: '' };
        else if (cb.type === 'thinking') blocks[evt.index] = { type: 'thinking', thinking: '', signature: '' };
        else if (cb.type === 'redacted_thinking') blocks[evt.index] = { type: 'redacted_thinking', data: cb.data || '' };
        else blocks[evt.index] = { type: 'text', text: '' };
        break;
      }
      case 'content_block_delta': {
        const b = blocks[evt.index];
        if (!b) break;
        const d = evt.delta || {};
        if (d.type === 'text_delta') { b.text += d.text; broadcast({ type: 'TRIAGE_DELTA', text: d.text }); }
        else if (d.type === 'thinking_delta') { b.thinking += d.thinking; broadcast({ type: 'TRIAGE_THINKING', text: d.thinking }); }
        else if (d.type === 'signature_delta') { b.signature += d.signature; }
        else if (d.type === 'input_json_delta') { b._json += d.partial_json; }
        break;
      }
      case 'content_block_stop': {
        const b = blocks[evt.index];
        if (b && b.type === 'tool_use') {
          try { b.input = JSON.parse(b._json || '{}'); } catch (_) { b.input = {}; }
          delete b._json;
        }
        break;
      }
      case 'message_delta':
        if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.usage) usage = evt.usage;
        break;
      case 'error':
        streamError = (evt.error && evt.error.message) || 'stream error';
        break;
    }
  });

  if (streamError) throw new Error(streamError);

  const content = blocks.filter(Boolean).map((b) => {
    if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
    if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking, signature: b.signature };
    if (b.type === 'redacted_thinking') return { type: 'redacted_thinking', data: b.data };
    return { type: 'text', text: b.text };
  });
  return { content, stopReason, usage };
}

// --- OpenAI-compatible agent loop (OpenAI, OpenRouter, local servers) ---

async function runOpenAIAgent(settings, initialPayload, all, ctx) {
  const base = (settings.llmBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const headers = {
    'content-type': 'application/json',
    'authorization': `Bearer ${settings.llmApiKey}`,
    // OpenRouter rankings (ignored by other servers).
    'HTTP-Referer': 'https://github.com/tavgar/DorkWay',
    'X-Title': 'DorkWay'
  };
  const messages = [
    { role: 'system', content: TRIAGE_SYSTEM },
    { role: 'user', content: initialPayload }
  ];
  const tools = openaiTools(ctx);
  let usage = null;

  for (let i = 0; i < TRIAGE_MAX_ITERS; i++) {
    const body = {
      model: settings.llmModel || 'gpt-4o',
      max_tokens: settings.llmMaxTokens || 16000,
      stream: true,
      tools,
      tool_choice: 'auto',
      messages
    };
    // OpenRouter-style reasoning; servers that don't support it ignore or 400 —
    // the user can disable thinking in LLM Settings for those.
    if (settings.llmThinking) body.reasoning = { effort: 'medium' };

    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: triageController.signal });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      broadcast({ type: 'TRIAGE_ERROR', error: `HTTP ${resp.status} ${resp.statusText}${text ? ' — ' + text.slice(0, 300) : ''}` });
      return;
    }

    const turn = await parseOpenAIStream(resp.body);
    usage = turn.usage || usage;
    if (turn.finishReason !== 'tool_calls' || !turn.toolCalls.length) { broadcast({ type: 'TRIAGE_DONE', usage }); return; }

    messages.push({
      role: 'assistant',
      content: turn.content || null,
      tool_calls: turn.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } }))
    });
    for (const tc of turn.toolCalls) {
      let input;
      try { input = JSON.parse(tc.args || '{}'); } catch (_) { input = {}; }
      broadcast({ type: 'TRIAGE_TOOL', name: tc.name, input });
      const out = await runTriageTool(tc.name, input, all, ctx);
      broadcast({ type: 'TRIAGE_TOOL_RESULT', ...toolResultMeta(tc.name, out) });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out) });
    }
  }
  broadcast({ type: 'TRIAGE_DONE', usage, note: 'stopped at iteration cap' });
}

// Accumulate one streamed OpenAI/OpenRouter completion, broadcasting content and
// reasoning deltas. Returns { content, toolCalls, finishReason, usage }.
async function parseOpenAIStream(stream) {
  let content = '';
  const toolCalls = [];
  let finishReason = null;
  let usage = null;

  await readSSE(stream, (evt) => {
    if (!evt) return;
    if (evt.usage) usage = evt.usage;
    const choice = evt.choices && evt.choices[0];
    if (!choice) return;
    const d = choice.delta || {};
    if (d.content) { content += d.content; broadcast({ type: 'TRIAGE_DELTA', text: d.content }); }
    if (d.reasoning) broadcast({ type: 'TRIAGE_THINKING', text: d.reasoning });
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', args: '' };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function && tc.function.name) toolCalls[idx].name += tc.function.name;
        if (tc.function && tc.function.arguments) toolCalls[idx].args += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  });

  return { content, toolCalls: toolCalls.filter(Boolean), finishReason, usage };
}
