// content.js — runs on Google SERP pages. Extracts results in a single pass, reports
// them to the service worker, and (when an auto-pagination job is active) drives the
// tab to the next page with jittered delays. State lives in the service worker /
// chrome.storage because each navigation re-injects this script fresh.

(async () => {
  if (window.top !== window) return; // ignore iframes

  // Dynamically import the shared ES modules (declared in web_accessible_resources).
  let extractor;
  try {
    extractor = await import(chrome.runtime.getURL('lib/extractor.js'));
  } catch (err) {
    console.warn('[DorkWay] could not load extractor module:', err);
    return;
  }

  const params = new URLSearchParams(location.search);
  const query = params.get('q') || '';
  if (!query) return;
  const start = parseInt(params.get('start') || '0', 10) || 0;
  const page = Math.floor(start / 10) + 1;
  const startRank = start + 1;

  const state = extractor.detectSerpState(document);

  // --- on-page status pill ---------------------------------------------------
  const pill = createPill();
  if (state.captcha) {
    setPill(pill, '⚠ CAPTCHA — auto-capture paused', 'warn');
  } else if (state.noResults) {
    setPill(pill, 'No results for this query', 'muted');
  } else {
    setPill(pill, 'Capturing…', 'busy');
  }

  let entities = [];
  if (state.hasResults && !state.captcha) {
    try {
      entities = await extractor.extractResults(document, { sourceQuery: query, page, startRank });
    } catch (err) {
      console.warn('[DorkWay] extraction failed:', err);
    }
  }

  // Report to the service worker and receive the next action.
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({
      type: 'CAPTURE_PAGE',
      payload: {
        query,
        start,
        page,
        url: location.href,
        state,
        entities
      }
    });
  } catch (err) {
    console.warn('[DorkWay] could not reach service worker:', err);
    setPill(pill, `${entities.length} captured (offline)`, 'muted');
    return;
  }

  resp = resp || { action: 'stop' };

  if (resp.action === 'captcha') {
    renderCaptchaBanner(pill);
    return;
  }

  if (resp.action === 'navigate' && resp.url) {
    const delay = resp.delayMs || 2500;
    setPill(pill, `${entities.length} captured · next page in ${Math.round(delay / 1000)}s`, 'busy');
    const navTimer = setTimeout(() => {
      location.href = resp.url;
    }, delay);
    addPauseButton(pill, navTimer);
    // During an auto-split run there's a queue of queries, so offer to skip the
    // rest of this one and jump to the next.
    if (resp.autoSplit) addSkipButton(pill, navTimer, resp.remaining);
    return;
  }

  // stop
  const total = resp.sessionTotal != null ? resp.sessionTotal : entities.length;
  const note = resp.reason ? ` (${resp.reason})` : '';
  setPill(pill, `Done · ${total} in session${note}`, 'done');
  setTimeout(() => fadePill(pill), 6000);
})();

// Once an extension reload/update orphans this page's content script,
// chrome.runtime.sendMessage throws "Extension context invalidated" *synchronously*
// — a trailing .catch() can't see that, so it surfaces as an uncaught rejection.
// Guard every fire-and-forget message so a stale tab fails silently instead.
async function safeSend(message) {
  try {
    if (!chrome.runtime?.id) return null; // context already gone
    return await chrome.runtime.sendMessage(message);
  } catch (_) {
    return null;
  }
}

// ---- on-page pill helpers -----------------------------------------------------

function createPill() {
  const el = document.createElement('div');
  el.id = 'dorkway-pill';
  el.style.cssText = [
    'position:fixed', 'z-index:2147483647', 'bottom:16px', 'right:16px',
    'font:12px/1.4 system-ui,sans-serif', 'padding:9px 14px', 'border-radius:999px',
    'box-shadow:0 8px 24px -6px rgba(0,0,0,.5)', 'color:#fff', 'background:#0e131e',
    'border:1px solid rgba(255,255,255,.12)', 'backdrop-filter:blur(8px)',
    'display:flex', 'align-items:center', 'gap:8px', 'cursor:pointer',
    'transition:opacity .4s'
  ].join(';');
  el.title = 'DorkWay — click to open the side panel from the toolbar icon';
  el.addEventListener('click', () => {
    safeSend({ type: 'OPEN_PANEL' });
  });
  (document.body || document.documentElement).appendChild(el);
  return el;
}

function setPill(el, text, kind) {
  const colors = { busy: '#4f46e5', warn: '#b45309', done: '#059669', muted: '#1f2937' };
  el.style.background = colors[kind] || '#0e131e';
  el.innerHTML = `<span style="font-weight:700;letter-spacing:-.01em">DorkWay</span><span style="opacity:.92">${escapeHtml(text)}</span>`;
}

function fadePill(el) {
  el.style.opacity = '0';
  setTimeout(() => el.remove(), 600);
}

function pillButton(text) {
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.style.cssText =
    'margin-left:6px;border:0;border-radius:6px;padding:2px 8px;cursor:pointer;background:#fff;color:#111;font-weight:600';
  return btn;
}

function addPauseButton(pill, navTimer) {
  const btn = pillButton('Pause ⏸');
  btn.title = 'Pause auto-pagination — Resume to continue from here';
  btn.addEventListener('click', async (e) => {
    e.stopPropagation(); // don't trigger the pill's open-panel click
    if (navTimer) clearTimeout(navTimer); // cancel the pending next-page hop
    await safeSend({ type: 'PAUSE_PAGINATION' });
    setPill(pill, 'Paused', 'muted'); // wipes the pill, so re-add Resume after
    addResumeButton(pill);
  });
  pill.appendChild(btn);
}

function addResumeButton(pill) {
  const btn = pillButton('Resume ▶');
  btn.title = 'Resume auto-pagination from this page';
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    btn.disabled = true;
    setPill(pill, 'Resuming…', 'busy');
    // The service worker reloads this tab to re-enter the walk loop.
    await safeSend({ type: 'RESUME_PAGINATION' });
  });
  pill.appendChild(btn);
}

function addSkipButton(pill, navTimer, remaining) {
  const btn = pillButton('Skip query ⏭');
  btn.title = remaining
    ? `Abandon the rest of this query and move to the next (${remaining} queued)`
    : 'Abandon the rest of this query and move to the next';
  btn.addEventListener('click', async (e) => {
    e.stopPropagation(); // don't trigger the pill's open-panel click
    if (navTimer) clearTimeout(navTimer); // cancel the pending next-page hop
    btn.disabled = true;
    setPill(pill, 'Skipping to next query…', 'busy');
    const r = await safeSend({ type: 'SKIP_QUERY' });
    // If there was a next query, the service worker navigates this tab to it. If
    // not, it stops the run and we stay put — reflect that here.
    if (r && r.stopped) setPill(pill, 'Done · no more queued queries', 'done');
  });
  pill.appendChild(btn);
}

function renderCaptchaBanner(pill) {
  setPill(pill, '⚠ CAPTCHA detected — solve it, then click Resume', 'warn');
  const btn = pillButton('Resume');
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    btn.disabled = true;
    // The service worker reloads this tab to re-enter the walk loop.
    await safeSend({ type: 'RESUME_PAGINATION' });
  });
  pill.appendChild(btn);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
