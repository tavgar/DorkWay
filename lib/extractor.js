// extractor.js — turn a Google SERP DOM into fully-populated ResultEntity objects.
//
// Design rules (from the spec):
//  * One traversal per result: title, url and snippet are read from the SAME container,
//    so they can never belong to different results.
//  * Target containers by stable structure (data-* attributes, h3 landmarks), never by
//    Google's churn-prone class names. A fallback selector chain keeps us degrading
//    gracefully instead of crashing when Google reshuffles the DOM.

import { cleanUrl, sha256Hex } from './url-clean.js';
import { parseHost } from './domain.js';
import { assignTags } from './tags.js';

// Snippet selectors tried in order. The first two are structural and durable; the
// trailing class names are last-resort hints that may rot — hence the fallback to a
// computed text block.
const SNIPPET_SELECTORS = [
  'div[data-sncf]',
  'div[style*="-webkit-line-clamp"]',
  'div[data-content-feature] span',
  '.VwiC3b',
  '.yXK7lf',
  '.lEBKkf'
];

// Containers we never want to scrape: ads, "people also ask", related searches, images.
function isInExcludedRegion(el) {
  return Boolean(
    el.closest(
      '#tads, #bottomads, [aria-label="Ads"], [data-text-ad], ' +
        '[jsname="Cpkphb"], [role="complementary"], g-section-with-header, ' +
        '#botstuff [role="heading"], .related-question-pair, [data-initq], ' +
        '#appbar, #searchform form'
    )
  );
}

function findContainer(anchor) {
  // Preferred: the organic-result wrapper carries a data-hveid attribute.
  return (
    anchor.closest('div[data-hveid][data-ved]') ||
    anchor.closest('div[data-hveid]') ||
    anchor.closest('div.g') ||
    anchor.closest('div.MjjYud') ||
    anchor.closest('div[jscontroller]') ||
    anchor.parentElement
  );
}

function extractSnippet(container, titleEl, displayUrl) {
  for (const sel of SNIPPET_SELECTORS) {
    const node = container.querySelector(sel);
    if (node) {
      const text = node.textContent.trim();
      if (text && text.length > 2) return collapse(text);
    }
  }
  // Fallback: the longest text block in the container that isn't the title or URL line.
  let best = '';
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
  let el = walker.currentNode;
  while (el) {
    if (el !== titleEl && !el.querySelector('h3') && el.tagName !== 'A' && el.tagName !== 'CITE') {
      const t = collapse(el.textContent || '');
      if (t.length > best.length && t !== displayUrl && !t.startsWith('http')) {
        // Prefer leaf-ish blocks: avoid the whole container's concatenated text.
        if (el.children.length <= 4) best = t;
      }
    }
    el = walker.nextNode();
  }
  return best;
}

function collapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Extract results from the current document.
 * @param {Document} doc
 * @param {object} ctx { sourceQuery, page, startRank, sessionId }
 * @returns {Promise<ResultEntity[]>}
 */
export async function extractResults(doc, ctx) {
  const { sourceQuery = '', page = 1, startRank = 1, sessionId = '' } = ctx || {};
  const root = doc.querySelector('#search') || doc.querySelector('#rso') || doc.body;
  if (!root) return [];

  // Title anchors: an <a href> that wraps an <h3>. Robust across Google revisions.
  const titleAnchors = [...root.querySelectorAll('a h3')]
    .map((h3) => ({ h3, anchor: h3.closest('a[href]') }))
    .filter((x) => x.anchor);

  const seenInPass = new Set();
  const entities = [];
  let rank = startRank;

  for (const { h3, anchor } of titleAnchors) {
    try {
      if (isInExcludedRegion(anchor)) continue;

      const title = collapse(h3.textContent || '');
      if (!title) continue;

      const cleaned = cleanUrl(anchor.getAttribute('href') || anchor.href, doc.baseURI);
      if (!cleaned) continue;

      let host;
      try {
        host = new URL(cleaned.url).hostname;
      } catch (_) {
        continue;
      }
      // SERP-internal links (search?, /preferences, …) never wrap an <h3>, so scoping to
      // `a > h3` already excludes Google's own chrome — no extra host filtering needed.

      const container = findContainer(anchor);
      if (!container) continue;

      const displayUrl = (container.querySelector('cite')?.textContent || '').trim();
      const snippet = extractSnippet(container, h3, displayUrl);

      const { rootDomain, subdomain } = parseHost(host);
      const id = await sha256Hex(cleaned.url);

      if (seenInPass.has(id)) continue;
      seenInPass.add(id);

      const tags = assignTags(cleaned.path, cleaned.queryParams, cleaned.fileType);

      entities.push({
        id,
        sessionId,
        title,
        url: cleaned.url,
        rootDomain,
        subdomain,
        path: cleaned.path,
        fileType: cleaned.fileType,
        queryParams: cleaned.queryParams,
        snippet,
        tags,
        sourceQuery,
        rank: rank++,
        page,
        statusCode: 0,
        capturedAt: new Date().toISOString()
      });
    } catch (err) {
      // Degrade gracefully: skip the offending result, keep going.
      console.warn('[DorkWay] skipped a result during extraction:', err);
    }
  }

  return entities;
}

// ---- SERP state detection (cap / CAPTCHA / no-results) ------------------------

export function detectSerpState(doc) {
  const bodyText = (doc.body?.innerText || '').toLowerCase();

  // CAPTCHA / "unusual traffic" interstitial.
  const captcha =
    Boolean(doc.querySelector('form#captcha-form, #recaptcha, iframe[src*="recaptcha"]')) ||
    /our systems have detected unusual traffic|before you continue|i'm not a robot/i.test(bodyText);

  // Google's "omitted some entries / very similar" cap notice.
  const omitted =
    /omitted some entries|in order to show you the most relevant results|very similar to the/i.test(
      doc.body?.innerText || ''
    );

  const noResults =
    /did not match any documents|no results found|your search .* did not match/i.test(
      doc.body?.innerText || ''
    );

  // Approx. total Google claims it has, parsed from "About 12,300 results".
  let claimedTotal = null;
  const stats = doc.querySelector('#result-stats');
  if (stats) {
    const m = stats.textContent.replace(/[,. ]/g, '').match(/(\d{2,})/);
    if (m) claimedTotal = parseInt(m[1], 10);
  }

  const hasResults = Boolean((doc.querySelector('#search') || doc).querySelector('a h3'));

  return { captcha, omitted, noResults, claimedTotal, hasResults };
}
