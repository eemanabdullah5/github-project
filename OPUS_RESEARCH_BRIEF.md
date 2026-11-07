# Research brief: next features for the GitHub Repository AI Assistant

## Your role

You are a **senior product strategist and staff engineer** advising a junior developer who is building this app on their own. Your job is to research and recommend the **next features** to build after the MVP.

How to work:
- Think like the target users: **CTOs, VPs of Engineering and engineering managers** who need to understand a codebase without reading it. Developers are secondary users.
- Look at comparable tools and what users of AI code assistants value. Base ideas on real user needs, not on what is technically interesting.
- Be realistic about effort. One junior developer builds and maintains this, and the code must stay simple enough for a junior engineer to understand fully.
- Challenge my ideas below if they are weak, and add better ones. Don't just agree with them.
- If something important is unclear, list it as a question rather than guessing.

---

## The project

### What it is

A web app that runs locally on one machine for one user. It reads a GitHub token from a local `.env` file and lists every repository that token can access, public and private. The user can also paste a repo URL. The user picks a repo, the app downloads and indexes its code, and a chatbot answers questions about it.

Each answer:
- starts with a 2–3 sentence plain-language summary a non-technical leader can follow
- then gives technical detail and short code snippets
- cites the files and line ranges it used
- says "I couldn't find this in the indexed code" instead of guessing

### Why it exists

Leaders need to assess a codebase's health, plan work, estimate onboarding effort, or review inherited or client code. Today that means pulling engineers away from their work, or reading files one at a time. General chatbots don't know a specific repo and tend to make up details about it. Company policy may also forbid sending private code to third-party AI services.

### Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript on Node.js 22+ |
| Backend | Express 5 (HTTP API, background indexing job, streamed answers) |
| Frontend | React 19 + Vite, plain CSS with variables, no UI library |
| Zip reading | `fflate` (in memory, nothing written to disk) |
| Chunking | `web-tree-sitter` for Python, JS, TS/TSX, Java and Go (splits by function and class); line-based chunks for everything else |
| Vector database | LanceDB, embedded, one table per repo, stored in `data/` |
| AI | Switchable with `LLM_PROVIDER` in `.env`: **Gemini API** (default for now: `gemini-3.6-flash` for chat, `gemini-embedding-001` for embeddings) or **Qwen on Ollama** (local, but slow without a GPU) |
| Answer display | `react-markdown` + `rehype-highlight`, with raw HTML disabled |
| Tests | `vitest`, 100 unit tests |

Design rules the project follows:
- **No RAG frameworks** (no LangChain or LlamaIndex). The pipeline calls the libraries directly, so every step stays visible.
- **Each outside service sits behind one file.** `githubClient.ts` is the only file that talks to GitHub, `llmGemini.ts` the only one for Gemini, `llmOllama.ts` the only one for Ollama, and `vectorStore.ts` the only one for LanceDB.
- **Logic modules never import Express.** Route handlers are thin wrappers around them.
- **Simple over clever.** No state-management library and no relational database.

### How it works

1. **Repo list:** fetches up to 1,000 repos from GitHub's `/user/repos`. Search, sort, filters (type, visibility, owner), a "show empty repos" toggle and paging all run in the browser.
2. **Indexing** runs as a background job, one at a time, with progress shown in the UI:
   - Download the repo's zip for the latest commit on the default branch.
   - Skip dependencies, build output, lock files, binaries, minified files and files over 500 KB.
   - Reject repos over 1,000 files or 20 MB of code.
   - Split the code into chunks of at most about 800 tokens. Each chunk starts with a header naming the file, the symbol and the lines.
   - Embed the chunks and save them to LanceDB. A "manifest" file records the commit SHA and the embedding model.
3. **Caching:** when a repo is selected again, the app compares the saved commit SHA with GitHub's latest. If they match, the chat opens straight away. If they differ, the app asks "Re-index?". It never re-indexes automatically.
4. **Answering:**
   - Follow-up questions are rewritten into standalone questions using the chat history.
   - The 8 most similar chunks are retrieved.
   - The prompt holds: the rules, the file tree, the README, the chunks (inside delimiters, treated as data, not instructions), the last 3 exchanges and the question.
   - The answer streams to the browser token by token, with a collapsible Sources list.
5. **UI:** two views, the Repo Browser and the Chat. The chat has starter questions, Clear chat, Re-index and a light/dark theme toggle that remembers the choice.

### What is done

- **Phases 1–10 of the implementation plan are built:** setup, GitHub client, ingestion, chunking, embeddings and indexer, answering, HTTP API, both UI views, theme and README, and tree-sitter chunking.
- **The Gemini/Ollama switch was added after that.** Ollama was too slow on a laptop with no GPU.
- **Checked so far:**
  - All 100 unit tests pass, and both apps typecheck and build.
  - The real GitHub token lists all 24 of the user's repos (17 public, 7 private).
  - The real Gemini key works with both models.
- **Not yet done:**
  - A full index-and-chat run in the browser.
  - Phase 11 (walking through all 22 PRD acceptance criteria).
  - The retrieval-quality comparison of tree-sitter versus line-only chunking.

### Decisions still open

- **Privacy versus speed:**
  - The original plan promises that code never leaves the machine (local Qwen on Ollama).
  - Gemini, used for now for speed, sends indexed code, including private repos, to Google.
  - Seniors have not yet confirmed either the local model or the use of Gemini. Feature ideas should work with **both** providers, or say clearly which one they need.
- **Org repo access:** a fine-grained GitHub token covers only one owner (a user or one org). How to reach company org repos is undecided. The options are an org-owned token, several tokens, a GitHub App, or a classic token.
- **Hardware:** which machine would run a local model, and how big a model it can handle.

### Known limitations

- Pure vector search can miss exact identifiers such as function names. Symbol names in chunk headers help, but there is no keyword search.
- Only the default branch can be analysed.
- One repo at a time: no comparing or chatting across repos.
- Chat history is lost when the user clears the chat, switches repo or reloads the page.
- Whole-repo "risk" answers are based only on the 8 retrieved chunks, not a full audit.
- Restarting the server mid-index loses the job.
- No login. The app is single-user and reachable only from the same machine.

### Already committed to after the MVP

- **An Executive/Technical toggle** that controls how deep answers go.
- **Saved chat history** between sessions. This will need a database.

### Out of scope

- OAuth login or a GitHub App for the MVP
- Multiple users or online hosting
- Writing back to GitHub: editing code or opening PRs

---

## My initial feature ideas (please evaluate, rank, and improve on these)

1. **Executive/Technical toggle** (already committed): one switch that changes how much technical detail answers include.
2. **Saved chat history:** keep conversations per repo across sessions, for example with SQLite.
3. **One-click repo report:** a structured "health report" for leaders covering purpose, tech stack, architecture, dependencies, test coverage signals, risk areas and onboarding effort. It could be exported as Markdown or PDF to share.
4. **Clickable sources:** each cited file and line range links to GitHub at the exact indexed commit, or opens an in-app code preview.
5. **Hybrid search:** add keyword search (BM25 or full-text) alongside vector search, so exact function and class names are found reliably.
6. **Dependency and tech-stack scan:** read `package.json`, `requirements.txt`, `go.mod`, `pom.xml` and similar files directly. This gives exact versions and lets the app flag outdated or risky packages, without relying on the AI.
7. **Ask about part of the repo:** limit a question to a folder or file, such as "only `src/auth`".
8. **Incremental re-index:** when a repo has new commits, re-embed only the files that changed. This saves time, and Gemini cost.
9. **Org repo access:** support several tokens, or an org-owned token, so company repos show up in one list.
10. **Suggested follow-up questions** after each answer, to help non-technical users explore.
11. **Usage and cost display** for Gemini: tokens used per answer and per index.
12. **Branch selection:** analyse a branch other than the default one.

---

## What I want from you

1. **Research:** briefly, what do comparable tools do well or badly for this kind of user? Examples include Sourcegraph Cody, GitHub Copilot Chat, Cursor, Greptile, CodeRabbit and Swimm. What do engineering leaders actually ask about a codebase?
2. **Ranked feature list** of 8–12 features, mixing my ideas and yours. For each one give:
   - what it is, in 1–2 sentences
   - which user need it serves, and why a CTO or engineering manager would care
   - **effort**: S (under 1 day), M (1–3 days) or L (over 3 days), for one junior developer on this stack
   - how it fits the architecture: which modules change, and whether it needs anything new such as a database or library
   - whether it works with both the Gemini and Ollama providers, and any privacy concerns
   - risks or open questions
3. **A recommended order:** the next 3–5 features to build first, and why. Prefer high impact for leaders and low complexity.
4. **What not to build:** ideas that sound good but don't fit this product, its users or its simplicity rule, and why.
5. **Questions** I should answer, or ask my seniors, before building.

Keep the answer practical and concise. Use tables where they help. Avoid suggestions that need heavy frameworks or a big rewrite.
