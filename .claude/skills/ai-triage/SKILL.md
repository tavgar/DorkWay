---
name: ai-triage
description: Work on DorkWay's AI Triage feature — the side-panel tab that runs an agentic LLM (Anthropic or OpenAI-compatible/OpenRouter) over captured Google-dork results and streams back a deduplicated unique-asset report. Use when adding, debugging, testing, or extending triage: the LLM Settings modal, providers/models, the recon system prompt, the agentic tool-use loop, the get_results tool, thinking/reasoning, the SSE streaming path, or the result payload.
---

# DorkWay — AI Triage (agentic)

The **AI Triage** tab runs an **agent**: it hands the LLM an *inventory overview*
of the captured corpus (per-value counts of root domains / subdomains / file types
/ tags / HTTP statuses — the same facets as the Results filter tab) plus the dork
queries — **no raw results**, to keep its context small — then the model
investigates on its own via a `get_results` tool, slicing the *full* captured
corpus by domain/subdomain/tag/filetype/keyword/status, and finally streams back a
deduplicated inventory of *unique assets* as **Markdown** (rendered in-panel). The
tool is read-only over already-captured data (no new Google traffic). Provider is
configurable: **Anthropic** (`/v1/messages`) or **OpenAI-compatible**
(`/chat/completions`, which covers OpenRouter and local servers via base URL).
Thinking/reasoning is enabled for models that support it (toggle in LLM Settings).
The tab has two sub-views: **Run** (live) and **History** (past reports).

This project is **vanilla ES-module JS, MV3, no build step**. All network flows
through the background service worker; the side panel talks to it via
`chrome.runtime.sendMessage`. Match those patterns — don't add a bundler,
framework, or dependency.

## Where the code lives

| Concern | File · symbol |
|---|---|
| Tab nav + `#tab-triage` (`.subtabs` Run/History, `#triage-run-view`, `#triage-history-view`) + `#llm-settings` modal (incl. `#llm-thinking`) | [sidepanel/panel.html](../../../sidepanel/panel.html) (`data-tab="triage"`) |
| `.triage-output`, `.triage-answer/.triage-think/.triage-tool` blocks, `.triage-answer` Markdown element styles, `.subtabs`, `.triage-history-item` | [sidepanel/panel.css](../../../sidepanel/panel.css) |
| Triage UI wiring, settings modal, streamed block render, Markdown render, history | [sidepanel/panel.js](../../../sidepanel/panel.js) — `wireTriage`, `applyLlmSettingsToForm`, `updateTriageMeta`, `runTriage`, `resetTriageOutput`, `appendTriage`, `addTriageNote`, `triageToolArgs`, `setTriageRunning/Status`, `renderMarkdown`/`renderInline` (XSS-safe, DOM-only), `showTriageSubtab`, `loadTriageHistory`/`saveTriageRun`/`renderTriageHistory`/`showTriageHistoryDetail`/`historySnippet`, `triageReportMd`; runtime cases `TRIAGE_THINKING/DELTA/TOOL/TOOL_RESULT/DONE/ERROR` |
| Settings keys, router, agent loops, tool, SSE parsers, system prompt | [background.js](../../../background.js) — `DEFAULT_SETTINGS` (`llmProvider/llmBaseUrl/llmApiKey/llmModel/llmMaxTokens/llmThinking`), `case 'RUN_TRIAGE'`/`'STOP_TRIAGE'`, `onRunTriage`, `buildTriageOverview`, `runAnthropicAgent`, `runOpenAIAgent`, `parseAnthropicStream`, `parseOpenAIStream`, `readSSE`, `executeGetResults`, `compactEntity`, `TRIAGE_SYSTEM`, `GET_RESULTS_SCHEMA`/`GET_RESULTS_DESC`, `TRIAGE_MAX_ITERS`, `triageController` |
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
   buildTriageOverview(all)` — per-facet `"value (count)"` lists (roots/subs/
   filetypes/tags/statuses), capped per facet. Dispatches to `runAnthropicAgent` or
   `runOpenAIAgent` under the module-level `triageController` (aborted by `STOP_TRIAGE`).
3. **Agent loop** (`runAnthropicAgent` / `runOpenAIAgent`) — up to `TRIAGE_MAX_ITERS`
   (8) rounds: stream a turn → if the model called `get_results`, run
   `executeGetResults(input, all)` (pure in-memory filter over the full corpus,
   capped at 300), append the tool result, loop; else `TRIAGE_DONE`. The streamed
   `fetch`es keep the MV3 worker alive across the whole loop.
4. **Stream parsers** (`parseAnthropicStream` / `parseOpenAIStream`, both via
   `readSSE`) accumulate one assistant turn and `broadcast()` deltas live:
   `TRIAGE_THINKING {text}` (thinking/reasoning), `TRIAGE_DELTA {text}` (answer),
   `TRIAGE_TOOL {name,input}` and `TRIAGE_TOOL_RESULT {count,total}` per tool call.
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
  lists, bold/italic, code, `http(s)`/`mailto` links — other link schemes degrade
  to plain text). If you extend the Markdown support, keep it node-based; do not
  introduce a library or `innerHTML`. Thinking/tool blocks stay plain `textContent`.
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
- **Tool surface is read-only by design** — `get_results` only filters
  already-captured data. Adding action tools (live dorking, status probes) means
  new outbound traffic and the same authorised-use gating as the status check;
  don't add them without that gate.
- **Token budget** — the agent is seeded with an *overview only* (no raw results);
  `executeGetResults` caps at 300 results and `compactEntity` truncates snippets;
  `buildTriageOverview` caps each facet list. The system prompt steers the agent to
  query with intent rather than dump the whole corpus (matters for smaller-context
  OpenAI models). If you re-introduce seeding raw results, you reverse this.
- **Triage history** lives in `chrome.storage.local` under `triageHistory` (its own
  key, separate from `settings`), written by `saveTriageRun` on `TRIAGE_DONE` and
  capped at `TRIAGE_HISTORY_CAP` (30), newest-first. It's panel-side: a run is only
  saved if the panel was open when it finished. Reports store raw Markdown.
- **Editing the system prompt**: `TRIAGE_SYSTEM` template literal in background.js.
  Keep the authorised-use framing, the agentic/get_results instructions, and the 4
  output sections.
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
4. **Run Triage** → confirm: thinking streams (when enabled), one or more
   `🔧 get_results(…)` / `↳ N captured results` tool notes appear (the agent must
   tool-call since it's given only the overview, not records), then the report
   streams **as rendered Markdown** (headings, bulleted assets, clickable links)
   and *Suggested next dorks* references the queries that ran.
5. **History** sub-tab → the finished run appears (newest first); open it to see the
   stored report re-rendered; **Copy** yields raw Markdown; **Delete** / **Clear
   all** prune `chrome.storage.local.triageHistory`.
6. Negative paths: empty API key → friendly error; **Stop** aborts mid-loop (not
   saved to history); switch provider and re-run to exercise both agent loops;
   disable thinking to confirm the no-reasoning path.

After editing the JS, sanity-check syntax (both are ES modules):
`node --input-type=module --check < background.js` and `< sidepanel/panel.js`.
