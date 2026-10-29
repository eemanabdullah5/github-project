# IMPLEMENTATION PLAN — GitHub Repository AI Assistant

**Status:** v0.1
**Last updated:** 2026-10-29
**Related:** [PRD.md](PRD.md) (v1.1), [ARCHITECTURE.md](ARCHITECTURE.md) (v0.2)
**Estimate:** 6–8 working days (PRD)

---

## How to use this plan

- Work through the phases **in order**. Each phase builds on the one before.
- Each task lists the files it touches and a **Done when** check. Don't move on until the check passes.
- **Commit after every task** that passes its check. Small commits make mistakes easy to undo.
- Phases 1–5 build the core loop (download → chunk → embed → answer) **without any UI**, using small scripts. This follows the PRD's "core RAG loop first" approach.
- Write unit tests in the same task as the code they test, not at the end.

### Waiting on the LLM decision

Qwen and Ollama are waiting for senior confirmation (DECISIONS D3, D4, D13).
- **Phases 1–3 don't use an LLM**, so they can be built now. That's about 2½ days, which leaves time for the confirmation.
- **Phase 4 and later** need the model. If the decision comes back different, only `llm.ts` and the model settings in `.env` change.

### Development on a laptop with no graphics card

Qwen runs on the processor during development, so it is slow.

- **Models:** set small ones in `.env`, e.g. `qwen2.5-coder:3b` for chat and `qwen3-embedding:0.6b` for embeddings.
- **Test repos:** use small repos (20–50 files) for day-to-day testing.
- **Performance targets:** the NFR-6 targets apply to the final hardware, not to this laptop.

---

## Phase 0 — Prerequisites (½ day)

| # | Task | Done when |
|---|---|---|
| 0.1 | ⏸ **On hold** until seniors confirm Qwen + Ollama (DECISIONS D3, D4, D13). Then install Ollama and `ollama pull` a Qwen chat model and a Qwen embedding model. | `ollama run <chat-model> "hello"` prints a reply. |
| 0.2 | ✅ Create a GitHub **fine-grained** token with read-only **Contents** and **Metadata** access, for your own repos. | Tested 2026-10-29: lists 24 repos (17 public, 7 private), and private zip download works. |
| 0.3 | Confirm Node.js 22+ (`node --version`). | The version is 22 or higher. |
| 0.4 | Prepare **test repos** (see below). | You have the list of repo URLs written down. |

**Test repos** (reuse these in every phase):

| Repo | Purpose |
|---|---|
| A small public repo you own (Python or JS/TS) | Main happy-path repo |
| A small private repo you own | Private-repo support (PRD AC 7) |
| A fork | Fork support (AC 6) |
| An empty repo | Empty-repo hiding (FR-1.7) |
| A large public repo (well over 20 MB) | Size-limit rejection (AC 8) |

---

## Phase 1 — Project setup (½ day) — ✅ Done 2026-10-29

Routes live in `app.ts` (not `index.ts`), so tests can start the app on a random port. `index.ts` only checks settings and starts the server.

| # | Task | Files | Done when |
|---|---|---|---|
| 1.1 | Create the root `package.json` with npm workspaces `server` and `web`. Add a `dev` script that starts both (using `concurrently`). | `package.json` | `npm install` runs without errors. |
| 1.2 | Create the server: TypeScript, Express, `tsx` (to run TS in development), `vitest`, `dotenv`. Add `GET /api/health` returning `{ok: true}`. Bind to `127.0.0.1`. | `server/package.json`, `server/tsconfig.json`, `server/src/index.ts` | `curl http://127.0.0.1:3001/api/health` returns `{"ok":true}`. |
| 1.3 | Create the web app with Vite's React + TypeScript template. Proxy `/api` to the server in `vite.config.ts`. | `web/` | The web page shows the health result from the server. |
| 1.4 | Add `config.ts`: load `.env` and define all constants from ARCHITECTURE §12. Fail at startup with a clear message if `GITHUB_TOKEN` is missing. | `server/src/config.ts` | Starting without a token prints a clear error. Starting with one works. |
| 1.5 | Add `types.ts` with the types from ARCHITECTURE §9: `Repo`, `SourceFile`, `Chunk`, `Manifest`, `Source`, `IndexJob`. | `server/src/types.ts` | `npx tsc --noEmit` passes. |
| 1.6 | Add `AppError` (an error with a user-safe message and an HTTP status). Every module throws this for errors the user should see. | `server/src/errors.ts` | — |
| 1.7 | Add `.gitignore` (`node_modules/`, `.env`, `data/`, `dist/`) and `.env.example` (no real values). | `.gitignore`, `.env.example` | `git status` does not show `.env`. |

---

## Phase 2 — GitHub client (1 day)

| # | Task | Files | Done when |
|---|---|---|---|
| 2.1 | `parseRepoUrl(input)`: accepts `https://github.com/o/r`, `github.com/o/r` and `o/r`. Strips `.git` and extra paths (`/tree/main`). Rejects invalid names. | `server/src/githubClient.ts` | Unit tests pass for every format and for invalid input. |
| 2.2 | A small `githubFetch()` helper: adds the token header and turns errors into `AppError`s (401, 404, rate limit with reset time, network error). | same | Unit tests with mocked `fetch` cover each error. |
| 2.3 | `listAccessibleRepos()`: `GET /user/repos` with `affiliation=owner,collaborator,organization_member`, looping through pages up to 1,000 repos. Map each result to `Repo`. | same | A unit test with mocked pages checks pagination and the cap. |
| 2.4 | `getRepo(owner, repo)` and `getLatestCommitSha(owner, repo, branch)`. | same | — |
| 2.5 | `downloadZipball(owner, repo, sha)`: returns the zip as a `Uint8Array`. | same | — |
| 2.6 | Try-out script: list your repos, then download one zip and print its size. | `server/scripts/tryGithub.ts` | The script lists your public **and** private repos. |

---

## Phase 3 — Ingestion and line chunking (1 day)

| # | Task | Files | Done when |
|---|---|---|---|
| 3.1 | `extractSourceFiles(zip)` using `fflate`: strip the top folder GitHub adds to zip paths, then apply the skip lists, size and binary checks, and file/byte limits from ARCHITECTURE §6. Detect language from the extension. | `server/src/ingestion.ts` | Unit tests (with a small zip built inside the test) cover each skip rule and each limit. |
| 3.2 | Size pre-check: reject repos whose API `size` is over the limit, **before** downloading. | `server/src/ingestion.ts` | The large test repo is rejected with a clear message and no download. |
| 3.3 | `lineChunker`: windows of 60 lines with 10 lines of overlap, capped at `MAX_CHUNK_TOKENS` (4 characters ≈ 1 token). Add the context header from ARCHITECTURE §7.3. | `server/src/chunking/lineChunker.ts` | Tests check line numbers, overlap and the cap. |
| 3.4 | `chunkFile()`: uses the line chunker for every file for now. tree-sitter comes in Phase 10. | `server/src/chunking/index.ts` | — |
| 3.5 | Try-out script: download a test repo and print the file count and chunk count, plus a few sample chunks. | `server/scripts/tryIngest.ts` | Counts look sensible, and no `node_modules` or lock files appear. |

---

## Phase 4 — Embeddings, vector store and indexer (1 day)

| # | Task | Files | Done when |
|---|---|---|---|
| 4.1 | `llm.ts` using the `ollama` package: `checkModels()`, `embedDocuments(texts)` (in batches), `embedQuery(text)`, and `chatStream(messages)` with `num_ctx` set to `NUM_CTX`. **This is the only file that talks to Ollama.** | `server/src/llm.ts` | A try-out call embeds two strings and prints the vector length. |
| 4.2 | Clear errors when Ollama isn't running or a model isn't pulled. | same | Stopping Ollama gives "Model server not running — start Ollama". |
| 4.3 | `vectorStore.ts` with `@lancedb/lancedb`: `saveIndex`, `query`, `loadManifest`, `deleteIndex`. Table name: `repo_<sha1(repoId)[:16]>`. Write the manifest JSON **last**. | `server/src/vectorStore.ts` | — |
| 4.4 | `indexer.ts`: the job runs Download → Process → Embed → Save, updating an `IndexJob` object as it goes. Only one job can run at a time. | `server/src/indexer.ts` | — |
| 4.5 | `checkIndexStatus()`: `missing` (no manifest), `stale` (the SHA or `embedModel` changed), otherwise `fresh`. | same | Unit tests for all three. |
| 4.6 | Try-out script: index a test repo and print progress. | `server/scripts/indexRepo.ts` | The index appears in `data/`. Running status afterwards prints `fresh`. |

---

## Phase 5 — RAG answers (1 day) — ⭐ core milestone

| # | Task | Files | Done when |
|---|---|---|---|
| 5.1 | `buildPrompt()`: a **pure function** (no API calls) that assembles the system rules, file tree, README, chunks, history and question (ARCHITECTURE §10). It drops the lowest-ranked chunks if the prompt would go over budget. | `server/src/rag.ts` | Unit tests check the order, the delimiters and the budget. |
| 5.2 | Follow-up rewriting: when there is history, make one short LLM call to turn the question into a standalone search query. | same | — |
| 5.3 | `answer()`: rewrite → embed the query → retrieve `TOP_K` → build the prompt → return `{sources, tokens}`. | same | — |
| 5.4 | Try-out script: ask a question on the command line and print the streamed answer, then the sources. | `server/scripts/ask.ts` | See the checks below. |

**Phase 5 checks:**
- A "which function handles X?" question cites the right file.
- An unrelated question gets "I couldn't find this in the indexed code".
- Answers start with a short summary.

**Milestone:** once Phase 5 works, the core of the product works. **Demo it to your lead** before building the UI.

---

## Phase 6 — HTTP API (½ day)

| # | Task | Files | Done when |
|---|---|---|---|
| 6.1 | Add the routes from ARCHITECTURE §4.2. Keep each handler short: read inputs, call a module, send the result. | `server/src/index.ts` | — |
| 6.2 | Cache the repo list in memory; `?refresh=1` refetches it. | same | — |
| 6.3 | Return `409` from the index route when a job is already running. | same | Starting two jobs with `curl` returns `409` for the second. |
| 6.4 | Chat route: stream Server-Sent Events in the order `sources` → `token`… → `done`, or `error`. | same | `curl -N` shows the events arriving in order. |
| 6.5 | Error middleware: send `AppError`s as `{error: message}` with their status. Any other error sends a generic message and is logged without secrets. | same | No token appears in any response or log. |

---

## Phase 7 — Repo Browser UI (1 day)

| # | Task | Files | Done when |
|---|---|---|---|
| 7.1 | `api.ts`: typed functions for every endpoint. | `web/src/api.ts` | — |
| 7.2 | `App.tsx`: hold the view (`browser` \| `chat`) and the selected repo in state. | `web/src/App.tsx` | — |
| 7.3 | Repo list: name, owner, description, language, stars, updated date, Fork and Private badges. Pages of 20. | `web/src/views/RepoBrowser.tsx` | Your public and private repos appear. |
| 7.4 | Search, sort, the Type / Visibility / Owner filters, and the "show empty repos" toggle, all running over the full list. | same | PRD AC 3–4 pass. |
| 7.5 | Paste-a-URL input. | same | PRD AC 2 passes. |
| 7.6 | Selecting a repo: check status → `fresh` opens chat; `missing` starts indexing; `stale` asks "Re-index?". | same | — |
| 7.7 | Progress panel: poll `/api/index-job` every second and show each step with counts. Show a clear message on `409`. | `web/src/components/IndexProgress.tsx` | PRD AC 17 passes. |
| 7.8 | Error messages for every case in FR-1.9. | same | — |

---

## Phase 8 — Chat UI (1 day)

| # | Task | Files | Done when |
|---|---|---|---|
| 8.1 | Header: repo name, status, short SHA, and the "Back to repos", "Re-index" and "Clear chat" buttons. | `web/src/views/Chat.tsx` | — |
| 8.2 | Streaming. The browser's `EventSource` only supports GET requests, so read the POST response with `fetch` and parse the SSE events from the stream. | `web/src/api.ts` | Tokens appear one by one. |
| 8.3 | Render answers with `react-markdown` + `rehype-highlight`. **Never** enable raw HTML. | `web/src/views/Chat.tsx` | Code snippets are highlighted. |
| 8.4 | A collapsible Sources list under each answer. | same | PRD AC 13 passes. |
| 8.5 | Starter questions (FR-4.5); history sends the last 3 exchanges. | same | PRD AC 14 and 18 pass. |
| 8.6 | Clear chat and repo switching reset the messages. | same | PRD AC 19 passes. |

---

## Phase 9 — Theme and polish (½ day)

| # | Task | Done when |
|---|---|---|
| 9.1 | Light/dark toggle with CSS variables. Default from `prefers-color-scheme`; save the choice in `localStorage`. | PRD AC 20 passes. |
| 9.2 | Loading states, empty states, and a consistent, professional layout (NFR-5). | — |
| 9.3 | `README.md`: what the app is, setup steps (Ollama, token, `.env`, `npm install`, `npm run dev`) and the test repos. | A teammate could set it up from the README alone. |

---

## Phase 10 — tree-sitter chunking (1 day) — only if D8 is approved

| # | Task | Files | Done when |
|---|---|---|---|
| 10.1 | Load `web-tree-sitter` and the `.wasm` grammars for Python, JS, TS/TSX, Java and Go. Check that the grammar files match the `web-tree-sitter` version. | `server/src/chunking/syntaxChunker.ts`, `server/grammars/` | Each language parses a sample file. |
| 10.2 | `languages.ts`: the node types used as units for each language (ARCHITECTURE §7.1). | `server/src/chunking/languages.ts` | — |
| 10.3 | Build chunks: functions, classes or methods, module code, oversized splitting, fallback on syntax errors. | `syntaxChunker.ts` | Unit tests per language check boundaries and line numbers. |
| 10.4 | `chunkFile()` picks the syntax chunker for supported languages. Record `chunker` in the chunk metadata. | `chunking/index.ts` | — |
| 10.5 | `evalRetrieval.ts`: compare syntax+line against line-only on 2 repos, reporting hit@8. | `server/scripts/evalRetrieval.ts` | The results are written into ARCHITECTURE §16 and D8 is updated. |

---

## Phase 11 — Final testing (½ day)

| # | Task | Done when |
|---|---|---|
| 11.1 | Run all unit tests (`npm test`). | All pass. |
| 11.2 | Run the integration test: index a small repo and ask a known question (needs Ollama running). | It passes. |
| 11.3 | Walk through **all 22 PRD acceptance criteria** in the browser, using the test repos. Note each result as pass or fail. | All pass, or each failure is logged as a follow-up. |
| 11.4 | Privacy check (AC 22): while indexing and chatting, watch network connections in Windows Resource Monitor. Only GitHub and `127.0.0.1` should appear. | Confirmed. |
| 11.5 | Secrets check (AC 21): search the code, logs and browser network tab for the token. | Not found anywhere. |

---

## Summary

| Phase | What | Days |
|---|---|---|
| 0 | Prerequisites | ½ |
| 1 | Project setup | ½ |
| 2 | GitHub client | 1 |
| 3 | Ingestion and line chunking | 1 |
| 4 | Embeddings, vector store, indexer | 1 |
| 5 | RAG answers ⭐ demo | 1 |
| 6 | HTTP API | ½ |
| 7 | Repo Browser UI | 1 |
| 8 | Chat UI | 1 |
| 9 | Theme and polish | ½ |
| 10 | tree-sitter chunking (if approved) | 1 |
| 11 | Final testing | ½ |
| | **Total** | **≈ 9½** |

The total is above the PRD's 6–8 days. To fit 8 days, do Phase 10 after the MVP: line chunking already meets the PRD, and D8 is still only proposed. Without Phase 10, the total is ≈ 8½ days, and Phase 0 can be done before the clock starts.
