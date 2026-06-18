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
  firstRunDone: false
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
