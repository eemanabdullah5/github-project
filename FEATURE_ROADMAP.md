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
| F2 | **Executive / Technical toggle**: short leader answers or detailed developer answers | PRD | S | Planned |
| F3 | **Suggested follow-up questions** after each answer | Claude Code | S | Planned |
| F4 | **Git history hotspots**: which files change most, how complex they are, which files change together, and which areas only one person works on | Opus + Claude Code | M | Planned |
| F5 | **Repo health report**: one click gives a summary, tech stack, structure, dependencies, hotspots and risks, downloadable as Markdown | Claude Code + Opus | M | Planned |

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
