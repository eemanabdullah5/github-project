# DECISIONS — GitHub Repository AI Assistant

This file records **why** each decision was made, so nobody has to guess later. The short summary table lives in [ARCHITECTURE.md §17](ARCHITECTURE.md#17-decision-log); this file has the reasoning.

**Statuses:** `Approved` · `Proposed` (waiting for agreement) · `Pending` (waiting for senior confirmation) · `Superseded` (replaced by a later decision)

**Adding a decision:** copy the template at the bottom and give it the next number. Never delete an old decision. If it changes, mark it `Superseded` and write a new one that links back to it.

---

## Summary

| # | Decision | Status | Date |
|---|---|---|---|
| D1 | Node.js + TypeScript (Express API + React UI) | Approved | 2026-10-29 |
| D2 | Light/dark toggle in the app header | Approved | 2026-10-29 |
| D3 | Self-hosted Qwen for chat | **Pending** | 2026-10-29 |
| D4 | Qwen embedding model for embeddings | **Pending** | 2026-10-29 |
| D5 | LanceDB as the vector database | Approved | 2026-10-29 |
| D6 | No LangChain or LlamaIndex | Approved | 2026-10-28 |
| D7 | Rewrite follow-up questions; always include README + file tree | Approved | 2026-10-28 |
| D8 | Hybrid chunking: tree-sitter + line fallback | **Proposed** | 2026-10-29 |
| D9 | List repos from the GitHub token; private repos; paste-a-URL | Approved | 2026-10-29 |
| D10 | No ERD for the MVP; a data model section instead | Approved | 2026-10-29 |
| D11 | Target users are CTOs and engineering leadership | Approved | 2026-10-29 |
| D12 | Answers start with a plain-language summary | Approved | 2026-10-29 |
| D13 | Ollama to run Qwen locally | **Pending** | 2026-10-29 |
| D14 | Local only, single user, no login | Approved | 2026-10-28 |
| D15 | Fine-grained GitHub token (not classic) | Approved for the MVP; org access **Pending** | 2026-10-29 |
| D16 | Switchable AI provider: Gemini API (used now) or local Ollama | **Proposed** | 2026-11-07 |

---

## D1 — Node.js + TypeScript (Express API + React UI)

- **Status:** Approved · **Date:** 2026-10-29 · **Supersedes:** Python + Streamlit (2026-10-28)
- **Context:** The target users changed to CTOs and management (D11), so the UI needs to look like a real product rather than an internal prototype.
- **Options considered:**
  1. Python + Streamlit: fastest to build, but looks like a prototype and offers limited control over the UI.
  2. Python FastAPI + React: a polished UI, but two languages to maintain.
  3. Node.js + TypeScript, Next.js: one language, but long-running indexing jobs are awkward in its request handlers.
  4. **Node.js + TypeScript, Express + React (chosen).**
- **Why:**
  - One language for the frontend and the backend.
  - Full control over the UI.
  - Express handles a background indexing job simply.
  - tree-sitter works in Node and covers many languages (see D8).
- **Consequences:**
  - About 2–3 extra days, because streaming, progress display and the theme toggle are now built by hand.
  - Indexing keeps running when the user changes views.

## D2 — Light/dark toggle in the app header

- **Status:** Approved · **Date:** 2026-10-29 · **Supersedes:** Streamlit's built-in Settings menu (2026-10-28)
- **Context:** Without Streamlit, there's no built-in theme menu.
- **Decision:** a toggle in the header using CSS variables. It defaults to the operating system's setting, and the choice is saved in `localStorage`.
- **Why:** it's simple, and users expect a visible toggle in a polished product.

## D3 — Self-hosted Qwen for chat

- **Status:** **Pending: needs senior confirmation** · **Date:** 2026-10-29 · **Supersedes:** Gemini Flash (2026-10-28)
- **Context:** private company repos are in scope (D9). Sending private code to a third-party AI service may break company policy.
- **Options considered:**
  1. Google Gemini: strong, fast and simple, but code is sent to Google, and the free tier may use it for training.
  2. **Qwen, self-hosted (chosen).**
  3. Qwen through a hosted API (Alibaba Cloud, OpenRouter): fast, but code leaves the machine, so this has the same problem as option 1.
- **Why:** code never leaves company machines, which makes private repos safe to analyse.
- **Consequences:**
  - Speed and answer quality depend on local hardware. The development laptop has no dedicated GPU, so models must be small and answers will be slow during development.
  - Only `llm.ts` talks to the model, so the provider can be changed later in one file.
- **Open question for seniors:** is self-hosted Qwen approved, and on what hardware will it run?

## D4 — Qwen embedding model for embeddings

- **Status:** **Pending: needs senior confirmation** (decided together with D3) · **Date:** 2026-10-29 · **Supersedes:** the Gemini embedding API (2026-10-28)
- **Decision:** use a Qwen3-Embedding model, running locally.
- **Why:**
  - Same reason as D3: code never leaves the machine.
  - The small version (0.6B) runs acceptably without a GPU.
- **Consequences:** changing the embedding model later means re-indexing every repo. The manifest records `embedModel`, so the app detects this automatically.

## D5 — LanceDB as the vector database

- **Status:** Approved · **Date:** 2026-10-29 · **Supersedes:** ChromaDB (2026-10-28)
- **Context:** ChromaDB's JavaScript client needs a separate Chroma server running.
- **Options considered:**
  1. ChromaDB: an extra server process to install and run.
  2. **LanceDB (chosen):** runs inside the Node process and stores data on disk.
  3. Plain in-memory cosine search: fine for 1,000 files, but it means writing our own storage.
- **Why:** no extra server, data saved to disk, and simple to use.
- **Consequences:** one table per repo, stored in `data/lancedb/`.

## D6 — No LangChain or LlamaIndex

- **Status:** Approved · **Date:** 2026-10-28
- **Why:**
  - The pipeline has only a few steps, and calling the libraries directly keeps each step visible and easy to debug.
  - Frameworks add layers a junior engineer would have to learn first (PRD NFR-1).
- **Consequences:** we write a little more code ourselves, such as prompt building and batching.

## D7 — Rewrite follow-up questions; always include README + file tree

- **Status:** Approved · **Date:** 2026-10-28
- **Context:**
  - A follow-up like "where is *that* called?" can't be searched on its own.
  - Overview questions ("what is this project?") don't match any single code chunk.
- **Decision:**
  - When there is chat history, one short LLM call rewrites the question into a standalone search query.
  - The README and file tree are added to every prompt.
- **Consequences:** one extra LLM call for follow-up questions, which makes them slower on a CPU-only machine.

## D8 — Hybrid chunking: tree-sitter + line fallback

- **Status:** **Proposed: waiting for agreement** · **Date:** 2026-10-29
- **Context:** splitting code by fixed line counts can cut a function in half, which hurts retrieval.
- **Decision (proposed):**
  - tree-sitter splits Python, JS/TS, Java and Go by function and class.
  - Every other file is split by lines.
- **Why:** whole functions make better search results, and tree-sitter supports many languages from Node.
- **How we'll decide:** compare retrieval quality (hit@8) with and without tree-sitter on 2 repos (ARCHITECTURE §16).
- **Consequences:** about 1 extra day. This can be moved to after the MVP, because line chunking already meets the PRD.

## D9 — List repos from the GitHub token; private repos; paste-a-URL

- **Status:** Approved · **Date:** 2026-10-29 · **Supersedes:** typing a username to list public repos (2026-10-28)
- **Context:** the lead questioned whether a username is needed. On checking:
  - The old endpoint (`/users/{name}/repos`) only returns **public** repos.
  - With a token, `/user/repos` returns every repo the token can access, public and private, without a username.
- **Decision:**
  - List repos from the token.
  - Support private repos.
  - Add a paste-a-URL input for opening one repo directly.
  - Use a **fine-grained, read-only** token (Contents + Metadata).
- **Why:** an internal company tool mostly needs private org repos. Classic tokens need the `repo` scope for private repos, and that scope also grants write access.
- **Consequences:**
  - Copies of private code are stored in `data/`.
  - Some organisations require an admin to approve fine-grained tokens.
  - A fine-grained token covers **one resource owner** (one user or one org), so a single list of "own + collaborator + org" repos isn't possible with one token. See D15.

## D10 — No ERD for the MVP; a data model section instead

- **Status:** Approved · **Date:** 2026-10-29
- **Context:** the MVP has no relational database, only LanceDB tables, JSON manifests and in-memory state.
- **Decision:** document the data in ARCHITECTURE §9 (a small diagram, plus where each kind of data lives and for how long). Draw a proper ERD once chat history is saved after the MVP, because that needs a real database.

## D11 — Target users are CTOs and engineering leadership

- **Status:** Approved · **Date:** 2026-10-29 · **Supersedes:** developers and students (2026-10-28)
- **Context:** the product is for our IT company, and the lead set leadership as the audience.
- **Decision:**
  - **Primary user:** CTO / VP Engineering.
  - **Next:** engineering managers and tech leads.
  - **Secondary:** developers.
  - Students are removed.
- **Consequences:** this changes the answer style (D12), the starter questions, and the post-MVP toggle (now Executive/Technical).

## D12 — Answers start with a plain-language summary

- **Status:** Approved · **Date:** 2026-10-29 · **Supersedes:** a "beginner-friendly" style (2026-10-28)
- **Why:** leaders want the conclusion first. Developers still get the code and file references below the summary.
- **Consequences:** the system prompt asks for a 2–3 sentence summary first. Checked by PRD acceptance criterion 12.

## D13 — Ollama to run Qwen locally

- **Status:** **Pending: needs senior confirmation** (depends on D3) · **Date:** 2026-10-29
- **Options considered:**
  1. **Ollama (chosen):** the easiest to set up, with the most guides.
  2. LM Studio: a desktop app with a GUI and a local server.
  3. llama.cpp server: more control, more setup.
  4. node-llama-cpp: runs the model inside the Node app.
  5. vLLM: needs an NVIDIA GPU, so it isn't possible on the development laptop.
- **Why:** simplest for a first build. All of these run at similar speed on the same hardware.
- **Consequences:** Ollama must be installed and running, with both models pulled, before the app can index or answer.

## D14 — Local only, single user, no login

- **Status:** Approved · **Date:** 2026-10-28
- **Why:** the MVP's goal is to prove the idea. Login, multiple users and hosting would add a lot of work for no benefit at this stage.
- **Consequences:** the server binds to `127.0.0.1` so other machines can't reach an app that has no login. Multi-user support is out of scope (PRD §8).

## D15 — Fine-grained GitHub token (not classic)

- **Status:** Approved for the MVP · **Pending:** how to access company org repos · **Date:** 2026-10-29
- **Context:** the app needs to read private repos. GitHub offers two kinds of Personal Access Token, and they differ a lot in what they allow.

**Fine-grained token**

| Pros | Cons |
|---|---|
| Can be **read-only** (Contents: Read, Metadata: Read). The app can't change anything. | Covers **one resource owner** only (your account *or* one org), so there's no single list across all your repos. |
| Limited to one owner, and optionally to selected repos, so a leaked token exposes less. | Repos owned by other people (where you're a collaborator) aren't included. |
| Org admins can see, approve and revoke these tokens, and can set a maximum lifetime. | An org may need an admin to **approve** the token, which can take time. |
| Can still read any **public** repo, so paste-a-URL works for public repos. | Slightly more options to set up. |
| GitHub's recommended token type. | |

**Classic token**

| Pros | Cons |
|---|---|
| One token covers **everything** you can access (own repos, collaborator repos, all your orgs), so the single list works. | **No read-only option for private repos.** The `repo` scope gives full **read and write** access: pushing code, deleting branches, changing settings. |
| Quick to create, with no approval step (orgs using SSO still need the token authorised). | It applies to **every** repo and org you belong to, so a leaked token could change or delete company code. |
| Works with every GitHub API. | Many organisations **block** classic tokens. |
| | Can't be limited to particular repos. GitHub recommends fine-grained tokens instead. |

- **Decision:** use a fine-grained token with **All repositories**, **Contents: Read-only** and **Metadata: Read-only**, for your own account.
- **Why:**
  - The app only reads code, so write access is unnecessary risk.
  - For the MVP, our own repos plus public repos (through paste-a-URL) are enough to build and test everything.
- **Consequences:**
  - The repo list shows one owner's repos per token.
  - Company org repos need a separate decision (below).
- **Open question for seniors:** how should the app access company org repos?
  1. A fine-grained token with the org as owner (simplest; may need admin approval)
  2. Several fine-grained tokens merged into one list (a little more code)
  3. A GitHub App (the proper long-term solution, more setup, out of scope for the MVP)
  4. A classic token (works, but has write access; only with explicit approval)

## D16 — Switchable AI provider: Gemini API (used now) or local Ollama

- **Status:** **Proposed** · **Date:** 2026-11-07 · **Related:** D3, D4, D13 (still pending)
- **Context:** Qwen on Ollama is very slow on a laptop with no graphics card, and D3/D4/D13 are still waiting for senior confirmation. Development needs a fast model now.
- **Options considered:**
  1. Keep Ollama only: code stays local, but too slow to develop and demo with on current hardware.
  2. Replace Ollama with the Gemini API: fast, but switching back to local Qwen later means rewriting the LLM code.
  3. Support both, picked with `LLM_PROVIDER` in `.env`: a little more code, either can be used.
- **Decision:** option 3. `LLM_PROVIDER=gemini` is the default for now, with `gemini-3.6-flash` for chat and `gemini-embedding-001` for embeddings.
- **Why:**
  - Gemini is fast without a GPU.
  - Keeping Ollama means the local-only setup can come back by changing one setting, if seniors require it.
  - Each provider lives in its own file (`llmGemini.ts`, `llmOllama.ts`) behind `llm.ts`, so the rest of the app doesn't change.
- **Consequences:**
  - **Privacy:** with Gemini, code chunks from indexed repos (including **private** repos) and questions are sent to Google. While Gemini is used, this breaks PRD FR-2.11, NFR-9 and acceptance criterion 22. **Needs senior approval before use with company code.**
  - A Gemini API key (`GEMINI_API_KEY`) is needed. Free-tier rate limits can slow indexing of large repos; the app waits and retries.
  - Indexes built with one provider's embedding model show as **stale** under the other, so switching means re-indexing.

---

## Template

```markdown
## DXX — <short title>

- **Status:** Proposed · **Date:** YYYY-MM-DD · **Supersedes:** <D-number, if any>
- **Context:** <what problem or question led to this>
- **Options considered:**
  1. <option>: <main pro / con>
  2. <option>: <main pro / con>
- **Decision:** <what we chose>
- **Why:** <the main reasons>
- **Consequences:** <what this makes easier or harder>
```
