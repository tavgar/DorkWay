# DorkWay

A Chrome extension that assists security researchers and OSINT
analysts during Google dorking sessions. DorkWay activates on Google Search results pages,
extracts every result as a structured entity, organises them by domain hierarchy, auto-tags
them, and provides live filtering, export, and webhook push — all from a persistent side panel.

> ⚖️ **Authorised use only.** DorkWay is for security research and OSINT against assets you own
> or are explicitly permitted to test. You are responsible for complying with all applicable
> laws, scope agreements, and Google's Terms of Service. The optional status-code check sends
> outbound HTTP requests directly to target domains.

---

## Contents

```
DorkWay/                  # The Chrome MV3 extension (no build step)
├── manifest.json
├── background.js         # service worker: store, pagination, status, push
├── content.js            # SERP extraction + pagination driver
├── lib/                  # shared ES modules
│   ├── url-clean.js       # URL cleaning, tracking-param strip, SHA-256
│   ├── domain.js          # registrable-domain / subdomain (PSL subset)
│   ├── tags.js            # auto-tag engine
│   ├── extractor.js       # single-pass DOM -> ResultEntity
│   └── db.js              # IndexedDB wrapper (DorkWayDB)
├── sidepanel/            # the side-panel UI (vanilla JS/HTML/CSS)
├── icons/
└── README.md
```

---

## 1. Install the extension

No build step is required — it runs as-is.

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** and select the project folder (the one containing `manifest.json`)
4. Pin DorkWay and click its toolbar icon (or use the action) to open the side panel
5. Accept the first-run authorisation notice

Requires Chrome 114+ (for `chrome.sidePanel`).

### Using it

You can directly use **Build** tab inside the extension to build your dorks and run it.

Alternatively:
1. Run any search on `https://www.google.com/search?q=...`. DorkWay captures the page
   automatically; an on-page pill shows progress.
2. Open the side panel to see results grouped by **root domain → subdomain**, with auto-tags,
   filters, and per-result status dots.
3. Use the **Build** tab to compose dorks (`site:`, `inurl:`, `intitle:`, `filetype:`,
   `after:`/`before:`, free terms) and open them directly.
4. Use **Export** for JSON / CSV / Markdown, or push to your webhook.

### Coverage beyond Google's ~300-result cap

- **Auto-paginate (all pages)** — *Build → Auto-paginate current tab*, and the auto-paginate
  option on *Open search & capture*, walk `&start=0,10,20…` with `&filter=0` and jittered
  1.5–4 s delays (configurable). They **walk every page until Google runs out**, ignoring both
  Google's reported page count and its "omitted entries" notice — both are unreliable, since more
  pages keep appearing as you go forward. Pagination stops only on a genuinely empty results page
  or a CAPTCHA. A hard safety ceiling of 100 pages guards against runaway loops.
- **CAPTCHA / cap detection** — if Google shows a CAPTCHA or the "omitted some entries" notice,
  pagination halts, state is saved, and you get a resume/slice prompt.
- **Query slicing** — *Build → Suggest query splits* proposes **subdomain-walk**,
  **filetype**, and **date-bisection** slices, each staying under the cap. Their union (deduped
  by URL hash) is your working dataset; every result keeps its `sourceQuery`.

---

## 2. The `ResultEntity` model

Every result is captured fully (never the URL alone):

| Field | Meaning |
|---|---|
| `id` | SHA-256 of the cleaned URL — the dedup key |
| `title` | Clickable headline text |
| `url` | Full href, tracking params (`utm_*`, `fbclid`, `gclid`, …) stripped |
| `rootDomain` | Registrable domain, e.g. `target.co.uk` |
| `subdomain` | Everything left of root excluding `www`, e.g. `api.dev` |
| `path` | URL path, e.g. `/backup/db.sql` |
| `fileType` | Extension derived from path, e.g. `sql` |
| `queryParams` | Remaining query string after cleaning |
| `snippet` | Descriptive text under the title |
| `tags[]` | Auto-assigned (see below) |
| `sourceQuery` | The exact dork(s) that produced this result |
| `rank` | 1-based SERP position, global across pages |
| `page` | Which results page it came from |
| `statusCode` | HTTP status (0 = unchecked) |
| `capturedAt` | ISO 8601 timestamp |

Extraction is **single-pass**: title, URL, and snippet are read from the same result
container (located by stable `data-hveid`/`h3` structure, with a fallback selector chain), so
they always belong to the same result.

### Auto-tags

`login`, `admin`, `api`, `upload`, `backup`, `config`, `exposed-file`, `git`, `sensitive`,
`file` — assigned from the path/query on extraction (see `lib/tags.js`).

### Storage

IndexedDB (`DorkWayDB`) with `sessions` and `results` stores. On write, a duplicate `id`
merges `tags` and `sourceQuery` and keeps the best rank / non-zero status rather than
overwriting. Sessions persist across navigations and are exportable at any time.

---

## 3. Webhook push (optional)

If you want to ship results out to your own endpoint, set a **Webhook URL** (and optional
**Webhook secret**) in **Settings**, then **Export → Push filtered results**.

`POST <webhookUrl>` with header `X-DorkWay-Secret: <shared secret>` (omitted if no secret set),
body:

```jsonc
{
  "session": { "sessionId": "s_…", "name": "Recon" },
  "batch": 1,            // 1-based chunk index
  "batches": 3,          // total chunks
  "results": [ /* array of ResultEntity, ≤100 per request */ ]
}
```

DorkWay chunks results into groups of 100, sends each with the secret header, and retries
failed chunks up to 3× with exponential backoff (0.5 s, 1 s, 2 s). Your endpoint should ack a
batch with `200 {ok:true}`.

---

## 4. Settings reference

| Setting | Default | Notes |
|---|---|---|
| Webhook URL / secret | — | Sent as `X-DorkWay-Secret` |
| Status-code checks | off | Opt-in; HEAD probes to targets, 2 concurrent. Requests broad host permission on first run |
| Max pages per slice | 10 | ~100 results per query slice |
| Min/Max delay | 1500 / 4000 ms | Jittered between pages |
| Append `&filter=0` | on | Surfaces Google's omitted results |

---

## 5. Notes, limitations & guardrails

- **Google DOM churn** — selectors target stable structure (`data-hveid`, `a > h3`) with a
  fallback chain; if a result can't be parsed it's skipped with a console warning rather than
  crashing. Zero-result, "did you mean", and knowledge-panel pages are handled without throwing.
- **Domain parsing** — `lib/domain.js` ships a curated Public Suffix List subset (covers
  `co.uk`, `com.au`, `github.io`, S3/Heroku/Vercel, etc.). For exhaustive coverage, swap in the
  [`tldts`](https://www.npmjs.com/package/tldts) package and bundle its dist; `parseHost()` is the
  single seam to replace.
- **Rate limiting** — delays are randomised, not fixed, and capped by max-pages. Solve CAPTCHAs
  manually; DorkWay never hammers through them.
- **Privacy** — status-code checks are off by default and clearly generate outbound traffic to
  targets. Use only within scope.
- **No build step** — the extension is plain ES modules; `lib/*.js` are exposed via
  `web_accessible_resources` and dynamically imported by the content script.
