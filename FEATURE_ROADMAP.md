# FEATURE ROADMAP — GitHub Repository AI Assistant

**Last updated:** 2026-11-11
**Related:** [PRD.md](PRD.md), [ARCHITECTURE.md](ARCHITECTURE.md), [DECISIONS.md](DECISIONS.md), [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)

This file lists the features planned after the MVP, in the order we'll build them, and explains how each finished feature works and where its code lives.

**Where the ideas came from:**
- **PRD:** already committed to in the PRD (§8)
- **Claude Code:** suggested while building the MVP
- **Opus:** from the Claude Opus strategic review (2026-11-07)

---

## Decisions behind this roadmap

| Decision | Choice | Why |
|---|---|---|
| Product direction | Stay an **internal leadership tool**, as in the PRD | Opus suggested turning it into a commercial product ("RepoMind": team server, CLI, GitLab support). That's a different product, and too big for one developer. We kept its best engineering ideas. |
| AI provider | **Gemini for now** (D16), Ollama kept as a switch | Ollama is too slow without a GPU. Can be switched back if seniors require local-only. |
| Git history | Read through the **GitHub commits API**, not `git clone` | Uses the existing GitHub client and token. No git install, nothing extra on disk. Limited to the last 12 months and 500 commits to stay within GitHub's rate limit. |
| People data | Show **areas at risk**, not people's names | "Only 1 person works on payments" is useful. Naming people can feel like monitoring employees, so names wait for senior approval. |
| Security scanning | **Later** | Big, needs outside tools, and isn't needed for the first demo. |

---

## Already done before this roadmap

| Feature | Source | Notes |
|---|---|---|
| **Secret protection** | Opus | Secret files (`.env`, private keys, credential files) are skipped, and well-known key formats are masked as `[REDACTED …]` before indexing. Code: `isSecretFile()` and `redactSecrets()` in [server/src/ingestion.ts](server/src/ingestion.ts). Tests: [server/tests/ingestion.test.ts](server/tests/ingestion.test.ts). |
| **Switchable AI provider** | Claude Code | `LLM_PROVIDER=gemini` or `ollama`. See D16. |

---

## Phase 1 — Monday demo set

Built in this order, because later features reuse earlier ones.

| # | Feature | Source | Effort | Status |
|---|---|---|---|---|
| F1 | **Clickable sources**: each cited file opens on GitHub at the exact lines of the indexed commit | Claude Code | S | ✅ Done |
| F2 | **Executive / Technical toggle**: short leader answers or detailed developer answers | PRD | S | ✅ Done |
| F3 | **Suggested follow-up questions** after each answer | Claude Code | S | ✅ Done |
| F4 | **Git history hotspots**: which files change most, how complex they are, which files change together, and which areas only one person works on | Opus + Claude Code | M | ✅ Done |
| F5 | **Repo health report**: one click gives a summary, tech stack, structure, dependencies, hotspots and risks, downloadable as Markdown | Claude Code + Opus | M | ✅ Done |

How each one works is written up under [Implementation notes](#implementation-notes) once it's built.

---

## Phase 2 — Trust and quality (~1 week)

| Feature | Source | Effort | Notes |
|---|---|---|---|
| **Verified citations** ✅ Done | Opus | S | After each answer, check that every `[path:Lx-Ly]` citation points to a real file and lines that were retrieved, and flag any that don't. |
| **Hybrid search** | Opus + Claude Code | S–M | Add LanceDB's built-in full-text search alongside vector search, so exact function and class names are always found. |
| **Evaluation harness** | Opus | M | Extend [server/scripts/evalRetrieval.ts](server/scripts/evalRetrieval.ts) with 30–50 questions per test repo. Measure file recall@8 and citation validity before and after every retrieval change. |
| **Ask about one folder** ✅ Done | Claude Code | S | Limit a question to a folder or file, such as `src/auth`. |

## Phase 3 — Deeper understanding (~1.5–2 weeks)

| Feature | Source | Effort | Notes |
|---|---|---|---|
| **Index-time folder summaries** | Opus | M | While indexing, write a short summary of each folder and store it as a searchable document. Big-picture questions then use these summaries. Per folder rather than per file, to stay within Gemini's free-tier limits. |
| **Saved chat history** | PRD | M | Keep conversations per repo across sessions, in SQLite (`better-sqlite3`). The same database can later hold the code graph. |
| **Incremental re-index** | Opus + Claude Code | M | Re-embed only files whose content changed since the last index. |
| **Usage and cost display** | Claude Code | S | Show the Gemini tokens used per answer and per index. |
| **Dependency scan** | Claude Code | S–M | Read `package.json`, `requirements.txt`, `go.mod`, `pom.xml` and similar files directly, to give exact dependencies and versions without relying on the AI. |

## Phase 4 — Code graph and architecture (~3–5 weeks)

| Feature | Source | Effort | Notes |
|---|---|---|---|
| **Import graph** ✅ Python + JS/TS | Opus | M | Which file imports which, from tree-sitter. Stored as JSON in `data/graphs/` for now (SQLite later). Go and Java still to do. |
| **Architecture map** ✅ Done | Opus | M–L | A zoomable module diagram with hotspot overlay, plus cycle detection. |
| **Hidden coupling** ✅ Done | Opus | S (after the import graph) | Files that change together (from F4) but have no import between them. These are usually real design problems. |
| **Call graph** | Opus | L | "Who calls this function?" answered from the graph instead of from search. |
| **Change impact** | Opus | M | For a changed function: what depends on it, and which tests reach it. |
| **PR risk briefing** | Opus | M | A one-screen summary of a pull request with a transparent risk score and suggested reviewers. |

## Later

| Feature | Source | Why later |
|---|---|---|
| Security posture: secrets in history, vulnerable dependencies, reachability | Opus | Needs outside tools (gitleaks, OSV-Scanner), and some rule sets have licence limits. Not needed for the first demo. |
| Test gap map | Opus | Needs the import graph. |
| Architecture rules and drift detection | Opus | Needs the architecture map. |
| Architecture diff between releases | Opus | Needs the architecture map. |
| Decision archaeology ("why does this code exist?") | Opus | Needs PR and issue data as well as commits. |
| Branch selection | Claude Code | Useful, but not asked for yet. |
| Org repo access | Claude Code | Blocked on the senior decision about tokens (D15). |
| Names in the knowledge map | Opus | Needs senior / HR approval. |

## Not planned

| Idea | Source | Why not |
|---|---|---|
| Team server mode, CLI, local MCP server | Opus | Part of the commercial pivot. Out of PRD scope (single user, local only). |
| GitLab / plain git support | Opus | The product is built around GitHub. Revisit only if the direction changes. |
| Cross-repo service map | Opus | Needs multi-repo support first. Very large. |
| Sensitive-data flow map | Opus | Very large, and needs the call graph. |
| Monitors and weekly digests | Opus | The app only runs while it's open, so it can't send alerts. |
| Model profiles, LLM question router, cross-encoder reranker | Opus | Heavy additions. Only worth it once the code graph exists. |
| **Commit-count or productivity leaderboards** | — | **Never.** They damage trust and invite gaming. |

---

## Implementation notes

Each feature gets a section here when it's built: what it does, how it works, which files changed, and how to demo it.

### F1 — Clickable sources ✅

**What it does:** file names in an answer (citations like `[src/app.py:L10-L16]`) and every file in the *Sources* list under an answer are links. Clicking one opens the file on GitHub in a new tab, with those lines highlighted.

**How it works:**
1. The chat already loads the index status, which includes the **commit SHA** the repo was indexed at.
2. `githubLineUrl()` builds a link like `https://github.com/owner/repo/blob/<sha>/src/app.py#L10-L16`. Using the commit SHA instead of the branch name keeps the line numbers correct even after new commits.
3. `linkCitations()` finds citations in the answer text and rewrites them as Markdown links. It handles several citations in one bracket (`[a.py:L1-L4, b.py:L7]`) and citations without the `L` (`[a.py:23-45]`), which Gemini sometimes writes.
4. **Safety check:** a citation only becomes a link if its file is in that answer's Sources list, the code the AI was really given. A file the AI made up stays plain text, so there are no broken links.
5. Links open in a new tab, so the chat stays open.

**Why GitHub links and not an in-app viewer:** simpler, shows the whole file, and done in time for the demo. An in-app code viewer could come later. GitHub links to private repos only open for people logged in to GitHub.

**Where the code is:**
| File | What changed |
|---|---|
| [web/src/sourceLinks.ts](web/src/sourceLinks.ts) | **New.** `githubLineUrl()`, `sourceUrl()`, `linkCitations()` |
| [web/src/sourceLinks.test.ts](web/src/sourceLinks.test.ts) | **New.** 8 tests: line ranges, single lines, spaces in paths, several citations, citations without `L`, made-up files, normal brackets left alone |
| [web/src/views/Chat.tsx](web/src/views/Chat.tsx) | Answers pass through `linkCitations()`. Each Sources item is a link. |
| [web/src/index.css](web/src/index.css) | Link colour |
| [web/package.json](web/package.json), [package.json](package.json) | Added `vitest` to the web app. `npm test` runs server and web tests. |

**No server changes:** the browser already had the commit SHA and the sources.

**How to demo:** open a repo's chat → ask a question → click a blue citation in the answer, or open *Sources* and click a file.

### F2 — Executive / Technical toggle ✅

**What it does:** two buttons above the question box, *Executive* or *Technical*:
- **Executive:** a short summary plus 3–5 bullet points on purpose, impact, risk and effort. Under about 150 words, no code, no jargon. Still cites files, so F1 links work.
- **Technical** (default): the summary plus full detail and code snippets. This is the original behaviour.

The choice applies to the next question, and the browser remembers it.

**How it works:**
1. The browser sends the choice with each question: `POST /api/repos/:owner/:repo/chat` with body `{ question, history, depth }`.
2. The chat route checks the value. Anything other than `"executive"` becomes `"technical"`, so a wrong value can't break anything.
3. `buildPrompt()` in `rag.ts` adds one of two fixed instruction blocks (`DEPTH_RULES`) right after the main rules. Only the instructions to the AI change. Search, sources and citations work the same in both modes.
4. The executive instructions say clearly that they override the "include code snippets" rule, so the AI doesn't get mixed messages.

**Measured on a real repo (Gemini, same question):** executive gave 115 words and 0 code blocks; technical gave 290 words and 3 code blocks.

**Where the code is:**
| File | What changed |
|---|---|
| [server/src/rag.ts](server/src/rag.ts) | New `AnswerDepth` type and `DEPTH_RULES`. `buildPrompt()` and `answer()` take a `depth`. |
| [server/src/app.ts](server/src/app.ts) | The chat route reads `depth` from the request and passes it to `answer()` |
| [web/src/api.ts](web/src/api.ts) | `streamChat()` sends `depth` |
| [web/src/views/Chat.tsx](web/src/views/Chat.tsx) | The toggle buttons. The choice is saved in `localStorage` under `answerDepth`. |
| [web/src/index.css](web/src/index.css) | Toggle styles |
| [server/tests/rag.test.ts](server/tests/rag.test.ts), [server/tests/app.test.ts](server/tests/app.test.ts) | 3 tests: technical is the default, executive adds its rules, and the API passes the value through (unknown values become technical) |

**How to demo:** ask *"How does it handle memory?"* with **Executive** selected, then switch to **Technical** and ask again.

### F3 — Suggested follow-up questions ✅

**What it does:** after each answer finishes, 3 clickable questions appear under it ("Ask next: …"). Clicking one asks it straight away. This helps non-technical users keep exploring without knowing what to ask.

**How it works:**
1. While the answer streams to the browser, the chat route also keeps a copy of the full answer text.
2. When the answer ends, it calls `suggestFollowUps(question, answer, depth)` in `rag.ts`. That's one short extra AI call asking for 3 follow-up questions, one per line, that can be answered from the repo's code. In Executive mode (F2) it asks for questions a CTO would ask, in Technical mode questions a developer would ask.
3. `parseFollowUps()` cleans the reply: it removes bullets, numbers and quotes, keeps only lines ending in `?`, drops very short or long lines, and keeps at most 3.
4. The questions are sent as a new event. The stream order is now **`sources` → `token`… → `followups` → `done`**.
5. **Failure-safe:** if the extra call fails, it returns an empty list. The answer is already complete, so the user just sees no suggestions.
6. The buttons only show under the **latest** answer, and only once it has finished.

**Real examples:** Executive: *"What third-party libraries are required to run the project?"* Technical: *"How does `RecommenderAgent` implement defensive copying for its catalog?"*

**Where the code is:**
| File | What changed |
|---|---|
| [server/src/rag.ts](server/src/rag.ts) | New `suggestFollowUps()` and `parseFollowUps()` |
| [server/src/app.ts](server/src/app.ts) | The chat route keeps the answer text, then sends `followups` before `done` |
| [web/src/api.ts](web/src/api.ts) | `followUps` on `ChatMessage`. `streamChat()` handles the `followups` event (`onFollowUps`). |
| [web/src/views/Chat.tsx](web/src/views/Chat.tsx) | The "Ask next" buttons under the latest answer |
| [web/src/index.css](web/src/index.css) | Button styles |
| [server/tests/rag.test.ts](server/tests/rag.test.ts), [server/tests/app.test.ts](server/tests/app.test.ts) | Tests for the cleanup and the new event order |

**Trade-off:** one extra AI call per question, which adds about 1–2 seconds before the question box unlocks.

**How to demo:** ask any question → when the answer finishes, click one of the "Ask next" buttons.

### F4 — Git history hotspots ✅

**What it does:** a **Hotspots** tab next to Chat. Clicking **Analyse history** reads the last 12 months of commits and shows:
1. **Headline numbers:** commits analysed, files changed, areas with one contributor.
2. **Top hotspots chart:** the 10 riskiest files. Risk score = how often a file changes × how complex it is, scaled so the riskiest file is 100. Hover a bar for details.
3. **Table** of changed files: changes, complexity, lines, people, last changed, score. File names link to GitHub (reuses F1).
4. **Files that change together:** pairs often changed in the same commit, which can mean a hidden dependency.
5. **Knowledge risk:** how many people changed each top-level folder, with a ⚠ when only one person did. **No names are shown or stored.**

**How it works:**
1. `POST /api/repos/:owner/:repo/hotspots` runs `analyzeHistory()`:
   - downloads the current code (same filters as indexing, so secrets are skipped and masked) to measure complexity
   - lists the last 12 months of commits from the GitHub API (at most 500) and skips **merge commits** (they repeat changes already counted) and **bots** (like dependabot, which aren't people)
   - asks GitHub which files each new commit changed, 5 requests at a time. Commits saved last time are reused, so a refresh only fetches new ones.
2. `computeReport()` does the maths. It's a pure function (no network or disk), so it's easy to test:
   - **Complexity** = number of decision points (`if`, `for`, `while`, `case`, `catch`, `&&`, `||`, `? :`). Docs and config files count as 0.
   - **Score** = changes × complexity, scaled so the top file is 100.
   - **Files that change together:** pairs changed together at least 3 times.
   - **Knowledge risk:** people per top-level folder, flagged when 1 person made at least 3 commits.
3. **Big commits (more than 30 files)** count for hotspots and people, but are left out of "files that change together", because one 46-file commit would create 1,035 fake pairs. Files that were only renamed, with no lines changed, don't count. (We first skipped big commits entirely, but in class-flow that threw away a real 46-file feature commit, so we changed the rule.)
4. **People are hashed:** each author is stored as a 12-character scrambled code. It can count people but can't be turned back into a name.
   **Same person, several emails (added 2026-11-09):** a computer where git was never told the user's email makes one up from its network address (e.g. `name@192.168.1.9`), which changes, and GitHub can't link it to an account. Counting by email turned one person into several (github-project showed 5 people for a solo repo). `personIds()` now matches people in this order: GitHub account → for unlinked commits, the account with the same name (if exactly one) → the name → the email. Two accounts with the same name stay separate. It runs on every analysis, so commits saved earlier are re-counted the same way.
5. Results and commits are saved in `data/history/<owner>__<repo>.json`. `GET /api/repos/:owner/:repo/hotspots` returns the saved report.

**Why a button and not part of indexing:** it works on already-indexed repos without re-indexing, and it only uses GitHub, so the Gemini rate limit can't affect it.

**Tested on class-flow:** 7 seconds, 24 commits, 116 files changed. Top hotspot: `backend/app/schemas.py` (9 changes × complexity 14). Most frequent pair: `main.py` ⇄ `schemas.py`.

**Where the code is:**
| File | What changed |
|---|---|
| [server/src/gitHistory.ts](server/src/gitHistory.ts) | **New.** `analyzeHistory()`, `computeReport()`, `countComplexity()`, `loadHistory()` |
| [server/src/githubClient.ts](server/src/githubClient.ts) | New `listCommits()` and `getCommitFiles()` |
| [server/src/config.ts](server/src/config.ts) | Limits: 12 months, 500 commits, 30 files per commit for co-change, 3 joint changes, 5 parallel requests |
| [server/src/types.ts](server/src/types.ts) | `CommitRecord`, `HotspotFile`, `CoChangePair`, `AreaStats`, `HistoryReport` |
| [server/src/app.ts](server/src/app.ts) | `GET` and `POST /api/repos/:owner/:repo/hotspots` |
| [server/tests/gitHistory.test.ts](server/tests/gitHistory.test.ts) | **New.** Tests for complexity, scoring, deleted files, co-change, knowledge risk without names, big commits, renames, merges and bots, reuse of saved commits, GitHub errors, and two analyses at once |
| [web/src/components/Hotspots.tsx](web/src/components/Hotspots.tsx) | **New.** The tab: headline numbers, bar chart with hover tooltip, tables, lists |
| [web/src/views/Chat.tsx](web/src/views/Chat.tsx) | **Chat \| Hotspots** tabs |
| [web/src/api.ts](web/src/api.ts), [web/src/index.css](web/src/index.css) | API calls and types. Tab, chart and table styles. The bar colour passed contrast and colour-blindness checks on both themes. |

**How to demo:** open a repo with some history (class-flow) → **Hotspots** → **Analyse history** → walk through the chart, the pairs and knowledge risk.

### F5 — Repo health report ✅

**What it does:** a **Report** tab next to Chat and Hotspots. One click generates a one-page health report a CTO could read or forward, and **Download .md** saves it as a Markdown file. The report has:
1. **Facts:** repo, commit, file count, languages. Calculated directly, no AI.
2. **Overview, Tech stack, Structure, Dependencies and external services, Risks and tech debt, Onboarding notes:** written by the AI from the indexed code, in executive style, with citations. "Risks" starts with *"Based on the parts of the code that were retrieved, not a full audit."*
3. **Hotspots and knowledge risk:** copied word for word from the F4 analysis (top 5 hotspots, most linked files, one-person areas). No AI, so the numbers are exact.

**How it works:**
1. `POST /api/repos/:owner/:repo/report` runs `generateReport()`.
2. For each of the 6 AI sections, it searches the index with its own question (e.g. *"Which external services, APIs, databases… does it depend on?"*) and takes the best 4 chunks.
3. `mergeRoundRobin()` merges the 6 result lists **taking turns**: every section's best chunk first, then every section's second best, skipping repeats. If the prompt is too big and the end of the list gets cut, every section still keeps its best code.
4. `buildReportPrompt()` asks for the fixed headings, adds the README, file tree and chunks, and stays within the size limit. **One** AI call writes all 6 sections.
5. The facts section, the AI sections and the F4 section are joined into one Markdown document. `plural()` makes the numbers read properly ("1 commit", "24 commits").
6. The report is saved in `data/reports/<owner>__<repo>.json`, so reopening is instant. `GET /api/repos/:owner/:repo/report` returns it. **Regenerate** makes a new one.
7. In the browser, citations become GitHub links (F1). The downloaded file keeps the links.

**Cost:** one chat call plus 6 tiny search embeddings. The repo isn't re-embedded, so it fits easily in the free Gemini limits.

**Tested on ai_agent_oop (Gemini):** 13 seconds, all sections, 15 cited sources. It found real tech debt: duplicated code under `Final_submission/`.

**Where the code is:**
| File | What changed |
|---|---|
| [server/src/report.ts](server/src/report.ts) | **New.** `generateReport()`, `loadReport()`, `languageBreakdown()`, `factsSection()`, `hotspotsSection()`, `mergeRoundRobin()`, `buildReportPrompt()` |
| [server/src/rag.ts](server/src/rag.ts) | 4 helpers are now shared with the report: `truncateTree()`, `truncateReadme()`, `formatChunk()`, `toSources()` |
| [server/src/app.ts](server/src/app.ts) | `GET` and `POST /api/repos/:owner/:repo/report` |
| [server/tests/report.test.ts](server/tests/report.test.ts) | **New.** 10 tests: language breakdown, facts, hotspots section with and without F4 data, plurals, fair merging, prompt headings, size limit |
| [web/src/components/HealthReport.tsx](web/src/components/HealthReport.tsx) | **New.** The Report tab: Generate/Regenerate, rendered report, Download .md |
| [web/src/views/Chat.tsx](web/src/views/Chat.tsx) | Third tab: **Chat \| Hotspots \| Report** |
| [web/src/api.ts](web/src/api.ts), [web/src/index.css](web/src/index.css) | API calls and type, report styling |

**How to demo:** open a repo → **Hotspots** → **Analyse history** → **Report** → **Generate** → click a citation → **Download .md**.

### Verified citations ✅ (Phase 2)

**What it does:** every citation in a chat answer or health report is checked against the code the AI was really given.
- **Verified:** the file was retrieved **and** every cited line is inside a retrieved chunk. It stays a GitHub link (F1).
- **Unverified:** a made-up file, lines the AI never saw (e.g. it was given lines 10–16 and cites 200–220), or impossible numbers like `L0` or `L20-L10`. It shows as an amber ⚠ badge with a hover explanation, not a link.
- A warning line appears under the answer (once it has finished) or at the top of the report: *"2 citations point to code the AI wasn't shown. Double-check those claims."*
- The downloaded report writes unverified citations as `path:L1-L2 (⚠ unverified)`.

**Before:** only the file name was checked, and a failed citation silently became plain text, so users couldn't tell checked from unchecked.

**Why flag and not reject:** one wrong line number rarely makes the whole answer wrong, and throwing answers away would make the app feel broken. **Limit:** this checks that a citation points at retrieved code. It doesn't prove the sentence next to it is true. README text is given to the AI without line numbers, so README line citations count as verified only when the README was also retrieved as a chunk.

**How it works:** `isCitationVerified()` sorts the retrieved line ranges of the cited file and walks them. Chunks that overlap or touch count together, so a citation spanning two neighbouring chunks is still verified.

**Tested on ai_agent_oop (Gemini):** a chat answer had 8/8 citations verified, and the saved report 11/11.

**Where the code is:**
| File | What changed |
|---|---|
| [web/src/sourceLinks.ts](web/src/sourceLinks.ts) | `linkCitations()` marks unverified citations and has a `forExport` option. The checking itself is in [web/src/citations.ts](web/src/citations.ts). |
| [web/src/components/CitationLink.tsx](web/src/components/CitationLink.tsx) | **New.** Shared link renderer (⚠ badge for unverified citations) and `CitationWarning` |
| [web/src/views/Chat.tsx](web/src/views/Chat.tsx), [web/src/components/HealthReport.tsx](web/src/components/HealthReport.tsx) | Use the shared renderer and show the warning. The report download uses `forExport`. |
| [web/src/index.css](web/src/index.css) | Badge and warning styles (existing `--warn` colours) |
| [web/src/sourceLinks.test.ts](web/src/sourceLinks.test.ts) | 17 tests: line ranges, overlapping chunks, gaps, mixed groups, impossible numbers, export text, counts |

**How to demo:** ask a question → hover a citation. To see a ⚠ badge, look at an answer where the AI cites lines outside its Sources.

### Import graph ✅ (Phase 4, Python + JS/TS)

**What it does:** works out which file in a repo imports which. For every Python, JavaScript and TypeScript file it records:
- **arrows between repo files** (`demo.py → agents.py`)
- **outside packages** and which files use them (`pytest`, `react`)
- **built-ins**, counted separately so the report isn't full of `os` and `fs`
- **unresolved imports**: ones that look like repo files but match nothing (e.g. a path alias). They're counted, so the graph is honest about what it missed.

This is the base for the rest of Phase 4: architecture map, hidden coupling, change impact.

**How it works:**
1. `findImports()` uses the tree-sitter parsers already loaded for chunking to find import statements. Python: `import a.b`, `from .x import y`, `from a import *`. JS/TS: `import`, `export … from`, `require("x")`, `import("x")`, `import x = require("x")`. Imports built from variables (template strings) can't be followed and are skipped.
2. `resolvePython()` / `resolveJs()` turn each import into a file:
   - **Python:** relative dots go up folders. Absolute imports are looked up from the importing file's folder and each folder above it, then the repo root, then `src/`. `a/b.py` and `a/b/__init__.py` both count, and `from pkg import mod` finds `pkg/mod.py`.
   - **JS/TS:** relative paths with added extensions and `index` files. `./rag.js` finds `rag.ts`, because TS code imports the compiled name. `@/` and `~/` aliases are tried as `src/`; tsconfig `paths` aren't read yet.
3. `buildImportGraph()` keeps one arrow per pair of files and counts everything. `summarizeGraph()` gives coverage, the most depended-on files, files nothing imports, and links between top-level folders.
4. It's built **at the end of indexing** (local parsing, no AI, a few seconds). If it fails, indexing still succeeds. Repos indexed before this feature get their graph the first time it's asked for: the code at the indexed commit is downloaded again.

**Why JSON and not SQLite (as first planned):** repos are capped at 1,000 files, so the graph is small. JSON matches how F4 and F5 save their data, and needs no native library to compile on Windows. Move to SQLite when chat history or the call graph need a real database.

**Where you see it:** a new **Code structure (from imports)** section in the health report (F5): coverage, the 5 most depended-on files, outside packages, and files nothing imports. The full graph is at `GET /api/repos/:owner/:repo/graph`. A diagram comes with the architecture map.

**Tested on real repos:**
- **ai_agent_oop** (Python): 14 files, 8 links, 100% followed. Each `Final_submission/` test links to its own copy of `agents.py`.
- **github-project** (this app, TypeScript): 47 files, 135 links, 100% followed. `types.ts` (21) and `config.ts` (20) are the most depended-on, and the outside packages match `package.json`.

**Known limits:** Go and Java aren't read yet. tsconfig `paths` aliases other than `@/` and `~/` show as unresolved. "Links between top-level folders" is coarse for repos with everything under one folder (e.g. `server/`); the architecture map will group more finely.

**Where the code is:**
| File | What changed |
|---|---|
| [server/src/importGraph.ts](server/src/importGraph.ts) | **New.** `findImports()`, `buildImportGraph()`, `summarizeGraph()`, `loadGraph()`, `saveGraph()`, `getGraph()` |
| [server/src/importResolvers.ts](server/src/importResolvers.ts) | **New.** `resolvePython()`, `resolveJs()`, Python standard library and Node built-in lists |
| [server/src/chunking/syntaxChunker.ts](server/src/chunking/syntaxChunker.ts) | `getParser()` is exported so the graph reuses the same parsers |
| [server/src/indexer.ts](server/src/indexer.ts) | Builds and saves the graph after the index is saved |
| [server/src/app.ts](server/src/app.ts) | `GET /api/repos/:owner/:repo/graph` |
| [server/src/report.ts](server/src/report.ts) | New `structureSection()`, added between the AI sections and the hotspots |
| [server/src/types.ts](server/src/types.ts) | `ImportEdge`, `UnresolvedImport`, `ImportGraph`, `GraphSummary` |
| [server/tests/importGraph.test.ts](server/tests/importGraph.test.ts) | **New.** 13 tests: Python and JS/TS path rules, parsing each import kind, building and summarising |
| [server/tests/report.test.ts](server/tests/report.test.ts) | 2 tests for the new report section |

### Architecture map ✅ (Phase 4)

**What it does:** an **Architecture** tab (next to Chat, Hotspots and Report) shows how the repo is put together, built from the import graph with no AI:
1. **Headline numbers:** modules (folders), imports between them, module cycles, circular file imports.
2. **Module map:** a Mermaid diagram. Each box is a folder of code; each arrow points from the folder that imports to the folder it uses, labelled with how many imports it stands for. Zoom buttons for bigger repos.
3. **Hotspot colours:** if the history was analysed (F4), each folder is coloured by its riskiest file (three shades of orange). Otherwise the legend says to run Analyse history.
4. **Cycles:** loops between folders (red arrows on the map) and circular imports between files. Each loop lists the imports that create it, as GitHub links to the exact line. Loops of folders inside one parent folder are labelled, because they're common and less worrying.
5. **Modules table:** files, how many folders each one uses and is used by, and its riskiest file.

The same diagram and cycle list are in the **health report** (F5) as a ` ```mermaid ` block, so the downloaded `.md` shows the picture on GitHub.

**How it works** ([server/src/architecture.ts](server/src/architecture.ts)):
1. `chooseDepth()` picks how deep to group folders: the deepest level that gives at most 20 boxes. This app gives `server/src/chunking` and `web/src/views`, not just `server` and `web`.
2. File imports are added up into module arrows, keeping 3 example imports per arrow.
3. `findCycles()` finds loops (Tarjan's strongly connected components), for folders and for files. It's written without recursion, so very long import chains can't crash it.
4. `heatLevel()` turns the riskiest hotspot score into a colour band (67+, 34+, above 0).
5. `toMermaid()` writes the diagram text. Folder names are escaped, and the web app draws it with Mermaid's strict security mode, so text from a repo can't run as code.

**Why Mermaid:** one format for the app and the downloaded report, and GitHub renders it. It runs in the browser from the installed package, with no outside service. It's loaded only when a diagram is first shown, so the rest of the app doesn't get slower.

**Tested:**
- **github-project** (this app): 8 folders, 70 imports between them. It found 2 folder loops: `web/src ⇄ web/src/components ⇄ web/src/views` (the app imports views, views import `api.ts`) and `server/src ⇄ server/src/chunking`. It also found one real circular file import: `llm.ts ⇄ llmGemini.ts ⇄ llmOllama.ts` (the providers import types back from `llm.ts`). With F4 run, `web/src/views` (home of `Chat.tsx`, score 100) is the darkest box.
- **ai_agent_oop:** 3 folders, `tests → (root)`, no cycles.
- Checked in a real browser (headless Edge) in light and dark themes, in the Architecture tab and the Report.

**Known limits:**
- Only Python and JS/TS, like the import graph.
- Type-only imports (`import type`) count as dependencies. That's why `llm.ts ⇄ llmGemini.ts` shows as a cycle even though it causes no problem when the code runs.
- No clicking on boxes yet (e.g. to list a folder's files); that would need Mermaid's less strict mode.

**Where the code is:**
| File | What changed |
|---|---|
| [server/src/architecture.ts](server/src/architecture.ts) | **New.** `moduleOf()`, `chooseDepth()`, `findCycles()`, `heatLevel()`, `toMermaid()`, `buildArchitecture()` |
| [server/src/app.ts](server/src/app.ts) | `GET /api/repos/:owner/:repo/architecture` |
| [server/src/report.ts](server/src/report.ts) | New `architectureSection()` with the Mermaid block and cycles |
| [server/tests/architecture.test.ts](server/tests/architecture.test.ts) | **New.** 9 tests: grouping, depth choice, cycles (including a 20,000-file chain), colours, Mermaid text, escaping |
| [server/tests/report.test.ts](server/tests/report.test.ts) | 2 tests for the new report section |
| [web/src/components/Architecture.tsx](web/src/components/Architecture.tsx) | **New.** The tab |
| [web/src/components/MermaidDiagram.tsx](web/src/components/MermaidDiagram.tsx) | **New.** Draws Mermaid text with zoom, follows the light/dark theme, loads Mermaid only when needed |
| [web/src/components/HealthReport.tsx](web/src/components/HealthReport.tsx) | ` ```mermaid ` blocks in the report are drawn as diagrams |
| [web/src/components/Hotspots.tsx](web/src/components/Hotspots.tsx) | `Stat` is exported so the Architecture tab reuses it |
| [web/src/views/Chat.tsx](web/src/views/Chat.tsx) | Fourth tab: **Chat \| Hotspots \| Architecture \| Report** |
| [web/src/api.ts](web/src/api.ts), [web/src/index.css](web/src/index.css) | API call and types; diagram, legend and cycle styles |
| [web/package.json](web/package.json) | Added `mermaid` |

**How to demo:** open a repo → **Hotspots** → **Analyse history** → **Architecture** → point out the coloured boxes and red arrows → click a cycle's example import to open that line on GitHub → **Report** → **Download .md**.


### Hidden coupling ✅ (Phase 4)

**What it does:** finds pairs of code files that keep changing in the same commit but **don't import each other**. Two files usually change together because one uses the other. When there's no import, something the code doesn't show ties them together: copied logic, a shared data format, an API and the code that calls it. Changing only one side can break the other.

Each pair is shown as:
- **⚠ No import link at all:** the most interesting kind, listed first.
- **Linked only indirectly:** no direct import, but a chain of imports connects them (e.g. `c.py → util.py → a.py`). The chain is shown.

It appears in the **Architecture** tab (a headline number plus a *Hidden coupling* section with GitHub links to both files) and in the **health report** (F5), under the architecture map.

**How it works** ([server/src/coupling.ts](server/src/coupling.ts)), with no AI:
1. Takes the "files that change together" pairs from F4 (at least 3 commits together).
2. Keeps only pairs where **both files are code in the import graph** (Python, JS/TS). A README or JSON file "not importing" anything means nothing.
3. Drops pairs with a direct import in either direction.
4. For the rest, `importPath()` looks for the shortest import chain either way (breadth-first search). Found → "indirect"; none → "no link at all".
5. Sorts "no link" first, then by how often they changed together, and shows the top 10.

**Change to F4:** the saved history used to keep only the top 10 pairs. The pairs that change together most usually import each other, so hidden ones were cut off. It now also keeps every pair (up to 200) in `coChangeAll`; the Hotspots tab still shows the top 10. History saved before this change still works, but only its top 10 can be checked, and the app says *"Run Analyse history again to check them all."*

**Tested on github-project (this app):** with the old top-10 list, 1 hidden pair; with the full list, 6 of 10 code pairs. The top one is `server/src/app.ts` ⇄ `web/src/api.ts` (5 times together, 71%): the server's API routes and the browser code that calls them, tied together only by URLs and data shapes. A real design point: a shared types file would make this link visible.

**Known limits:** only Python and JS/TS (like the import graph). Needs F4 to have been run. Pairs between a source file and its test that don't import each other (e.g. a route and an API test) can show up; they're real links, but less worrying.

**Where the code is:**
| File | What changed |
|---|---|
| [server/src/coupling.ts](server/src/coupling.ts) | **New.** `findHiddenCoupling()`, `importPath()` |
| [server/src/gitHistory.ts](server/src/gitHistory.ts) | Keeps every pair (up to 200) in `coChangeAll`, with a stable order for ties |
| [server/src/types.ts](server/src/types.ts) | `coChangeAll` on `HistoryReport`; new `HiddenCouplingPair`, `HiddenCoupling` |
| [server/src/architecture.ts](server/src/architecture.ts) | `hiddenCoupling` added to the architecture map (null if F4 hasn't been run) |
| [server/src/report.ts](server/src/report.ts) | New `hiddenCouplingLines()`, added to the architecture section |
| [server/tests/coupling.test.ts](server/tests/coupling.test.ts) | **New.** 7 tests: import chains, circular imports, direct links both ways, only code files, old history, the top-10 limit |
| [server/tests/gitHistory.test.ts](server/tests/gitHistory.test.ts), [server/tests/report.test.ts](server/tests/report.test.ts) | Tests for the full pair list and the report text |
| [web/src/api.ts](web/src/api.ts) | Types |
| [web/src/components/Architecture.tsx](web/src/components/Architecture.tsx) | Headline number and the *Hidden coupling* section |

**How to demo:** open a repo → **Hotspots** → **Analyse history** (run it again on repos analysed before today) → **Architecture** → scroll to *Hidden coupling* → click both files → **Report** → **Regenerate** to see it in the report.

### Ask about one folder ✅ (Phase 2)

**What it does:** a **Search in** box above the question box. Type or pick a folder (`server/src/`) or a single file (`web/src/api.ts`), and the next question only searches code inside it. Leave it empty to search the whole repo, as before. Each question shows a small *"in server/src"* tag, so it's clear afterwards where an answer came from.

**Why:** search gives the AI only the 8 best-matching chunks. In a big repo, a question about one area can pull in look-alike code from elsewhere. Limiting the search means all 8 chunks are about the area you care about. It also fits with Hotspots and Hidden coupling: spot a risky area there, then ask about just that folder.

**How it works:**
1. The picker's list comes from the index status: every folder that holds an indexed file, plus the files themselves (`listFolders()`).
2. The chat sends `{ question, depth, scope }`. The server tidies the path (`./server/src/` → `server/src`) and **checks it against the indexed files** (`resolveScope()`). Anything else, like a typo or `../../etc`, is rejected with *"… isn't a folder or file in this repo's index."* The browser runs the same check first and greys out Send, so this rarely reaches the server.
3. The search uses a LanceDB filter: `starts_with(path, 'server/src/')` for a folder, `path = '…'` for a file. `starts_with` is an exact prefix match. We didn't use SQL `LIKE`, because `_` is a wildcard there and folder names often contain it (`ai_agent_oop`). Quotes are escaped. The filter runs **before** the vector search, so a small folder still gets its 8 best chunks.
4. The AI is told: *"The user limited this question to the folder "server/src"… Focus your answer on this folder."* (`scopeNote()` in `prompts.ts`).
5. If a file is in the index but has no chunks (e.g. empty), the app says so instead of answering from nothing.

**Tested on github-project (Gemini):** scoped to `server/src/chunking/` → all 8 sources from that folder, answer only about chunking. Scoped to `web/src/api.ts` → all 8 sources from that file. `../../etc` → rejected with the message above.

**Follow-up suggestions stay in the folder (added after testing):** at first, the "Ask next" questions (F3) were about the whole repo even when a folder was picked, and clicking one asked it with the folder still selected. Now `answer()` returns the checked scope, and `suggestFollowUps()` tells the AI: *"Each must be about the folder "server/src/chunking" and answerable from the code in it."* Tested: scoped to `server/src/chunking`, all 3 suggestions were about chunking; scoped to `web/src/api.ts`, all 3 were about functions and types in that file.

**Known limits:** one folder or file at a time. The scope applies to the search only; the AI still sees the repo's file tree and README for context.

**Where the code is:**
| File | What changed |
|---|---|
| [server/src/scope.ts](server/src/scope.ts) | **New.** `normalizeScope()`, `listFolders()`, `resolveScope()`, `scopeFilter()` |
| [server/src/vectorStore.ts](server/src/vectorStore.ts) | `query()` takes an optional filter |
| [server/src/rag.ts](server/src/rag.ts) | `answer()` takes the scope, checks it, filters the search. `buildPrompt()` adds the scope note. |
| [server/src/prompts.ts](server/src/prompts.ts) | New `scopeNote()` |
| [server/src/app.ts](server/src/app.ts) | Chat route reads `scope`. Status route returns `folders` and `files` for the picker. |
| [server/tests/scope.test.ts](server/tests/scope.test.ts) | **New.** 9 tests: tidying, folder list, whole-name matching, bad and long paths, filter text, quote escaping |
| [server/tests/app.test.ts](server/tests/app.test.ts), [server/tests/rag.test.ts](server/tests/rag.test.ts) | The scope reaches `answer()` (non-text values are ignored); the AI is told about the folder |
| [web/src/api.ts](web/src/api.ts) | `streamChat()` sends `scope`; `folders`/`files` on the status; `scope` on questions |
| [web/src/views/Chat.tsx](web/src/views/Chat.tsx) | The *Search in* box with suggestions, clear button, typo warning, and the tag on each question |
| [web/src/index.css](web/src/index.css) | Styles for the box and tag |

**How to demo:** open a repo → Chat → in **Search in**, pick `server/src/chunking/` → ask *"How does it split code into chunks?"* → open *Sources*: every file is from that folder → clear the box (×) and ask again to compare.
