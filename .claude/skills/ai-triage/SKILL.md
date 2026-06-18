---
name: ai-triage
description: Work on DorkWay's AI Triage feature — the side-panel tab that sends captured Google-dork results to an LLM (Anthropic or OpenAI-compatible/OpenRouter) and streams back a deduplicated unique-asset report. Use when adding, debugging, testing, or extending triage: the LLM Settings modal, providers/models, the recon system prompt, the SSE streaming path, or the result payload.
---

# DorkWay — AI Triage

The **AI Triage** tab feeds the active session's captured results (plus the dork
queries that produced them) to an LLM with a recon-analyst system prompt, and
streams back a deduplicated inventory of *unique assets*. Provider is
configurable: **Anthropic** (`/v1/messages`) or **OpenAI-compatible**
(`/chat/completions`, which covers OpenRouter and local servers via base URL).

This project is **vanilla ES-module JS, MV3, no build step**. All network flows
through the background service worker; the side panel talks to it via
`chrome.runtime.sendMessage`. Match those patterns — don't add a bundler,
framework, or dependency.

## Where the code lives

| Concern | File · symbol |
|---|---|
| Tab nav + `#tab-triage` panel + `#llm-settings` modal | [sidepanel/panel.html](../../../sidepanel/panel.html) (`data-tab="triage"`) |
| `.triage-output` style (reuses theme vars + `.overlay`) | [sidepanel/panel.css](../../../sidepanel/panel.css) |
| Triage UI wiring, settings modal, payload build, stream render | [sidepanel/panel.js](../../../sidepanel/panel.js) — `wireTriage`, `applyLlmSettingsToForm`, `updateTriageMeta`, `triageEntity`, `runTriage`, `setTriageRunning`, `setTriageStatus`; runtime cases `TRIAGE_DELTA/DONE/ERROR` |
| Settings keys, message router, LLM request + SSE stream, system prompt | [background.js](../../../background.js) — `DEFAULT_SETTINGS` (`llmProvider/llmBaseUrl/llmApiKey/llmModel/llmMaxTokens`), `case 'RUN_TRIAGE'`/`'STOP_TRIAGE'`, `onRunTriage`, `buildAnthropicRequest`, `buildOpenAIRequest`, `streamTriage`, `TRIAGE_SYSTEM`, `triageController` |
| Provider host permissions | [manifest.json](../../../manifest.json) `host_permissions` (anthropic / openai / openrouter); custom hosts use `optional_host_permissions` at runtime |

## Data flow

1. **panel.js `runTriage()`** — guards (results present, API key set), requests
   host permission for a custom base-URL origin from the click gesture, builds
   `entities = state.results.map(triageEntity)` (each tagged
   `filtered: passesFilters(r)`, snippet truncated to ~200 chars), then
   `msg({ type:'RUN_TRIAGE', entities })`.
2. **background.js `onRunTriage(msg)`** — loads settings + the active session,
   unions `session.queries` with each result's `sourceQuery`, builds the user
   payload `{ session, queries, filterActive, results }`, picks
   `buildAnthropicRequest` / `buildOpenAIRequest`, then `fetch(..., {signal})`
   with a module-level `triageController` (aborted by `STOP_TRIAGE`).
3. **`streamTriage(body, provider)`** — line-buffers the SSE `data:` lines and
   `broadcast()`s `TRIAGE_DELTA {text}` per token, `TRIAGE_DONE {usage}` at end,
   `TRIAGE_ERROR {error}` on failure. Anthropic deltas come from
   `content_block_delta.delta.text_delta`; OpenAI from
   `choices[0].delta.content`, terminating on `data: [DONE]`.
4. **panel.js runtime listener** appends deltas to `#triage-output` (via
   `textContent +=`), toggles Run/Stop, shows status.

## Conventions & gotchas

- **Render model output with `textContent`, never `innerHTML`** — it's untrusted
  text; there is no markdown parser and the extension runs under strict MV3 CSP.
- **New provider host?** Add it to `host_permissions` in the manifest, or rely on
  the runtime `chrome.permissions.request({origins})` gesture already wired for
  custom base URLs (mirrors the status-check flow in `wireSettings`).
- **MV3 keepalive**: the in-flight streamed `fetch` keeps the service worker
  alive; don't refactor `onRunTriage` to resolve before the stream finishes.
- **One run at a time** via `triageController`; `STOP_TRIAGE` aborts it.
- **Default model** is `claude-opus-4-8` with `thinking:{type:'adaptive'}` and
  `output_config:{effort:'medium'}`. If you change the Anthropic model, confirm it
  supports the `effort` parameter (older models 400 on it). For accurate Anthropic
  API shapes, model IDs, and parameters, consult the `claude-api` skill rather
  than guessing.
- **Editing the system prompt**: it's the `TRIAGE_SYSTEM` template literal in
  background.js. Keep the authorised-use framing and the 4 output sections.
- **Settings persist** in `chrome.storage.local` under the `settings` object via
  the existing `SAVE_SETTINGS` message — add new `llm*` keys to `DEFAULT_SETTINGS`
  and to `applyLlmSettingsToForm` + the save handler in `wireTriage`.

## Verify a change end-to-end

1. `chrome://extensions` → enable Developer mode → **Load unpacked** →
   `/home/sasan/Desktop/DorkWay` (or click reload after edits).
2. Open the side panel; run a dork from the **Build** tab so the session has
   results + queries (Results badge non-zero).
3. **AI Triage → LLM Settings**: set provider, base URL (blank = provider
   default; OpenRouter = `https://openrouter.ai/api/v1`), API key, model → Save.
4. **Run Triage** → confirm the report streams into `#triage-output`, dedupes,
   and the *Suggested next dorks* section references the queries that ran.
5. Negative paths: empty API key → friendly error; **Stop** aborts mid-stream;
   switch provider and re-run to exercise both request shapes.

After editing the JS, sanity-check syntax (both are ES modules):
`node --input-type=module --check < background.js` and `< sidepanel/panel.js`.
