# PRD — GitHub Repository AI Assistant

**Status:** v1.1 draft. Waiting for Product Owner re-approval (v1.0 was approved).
**Delivery approach:** full MVP scope, estimated at 6–8 working days. The core RAG loop (ingest → retrieve → answer) is built and tested first. UI features follow.
**Last updated:** 2026-10-29
**Related:** [ARCHITECTURE.md](ARCHITECTURE.md) (v0.2)

### Changes since v1.0

- **Target users** are now CTOs, engineering leadership and managers. Developers are secondary users. Students are removed.
- **Private repositories are in scope.** Repos are listed from the GitHub token, so no username is needed. Users can also paste a repo URL.
- **Answers start with a summary.** Each answer opens with a plain-language summary, followed by the technical detail. This replaces the "beginner-friendly" style.
- **Stack:** Node.js + TypeScript instead of Python + Streamlit.
- **LLM:** self-hosted Qwen, so code never leaves company machines. This resolves the open LLM-provider item.

---

## 1. Overview

A locally run web application for engineering leadership. The app reads a GitHub token from the local `.env` file. It lists the repositories that token can access, public and private, including organisation repos. The user can also paste a repository URL. The user selects a repo, the app indexes its code, and a chatbot answers questions about it. Answers are based on the actual source code. Each one starts with a short plain-language summary, followed by the technical detail and file references.

All AI processing runs on a self-hosted Qwen model. Repository code is never sent to a third-party AI service.

## 2. Problem statement

CTOs and engineering managers often need to understand a codebase without reading it. Typical cases:
- assessing a project's health
- planning work
- estimating onboarding effort
- reviewing inherited or client code

Today that means asking engineers to explain it, which takes them away from their work, or reading files one at a time.

General-purpose chatbots don't know a specific repository's code and will often invent details about it. Company policy may also forbid sending private code to third-party AI services.

## 3. Target users

| User | Need |
|---|---|
| **CTO / VP Engineering (primary)** | Understand a codebase without reading it: architecture, tech stack, health, risks and tech debt. |
| **Engineering manager / tech lead** | Assess a repo before planning work, estimate onboarding effort, and find problem areas. |
| **Developer (secondary)** | Get oriented in an unfamiliar repo quickly and locate specific logic (e.g. "where is auth handled?"). |

## 4. User stories

1. As a user, I can see every repository my GitHub token can access, public and private. This includes my own repos, repos I collaborate on, and my organisations' repos. I don't need to enter a username.
2. As a user, I can paste a GitHub repository URL to open a repo directly, without browsing.
3. As a user, I can search, sort and filter the repository list to find a repo quickly, even when I can access hundreds of repos.
4. As a user, I can select any non-empty repository, including forks, and have it indexed for AI analysis.
5. As a user, I can see indexing progress and know when the repo is ready to chat with.
6. As a CTO or manager, I get a short plain-language summary first, with technical detail when I want it.
7. As an engineering manager, I can ask about a repo's architecture, tech stack, dependencies and risk areas.
8. As a developer, I can ask where specific logic lives and get file and line references.
9. As a returning user, I don't have to wait for a repo to be re-indexed if it hasn't changed.
10. As the company, we know our code is never sent to a third-party AI service.

## 5. Functional requirements

### FR-1 Repository discovery

- **FR-1.1** **Access:** the app uses a read-only, fine-grained GitHub Personal Access Token from `.env`. The token decides which repos are visible. The user does not enter a username or organisation name.
- **FR-1.2** The app lists **all repositories the token can access**: owned, collaborator, and organisation-member repos, both **public and private**. For each one it shows:
  - name and owner
  - description
  - primary language
  - star count
  - last-updated date
  - fork status (forks are clearly labelled)
  - visibility (a **Private** badge)
- **FR-1.3** **Paste a URL:** a single input accepts these formats:
  - `https://github.com/owner/repo`
  - `github.com/owner/repo`
  - `owner/repo`

  A trailing `.git` or extra path (e.g. `/tree/main`) is ignored. This works for any public repo, and for any private repo the token can access.
- **FR-1.4** **Search:** a search bar filters repositories by name or owner, without regard to letter case.
- **FR-1.5** **Sort:** by recently updated (default), most stars, or alphabetical (A–Z).
- **FR-1.6** **Filters:**
  - **Type:** all (default), original only, or forks only
  - **Visibility:** all (default), public, or private
  - **Owner:** all (default), or one user or organisation from the list
- **FR-1.7** Empty repositories are **hidden by default**. A toggle lets the user show them. Empty repos cannot be selected for analysis.
- **FR-1.8** **Large lists:** the app fetches all pages of repositories from the GitHub API (100 per request), up to a cap of 1,000 repositories. Search, sort and filters apply to the **full** fetched list, not just the visible page. The UI displays results in pages.
- **FR-1.9** Clear error messages for:
  - a missing or invalid token
  - a token that can access no repositories
  - a pasted repo that doesn't exist or isn't accessible (GitHub returns the same response for both, so the app shows one message)
  - GitHub rate limit reached
  - network failure

### FR-2 Repository ingestion

- **FR-2.1** Any non-empty repository the token can access can be selected, **including forks and private repos**. For a fork, the fork's own default-branch code is analysed.
- **FR-2.2** The repo's default branch is downloaded in a single operation (archive download), not file by file.
- **FR-2.3** **Size limit:** repos over ~1,000 source files or ~20 MB of indexable code are rejected with a clear message.
- **FR-2.4** **All languages are supported.** Files are treated as text and split into chunks. Each chunk keeps its file path and line numbers. The splitting method is an architecture decision (see ARCHITECTURE.md §7).
- **FR-2.5** **Excluded:** binaries, images, lock files, `node_modules`, virtual environments, build/dist output, minified files, and other generated or vendored files.
- **FR-2.6** **Included:** source code, config files, the README and documentation.
- **FR-2.7** **Progress:** the UI shows indexing progress and makes clear when the repo is ready. Indexing runs in the background on the server, so moving between views does not stop it.
- **FR-2.8** **Caching:** indexes are saved to disk and reused, together with the commit SHA they were built from.
- **FR-2.9** **Change detection:** when a previously indexed repo is selected, the app compares the stored commit SHA with the latest commit on the default branch. If they differ, the user is told the repo has changed and asked whether to re-index. Re-indexing never starts automatically.
- **FR-2.10** A manual **"Re-index"** button is always available.
- **FR-2.11** **Local AI processing:** embeddings and answers are produced by a self-hosted Qwen model. Repository code is not sent to any third-party AI service.

### FR-3 Chat

- **FR-3.1** The user can ask natural-language questions about the selected repository.
- **FR-3.2** **Citations:** every answer is based on retrieved code and cites the source files and line ranges it used.
- **FR-3.3** **Summary first:** every answer opens with a short, plain-language summary a non-specialist leader can follow. Technical detail follows: code snippets and file references. An Executive/Technical toggle is planned after the MVP (see §8).
- **FR-3.4** **Overview questions** use repository-level context: the README and file tree. Examples:
  - "What is this project about?"
  - "What is the tech stack?"
  - "How is it structured?"
  - "What does it depend on?"
- **FR-3.5** **Unanswerable questions:** if the indexed code doesn't contain the answer, the assistant says "I couldn't find this in the indexed code" instead of guessing.
- **FR-3.6** **Conversation memory:** follow-up questions take the last few exchanges into account (a short memory window, not the full history).
- **FR-3.7** **Streaming:** answers appear progressively as they are generated.
- **FR-3.8** **Code snippets:** answers include short, relevant code snippets with syntax highlighting.
- **FR-3.9** **Review and risk questions:**
  - The user can ask about bugs, risks or tech debt in specific files, functions or areas.
  - Whole-repo assessments (e.g. "What are the main risks in this repo?") get a best-effort answer. It states its limits first: it is based on the parts of the code that were retrieved, so it is not a full audit.

### FR-4 User experience

- **FR-4.1** **Two views:**
  - **Repo Browser:** the paste-URL input, search, sort, filters and the repo list.
  - **Chat:** repo name, index status, a "Back to repos" link, and the chat.
- **FR-4.2** **Indexing progress shows each step:** Downloading → Processing files (n / total) → Embedding (n / total) → Ready.
- **FR-4.3** **One active chat at a time.** Switching repos clears the current chat. Each repo's index stays cached on disk.
- **FR-4.4** **Chat is not saved between sessions in the MVP.** A "Clear chat" button resets the conversation.
- **FR-4.5** **Starter questions:** the chat view shows 4 clickable example questions:
  - "Summarise this project and its tech stack"
  - "How is it structured?"
  - "What external services does it depend on?"
  - "What are the main risks or tech debt?"
- **FR-4.6** **Light and dark themes:** a toggle in the app header. It defaults to the operating system's setting, and the browser remembers the user's choice.
- **FR-4.7** **One indexing job at a time.** Starting a second while one is running is blocked with a clear message.

## 6. Non-functional requirements

- **NFR-1 Simplicity:** the codebase stays small and readable enough for a junior engineer to fully understand. No unnecessary frameworks.
- **NFR-2 Runs locally** on a single Windows PC, for a single user. No accounts or authentication. The app is reachable only from the same machine (localhost).
- **NFR-3 Secrets:** the GitHub token lives in a local `.env` file and is never committed, logged or shown in the UI.
- **NFR-4 GitHub API efficiency:**
  - The token is a fine-grained PAT with read-only access (Contents: read, Metadata: read).
  - API calls are kept to a minimum: paginated listing, one archive download per index, one commit check per selection.
- **NFR-5 UI:** a clean, professional and responsive layout suitable for leadership users.
- **NFR-6 Performance targets** on the agreed hardware (see §10):
  - a repo list of up to 100 repos loads in under 5 s
  - a medium repo (~200 files) indexes in a few minutes
  - chat answers start within ~10 s
- **NFR-7 Language:** Node.js + TypeScript for the backend and the frontend.
- **NFR-8 Honest failure:** every error shown to the user explains what happened. No silent failures.
- **NFR-9 Data privacy:**
  - Repository code, embeddings and indexes stay on the local machine.
  - The only external services contacted at runtime are the GitHub API and the local model server.
- **NFR-10 Hardware:** the Qwen model runs locally, which needs a machine with a suitable GPU (see §10).

## 7. MVP scope

- Repository discovery: token-based listing (public and private), paste-a-URL, search, sort, filters, empty-repo hiding and full pagination (FR-1)
- Ingestion of one repo at a time, with background indexing, caching, change detection, manual re-index and local-only AI processing (FR-2)
- Chat with citations, summary-first answers, memory, streaming, code snippets, overview questions and scoped review/risk questions (FR-3)
- Two-view UI with step-by-step indexing progress, starter questions and a light/dark toggle (FR-4)

## 8. Out of scope (MVP)

- GitHub OAuth login or a GitHub App. The token is set in `.env`.
- Multiple users, accounts and online hosting
- Whole-repository bug or security audits. The assistant may review specific files or areas, with stated limits.
- Analysing branches other than the default branch
- Comparing or chatting across multiple repos at once
- Editing code, opening PRs or writing back to GitHub

**Planned after the MVP (committed, not optional):**
- Executive/Technical explanation-depth toggle
- Chat history saved between sessions. This needs a database, and an ERD will be drawn for it then.

## 9. Acceptance criteria (MVP)

1. With a valid token, the repo list shows every repo the token can access, public and private, including organisation repos, with all the fields in FR-1.2.
2. Pasting a repo URL in any supported format opens that repo. A repo that doesn't exist or isn't accessible shows a clear message.
3. When the token can access more than 100 repos, all of them are shown (up to the 1,000 cap). Search, sort and filters work across the full list.
4. Search, all three sort orders and all filters (type, visibility, owner) produce correct results. Empty repos are hidden unless the toggle is on.
5. A missing or invalid token shows a clear message. A rate-limit error shows a clear message.
6. A fork can be selected and indexed, and questions about it are answered like any other repo.
7. A private repo can be indexed and chatted with.
8. A repo over the size limit is rejected with a clear message.
9. Re-selecting an unchanged, already-indexed repo skips re-indexing. A repo with new commits triggers the change notice. "Re-index" rebuilds the index.
10. Asking "Which function handles X?" in a repo where X exists returns an answer that cites the correct file.
11. Asking about something not in the repo produces an "I couldn't find this in the code" response, not invented details.
12. Every answer opens with a short plain-language summary before the technical detail.
13. Every chat answer that refers to code lists its source files and line ranges.
14. A follow-up question ("where is that called?") is answered correctly using the previous exchange.
15. Answers stream progressively and render code snippets with syntax highlighting.
16. A whole-repo "what are the main risks?" request gets an answer that states its limits up front.
17. Indexing shows each step with a count. Moving to another view does not stop indexing. Starting a second indexing job while one is running is blocked.
18. Clicking a starter question sends it as a chat message.
19. "Clear chat" and switching repos both reset the conversation. The index is not rebuilt.
20. The light/dark toggle changes the theme in both views, and the choice is kept after a page reload.
21. No secrets appear in the source code, logs or UI.
22. During indexing and chat, the app makes no network requests to any host other than GitHub and the local model server. This is checked by monitoring network traffic during a test run.

## 10. Open items

- **Hardware for Qwen:** which machine runs the model (a developer laptop or a shared GPU workstation), and how much GPU memory it has. This decides the model size and whether NFR-6 can be met.
- **Qwen model size:** chosen once the hardware is known (see ARCHITECTURE.md §8).
- **Organisation token approval:** some GitHub organisations require an admin to approve fine-grained tokens before they can read org repos. Confirm this with the org admin.
- **Local storage of private code:** indexes in `data/` contain copies of private code. Confirm this is acceptable under company policy.
- **Product Owner re-approval** of this v1.1.
