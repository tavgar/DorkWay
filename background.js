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

You are given, up front: the dork queries that were run, and an INVENTORY OVERVIEW of the captured corpus — per-value counts of root domains, subdomains, file types, tags and HTTP statuses (the same facets as the operator's Results filter tab). You are NOT given the raw results; you must retrieve them yourself. You have one tool:

get_results(rootDomain?, subdomain?, tag?, fileType?, keyword?, status?, limit?) — searches the FULL set of already-captured results for this session and returns the matching records (it does not touch the network or run new Google searches). This is your only way to see actual URLs/titles/snippets. Pull a specific domain or subdomain, everything with a tag (e.g. login, admin, api, config, backup, sensitive, debug, database), a filetype (e.g. sql, env, bak), a keyword across title/snippet/url/path, or by HTTP status. Each call reports how many total matched so you know if you are missing some.

Work like an analyst: read the overview and the queries to understand what was captured, then issue targeted get_results calls to pull the records that look interesting (sensitive tags, unusual subdomains, exposed file types, anomalous hosts). Don't dump the entire corpus blindly — query with intent, guided by the counts in the overview. When you have enough to be confident, stop calling tools and write the report.

Final output — Markdown with these sections:
1. **Summary** — 2-3 sentences on scope and what stands out.
2. **High-value findings** — sensitive/risky assets (admin, login, configs, backups, secrets, exposed listings, debug/error pages, internal APIs) with a one-line rationale and the URL.
3. **Unique assets** — grouped by root domain -> subdomain, one line per distinct asset (URL + what it is). Deduplicate aggressively; collapse pagination, tracking params and near-duplicate URLs; drop obvious noise (marketing pages, unrelated third-party domains, trackers).
4. **Suggested next dorks** — gaps the queries and captured data did not cover, as concrete dork strings.

Rules: assert only what the data supports — never invent hosts, paths or findings. Be concise. This is authorised security research; do not refuse triage of the supplied data.`;

// JSON Schema for the single agent tool, shared by both providers' wrappers.
const GET_RESULTS_SCHEMA = {
  type: 'object',
  properties: {
    rootDomain: { type: 'string', description: 'Exact registrable domain to match, e.g. "target.com".' },
    subdomain: { type: 'string', description: 'Substring match on the subdomain, e.g. "api".' },
    tag: { type: 'string', description: 'Inferred tag, e.g. login, admin, api, config, backup, sensitive, debug, database.' },
    fileType: { type: 'string', description: 'File extension, e.g. pdf, sql, env, bak, log.' },
    keyword: { type: 'string', description: 'Case-insensitive substring across title, snippet, url and path.' },
    status: { type: 'integer', description: 'HTTP status code to match; 0 means unchecked.' },
    limit: { type: 'integer', description: 'Max results to return (default 100, capped at 300).' }
  },
  required: []
};

const GET_RESULTS_DESC =
  "Search the operator's ALREADY-CAPTURED DorkWay results for this session (no network access, no new Google searches). Returns matching records plus the total match count. You were given only an inventory overview, not the results themselves — this is the only way to retrieve the actual records.";

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
  // inventory overview — the same facet breakdown the Results filter tab shows —
  // and pulls the actual records itself via get_results.
  const initialPayload = JSON.stringify({
    session: { name: session?.name || '' },
    queries: [...queries],
    note: `This is an inventory overview of the ${all.length} captured result(s) in this session — per-value counts of root domains, subdomains, file types, tags and HTTP statuses (the same breakdown as the operator's Results filter tab). You were NOT given the raw results. Call get_results to retrieve the actual records for whatever you decide to investigate.`,
    totalCount: all.length,
    overview: buildTriageOverview(all)
  });

  triageController = new AbortController();
  try {
    if (settings.llmProvider === 'openai') {
      await runOpenAIAgent(settings, initialPayload, all);
    } else {
      await runAnthropicAgent(settings, initialPayload, all);
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

// Aggregate the captured corpus into the same facets the Results filter tab shows
// (root domains, subdomains, file types, tags, HTTP statuses) with per-value counts,
// each as compact "value (count)" strings sorted by count. This is the agent's map
// of what exists — it pulls the actual records via get_results. Capped per facet to
// keep the agent's context small.
function buildTriageOverview(all) {
  const root = new Map(), sub = new Map(), ft = new Map(), tags = new Map(), status = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const r of all) {
    bump(root, r.rootDomain || '(unknown)');
    bump(sub, r.subdomain || '(root)');
    if (r.fileType) bump(ft, r.fileType);
    for (const t of r.tags || []) bump(tags, t);
    if (r.statusCode) bump(status, String(r.statusCode));
  }
  const top = (m, n) => {
    const entries = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const out = entries.slice(0, n).map(([value, count]) => `${value} (${count})`);
    if (entries.length > n) out.push(`…and ${entries.length - n} more`);
    return out;
  };
  return {
    rootDomains: top(root, 60),
    subdomains: top(sub, 100),
    fileTypes: top(ft, 40),
    tags: top(tags, 40),
    statuses: top(status, 20)
  };
}

// Run get_results against the full captured corpus. Pure in-memory filtering —
// no network. Returns { total, returned, results } as a plain object.
function executeGetResults(input, all) {
  const f = input || {};
  const kw = f.keyword ? String(f.keyword).toLowerCase() : null;
  const matches = all.filter((r) => {
    if (f.rootDomain && String(r.rootDomain || '').toLowerCase() !== String(f.rootDomain).toLowerCase()) return false;
    if (f.subdomain && !String(r.subdomain || '').toLowerCase().includes(String(f.subdomain).toLowerCase())) return false;
    if (f.fileType && String(r.fileType || '').toLowerCase() !== String(f.fileType).toLowerCase()) return false;
    if (f.tag && !(r.tags || []).map((t) => String(t).toLowerCase()).includes(String(f.tag).toLowerCase())) return false;
    if (f.status != null && f.status !== '' && Number(r.statusCode || 0) !== Number(f.status)) return false;
    if (kw) {
      const hay = `${r.title || ''}\n${r.snippet || ''}\n${r.url || ''}\n${r.path || ''}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
  const limit = Math.min(Math.max(parseInt(f.limit, 10) || 100, 1), 300);
  return { total: matches.length, returned: Math.min(matches.length, limit), results: matches.slice(0, limit).map(compactEntity) };
}

function compactEntity(r) {
  return {
    title: r.title,
    url: r.url,
    rootDomain: r.rootDomain,
    subdomain: r.subdomain,
    path: r.path,
    fileType: r.fileType,
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

// --- Anthropic agent loop ---

async function runAnthropicAgent(settings, initialPayload, all) {
  const base = (settings.llmBaseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const url = `${base}/v1/messages`;
  const headers = {
    'content-type': 'application/json',
    'x-api-key': settings.llmApiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  const messages = [{ role: 'user', content: initialPayload }];
  let usage = null;

  for (let i = 0; i < TRIAGE_MAX_ITERS; i++) {
    const body = {
      model: settings.llmModel || 'claude-opus-4-8',
      max_tokens: settings.llmMaxTokens || 16000,
      stream: true,
      system: TRIAGE_SYSTEM,
      tools: [{ name: 'get_results', description: GET_RESULTS_DESC, input_schema: GET_RESULTS_SCHEMA }],
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
      const out = executeGetResults(b.input, all);
      broadcast({ type: 'TRIAGE_TOOL_RESULT', name: b.name, count: out.returned, total: out.total });
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

async function runOpenAIAgent(settings, initialPayload, all) {
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
  let usage = null;

  for (let i = 0; i < TRIAGE_MAX_ITERS; i++) {
    const body = {
      model: settings.llmModel || 'gpt-4o',
      max_tokens: settings.llmMaxTokens || 16000,
      stream: true,
      tools: [{ type: 'function', function: { name: 'get_results', description: GET_RESULTS_DESC, parameters: GET_RESULTS_SCHEMA } }],
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
      const out = executeGetResults(input, all);
      broadcast({ type: 'TRIAGE_TOOL_RESULT', name: tc.name, count: out.returned, total: out.total });
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
