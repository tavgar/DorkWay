---
name: ai-triage
description: Work on DorkWay's AI Triage feature — the side-panel tab that runs an agentic LLM (Anthropic or OpenAI-compatible/OpenRouter) over captured Google-dork results and streams back prioritised findings of the most important assets to investigate. Use when adding, debugging, testing, or extending triage: the LLM Settings modal, providers/models, the recon system prompt, the agentic tool-use loop, the get_results/get_stats/run_dork/check_status tools, thinking/reasoning, prompt caching, the SSE streaming path, or the result payload.
---

# DorkWay — AI Triage (agentic)

The **AI Triage** tab runs an **agent**: it hands the LLM an *inventory overview*
of the captured corpus — a per-root-domain **correlation map** (`byRootDomain`:
count, distinct subdomains, top tags, file types) plus flat per-facet legends and a
status-enrichment flag — plus the dork queries, **no raw results**, to keep its
context small. The model then investigates on its own via four tools:
**`get_stats`** (cheap count aggregation grouped by a facet, optionally filtered),
**`get_results`** (records, with multi-value/OR filters, sort, count-only),
**`run_dork`** (runs NEW Google dork queries through the operator's capture engine
and blocks until capture finishes — the agent collects, not just reads), and —
only when authorised — **`check_status`** (live HTTP probe of captured URLs). It
finally streams back **prioritised findings** — the *most important assets to
investigate*, ranked, each with a rationale and next step — as **Markdown**
(rendered in-panel). `get_stats`/`get_results` are read-only; `run_dork` is the live
**collection** tool (real Google traffic, disclaimer-gated like manual dorking) and
`check_status` the live **liveness-probe** tool (gated, see below). Provider
is configurable: **Anthropic** (`/v1/messages`) or **OpenAI-compatible**
(`/chat/completions`, which covers OpenRouter and local servers via base URL).
Thinking/reasoning is enabled for models that support it (toggle in LLM Settings).
On Anthropic the static `system`+`tools` and the growing message prefix are
**prompt-cached** across the up-to-`TRIAGE_MAX_ITERS` (12) loop iterations. The tab
has two sub-views: **Run** (live) and **History** (past reports).

This project is **vanilla ES-module JS, MV3, no build step**. All network flows
through the background service worker; the side panel talks to it via
`chrome.runtime.sendMessage`. Match those patterns — don't add a bundler,
framework, or dependency.

## Where the code lives

| Concern | File · symbol |
|---|---|
| Tab nav + `#tab-triage` (`.subtabs` Run/History, `#triage-run-view`, `#triage-history-view`) + `#llm-settings` modal (incl. `#llm-thinking`) | [sidepanel/panel.html](../../../sidepanel/panel.html) (`data-tab="triage"`) |
| `.triage-output`, `.triage-answer/.triage-think/.triage-tool` blocks, `.triage-answer` Markdown element styles, `.subtabs`, `.triage-history-item` | [sidepanel/panel.css](../../../sidepanel/panel.css) |
| Triage UI wiring, settings modal, streamed block render, Markdown render, history | [sidepanel/panel.js](../../../sidepanel/panel.js) — `wireTriage`, `applyLlmSettingsToForm`, `updateTriageMeta`, `runTriage`, `resetTriageOutput`, `appendTriage`, `addTriageNote`, `triageToolArgs`, `triageToolResultNote` (tool-aware), `setTriageRunning/Status`, `renderMarkdown`/`renderInline` (XSS-safe, DOM-only), `showTriageSubtab`, `loadTriageHistory`/`saveTriageRun`/`renderTriageHistory`/`showTriageHistoryDetail`/`historySnippet`, `triageReportMd`; runtime cases `TRIAGE_THINKING/DELTA/TOOL/TOOL_RESULT/NOTE/DONE/ERROR` |
| Settings keys, router, agent loops, tools, SSE parsers, system prompt | [background.js](../../../background.js) — `DEFAULT_SETTINGS` (`llmProvider/llmBaseUrl/llmApiKey/llmModel/llmMaxTokens/llmThinking`), `case 'RUN_TRIAGE'`/`'STOP_TRIAGE'`, `onRunTriage` (builds `ctx={sessionId,allowCheckStatus}`), `buildTriageOverview`, `runAnthropicAgent`, `runOpenAIAgent`, `anthropicTools`/`openaiTools`/`runTriageTool`/`toolResultMeta`/`setMessagesCacheBreakpoint`, `parseAnthropicStream`, `parseOpenAIStream`, `readSSE`, `matchesFilter`/`toList`/`toStatusList`, `executeGetResults`/`executeGetStats`/`executeCheckStatus`, `executeRunDork`/`waitForPaginationIdle`/`startKeepAlive` (live capture; reuses `onAutoSplit`), `agentDorking` flag (routes CAPTCHA → `TRIAGE_NOTE` in `onCapturePage`), `compactEntity`, `TRIAGE_SYSTEM`, `GET_RESULTS_SCHEMA`/`GET_STATS_SCHEMA`/`RUN_DORK_SCHEMA`/`CHECK_STATUS_SCHEMA` (+`*_DESC`), `CHECK_STATUS_MAX`, `RUN_DORK_MAX`/`RUN_DORK_TIMEOUT_MS`, `TRIAGE_MAX_ITERS`, `triageController` |
| Provider host permissions | [manifest.json](../../../manifest.json) `host_permissions` (anthropic / openai / openrouter); custom hosts use `optional_host_permissions` at runtime |

## Data flow (agentic loop)

1. **panel.js `runTriage()`** — guards (results + API key), requests host
   permission for a custom base-URL origin from the click gesture, then
   `resetTriageOutput()` and `msg({ type:'RUN_TRIAGE' })`. **No results are sent** —
   the background builds the overview from the full corpus.
2. **background.js `onRunTriage(msg)`** — loads settings, the active session, and
   the **full** captured set via `getResults(sessionId)` (the agent's tool corpus).
   Unions `session.queries` with every result's `sourceQuery`. Builds the initial
   user payload `{ session, queries, note, totalCount, overview }` where `overview =
   buildTriageOverview(all)` — a per-root-domain map (`byRootDomain`) plus flat facet
   legends + a `statusEnriched` flag, capped per facet/per-root. Computes
   `ctx={sessionId, allowCheckStatus}` (the check_status gate = `statusCheckEnabled`
   AND `*://*/*` already granted). Dispatches to `runAnthropicAgent` /
   `runOpenAIAgent` under the module-level `triageController` (aborted by `STOP_TRIAGE`).
3. **Agent loop** (`runAnthropicAgent` / `runOpenAIAgent`) — up to `TRIAGE_MAX_ITERS`
   (12) rounds: stream a turn → if the model called a tool, route via
   `runTriageTool(name,input,all,ctx)` to `executeGetStats` / `executeGetResults`
   (pure in-memory, capped at 300) / `executeRunDork` (live capture — see below) /
   `executeCheckStatus` (gated outbound probe), append the tool result, loop; else
   `TRIAGE_DONE`. Tool defs come from `anthropicTools(ctx)`/`openaiTools(ctx)`
   (run_dork always; check_status only when allowed). On Anthropic, `system` is a
   cached text block and `setMessagesCacheBreakpoint` marks the latest user
   tool_result so the whole prefix is cached each round. The streamed `fetch`es keep
   the MV3 worker alive during turns; `startKeepAlive` covers the quiet `run_dork`
   wait (esp. a CAPTCHA pause). `executeRunDork` reuses `onAutoSplit` to drive a real
   capture, `waitForPaginationIdle` blocks until the job goes inactive (waiting
   through CAPTCHA, honouring `STOP_TRIAGE`), then refreshes the shared `all` array
   in place so the next get_stats/get_results sees the new records.
4. **Stream parsers** (`parseAnthropicStream` / `parseOpenAIStream`, both via
   `readSSE`) accumulate one assistant turn and `broadcast()` deltas live:
   `TRIAGE_THINKING {text}` (thinking/reasoning), `TRIAGE_DELTA {text}` (answer),
   `TRIAGE_TOOL {name,input}` and `TRIAGE_TOOL_RESULT {name,…}` (tool-aware via
   `toolResultMeta`) per tool call.
   Anthropic returns content blocks (text/thinking/tool_use) + `stop_reason`;
   thinking blocks are echoed back **with their `signature`** on the next turn.
   OpenAI accumulates `delta.content` / `delta.reasoning` / streamed `tool_calls`
   and stops on `finish_reason`.
5. **panel.js runtime listener** renders into `#triage-output` as typed blocks
   (`appendTriage('answer'|'think', text)`, `addTriageNote(...)`); `answer` blocks
   accumulate raw Markdown (`triageReportMd`) and re-render via `renderMarkdown`
   (DOM-only, XSS-safe) on each delta. Toggles Run/Stop, shows status. On
   `TRIAGE_DONE` (not aborted) it calls `saveTriageRun(usage)` → an entry in
   `chrome.storage.local.triageHistory` (newest-first, capped at 30), browsable in
   the **History** sub-view (`renderTriageHistory` → `showTriageHistoryDetail`).

## Conventions & gotchas

- **Never `innerHTML` — build DOM with `createElement` + `textContent`.** Model
  output is untrusted and the extension runs under strict MV3 CSP. The answer is
  Markdown, rendered by the in-house `renderMarkdown`/`renderInline` (headings,
  lists, GFM pipe tables, fenced code blocks, blockquotes, bold/italic, code,
  `http(s)`/`mailto` links — other link schemes degrade to plain text; tables use
  the `splitTableRow`/`isTableDivider` helpers). If you extend the Markdown support,
  keep it node-based; do not introduce a library or `innerHTML`. Thinking/tool
  blocks stay plain `textContent`.
- **New provider host?** Add it to `host_permissions` in the manifest, or rely on
  the runtime `chrome.permissions.request({origins})` gesture already wired for
  custom base URLs (mirrors the status-check flow in `wireSettings`).
- **MV3 keepalive**: the in-flight streamed `fetch`es keep the service worker
  alive for the whole loop; don't refactor `onRunTriage` to resolve before the
  agent finishes, and keep `triageController.signal` on every `fetch`.
- **One run at a time** via `triageController`; `STOP_TRIAGE` aborts it (surfaces
  as `AbortError` → `TRIAGE_DONE {aborted:true}`).
- **Anthropic thinking + tools**: `thinking:{type:'adaptive',display:'summarized'}`
  + `output_config:{effort:'medium'}` (only when `llmThinking`). Thinking blocks
  **must** be replayed unchanged with their `signature` on the next turn —
  `parseAnthropicStream` captures `signature_delta`; don't drop it. Confirm any new
  Anthropic model supports `effort` (older models 400). For accurate Anthropic API
  shapes / model IDs / params, consult the `claude-api` skill rather than guessing.
- **OpenAI-compatible thinking**: sends `reasoning:{effort:'medium'}` (OpenRouter
  style) when `llmThinking`; endpoints that reject it → user disables the toggle.
  Reasoning text streams as `delta.reasoning`.
- **Tool surface** — `get_stats` and `get_results` are read-only over
  already-captured data (no network). Two outbound tools:
  - **`run_dork`** (live collection) is **always registered** — it only hits Google
    search, the app's core authorised function, already covered by the first-run
    disclaimer (no extra gate/toggle). `executeRunDork` reuses `onAutoSplit`
    (allPages mode, so a cap-hit advances the queue instead of stopping the batch),
    caps queries at `RUN_DORK_MAX` (5), and **blocks** via `waitForPaginationIdle`
    until the pagination job goes inactive. It mutates the shared `all` array in
    place afterward (don't reassign — the agent loop holds the reference). A CAPTCHA
    pause keeps the job active+paused, so the wait continues through it; the
    operator solves it in the search tab and clicks **Resume** (Build tab). The
    `agentDorking` flag makes `onCapturePage` emit a `TRIAGE_NOTE` so the CAPTCHA
    shows on the Triage tab too. `RUN_DORK_TIMEOUT_MS` (15 min) and
    `triageController` abort both stop the job and end the wait.
  - **`check_status`** (liveness probe of *arbitrary captured hosts* — more
    sensitive) is registered **only** when `ctx.allowCheckStatus` is true
    (`statusCheckEnabled` AND `*://*/*` already granted; the agent can't request the
    permission mid-loop, so otherwise it's silently omitted), probes **only** URLs
    already in the corpus, caps at `CHECK_STATUS_MAX` (25), runs under
    `triageController.signal`.
- **Token budget** — the agent is seeded with an *overview only* (no raw results);
  `executeGetResults` caps at 300 results and `compactEntity` truncates snippets;
  `buildTriageOverview` caps each facet/per-root list. The system prompt steers the
  agent to `get_stats`/`countOnly` first and query with intent rather than dump the
  whole corpus (matters for smaller-context OpenAI models). If you re-introduce
  seeding raw results, you reverse this.
- **Anthropic prompt caching** — `system` is sent as a one-element text block with
  `cache_control:{type:'ephemeral'}` (caches tools+system, which render before it),
  and `setMessagesCacheBreakpoint(messages)` puts a single breakpoint on the latest
  user tool_result each round (clearing the prior one) so the growing prefix reads
  from cache. It only ever marks **user** tool_result blocks — never assistant/
  thinking blocks (modifying those is rejected on replay). Stays ≤2 of the 4
  breakpoints. OpenAI-compatible caching is provider-automatic; left untouched.
- **Triage history** lives in `chrome.storage.local` under `triageHistory` (its own
  key, separate from `settings`), written by `saveTriageRun` on `TRIAGE_DONE` and
  capped at `TRIAGE_HISTORY_CAP` (30), newest-first. It's panel-side: a run is only
  saved if the panel was open when it finished. Reports store raw Markdown.
- **Editing the system prompt**: `TRIAGE_SYSTEM` template literal in background.js.
  Keep the authorised-use framing, the tool descriptions (get_stats/get_results/
  run_dork/check_status), the tag glossary, the collect→triage workflow, and the 3
  output sections — the report is oriented around **Findings** (section 2: the most
  important assets to investigate, ranked, each with rationale + next step), NOT a
  full deduplicated unique-asset inventory; section 3 is **Coverage** (what run_dork
  actually ran), not "Suggested next dorks" (the agent runs gaps, it doesn't suggest
  them). It is byte-stable per run (cached on Anthropic) — fine to change between
  runs, just don't interpolate per-request values into it.
- **Settings persist** in `chrome.storage.local` under the `settings` object via
  the existing `SAVE_SETTINGS` message — add new `llm*` keys to `DEFAULT_SETTINGS`
  and to `applyLlmSettingsToForm` + the save handler in `wireTriage`.

## Verify a change end-to-end

1. `chrome://extensions` → enable Developer mode → **Load unpacked** →
   `/home/sasan/Desktop/DorkWay` (or click reload after edits).
2. Open the side panel; run a dork from the **Build** tab so the session has
   results + queries (Results badge non-zero).
3. **AI Triage → LLM Settings**: set provider, base URL (blank = provider
   default; OpenRouter = `https://openrouter.ai/api/v1`), API key, model, and the
   thinking toggle → Save.
4. **Run Triage** → confirm: thinking streams (when enabled), `🔧 get_stats(…)` /
   `🔧 get_results(…)` tool notes appear with tool-aware result lines (`↳ N groups
   across M results`, `↳ N of M captured results`, `↳ M matches` for countOnly),
   the report streams **as rendered Markdown** (headings, bulleted assets, clickable
   links), it leads with ranked **Findings** (most important assets to investigate,
   each with rationale + next step — citing query params where present) rather than a
   full deduped inventory, and the final section is **Coverage** (what it ran), not
   suggestions. On Anthropic, check the bg console /
   `usage` — `cache_read_input_tokens` should be non-zero after the first round.
5. **run_dork (live collection)**: give the agent a session with an obvious gap →
   confirm a `🔧 run_dork(queries: N)` note appears, a search tab opens and
   auto-paginates (Build status line updates), the triage **blocks** until capture
   finishes, then `↳ ran N dorks · +K captured (M total)` appears and the agent
   re-triages the new records. **CAPTCHA**: trigger one mid-run → a `⚠ CAPTCHA…`
   `TRIAGE_NOTE` shows in the triage output; solve it + **Resume** (Build tab) and
   the run continues to completion. **Stop** mid-capture ends both the dork run and
   the triage.
6. **Gated check_status**: with status checks **off**, confirm no `check_status`
   note ever appears. Enable status checks (grant `*://*/*`) and re-run a session
   with high-value assets → confirm a `🔧 check_status(…)` / `↳ probed N · L live`
   note appears, only captured URLs are probed, statuses persist in **Results**,
   and **Stop** aborts it mid-flight.
7. **History** sub-tab → the finished run appears (newest first); open it to see the
   stored report re-rendered; **Copy** yields raw Markdown; **Delete** / **Clear
   all** prune `chrome.storage.local.triageHistory`.
8. Negative paths: empty API key → friendly error; **Stop** aborts mid-loop (not
   saved to history); switch provider and re-run to exercise both agent loops
   (`get_stats`/`get_results`/`run_dork` must work on OpenAI-compatible too); disable
   thinking to confirm the no-reasoning path.

After editing the JS, sanity-check syntax (both are ES modules):
`node --input-type=module --check < background.js` and `< sidepanel/panel.js`.
