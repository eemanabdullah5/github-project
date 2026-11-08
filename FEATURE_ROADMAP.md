# FEATURE ROADMAP — GitHub Repository AI Assistant

**Last updated:** 2026-11-07
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
| **Verified citations** | Opus | S | After each answer, check that every `[path:Lx-Ly]` citation points to a real file and lines that were retrieved, and flag any that don't. |
| **Hybrid search** | Opus + Claude Code | S–M | Add LanceDB's built-in full-text search alongside vector search, so exact function and class names are always found. |
| **Evaluation harness** | Opus | M | Extend [server/scripts/evalRetrieval.ts](server/scripts/evalRetrieval.ts) with 30–50 questions per test repo. Measure file recall@8 and citation validity before and after every retrieval change. |
| **Ask about one folder** | Claude Code | S | Limit a question to a folder or file, such as `src/auth`. |

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
| **Import graph** | Opus | M | Which file imports which, from tree-sitter. Stored in SQLite. |
| **Architecture map** | Opus | M–L | A zoomable module diagram with hotspot overlay, plus cycle detection. |
| **Hidden coupling** | Opus | S (after the import graph) | Files that change together (from F4) but have no import between them. These are usually real design problems. |
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
