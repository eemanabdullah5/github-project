# PRD — GitHub Repository AI Assistant

**Status:** v1.0, approved by the Product Owner.
**Delivery approach:** full MVP scope, estimated at 4–5 working days. The core RAG loop (ingest → retrieve → answer) is built and tested first. UI features follow.
**Last updated:** 2026-10-28

---

## 1. Overview

A locally run web application. The user enters a GitHub username or organisation name, browses its public repositories, and selects one. The app indexes that repository's code and provides a chatbot that answers questions about it. Answers are based on the actual source code and explained clearly enough for students to follow.

## 2. Problem statement

Understanding an unfamiliar codebase is slow. Developers and students have to work out the structure, find where features are implemented and follow how modules connect, usually by reading files one at a time. General-purpose chatbots don't know a specific repository's code and will often invent details about it.

## 3. Target users

| User | Need |
|---|---|
| **Developer** | Get oriented in an unfamiliar repo quickly and locate specific logic (e.g. "where is auth handled?"). |
| **Student** | Understand how a real project is built, with explanations in plain language. |

## 4. User stories

1. As a user, I can enter a GitHub username or organisation name and see its public repositories.
2. As a user, I can search, sort and filter the repository list to find a repo quickly, even for accounts with hundreds of repos.
3. As a user, I can select any non-empty repository, including forks, and have it indexed for AI analysis.
4. As a user, I can see indexing progress and know when the repo is ready to chat with.
5. As a user, I can ask questions about the repo and get answers based on its code.
6. As a student, I get explanations that are clear and beginner-friendly.
7. As a returning user, I don't have to wait for a repo to be re-indexed if it hasn't changed.

## 5. Functional requirements

### FR-1 Repository discovery

- **FR-1.1** The user can enter a GitHub username **or organisation name**.
- **FR-1.2** The app lists the account's **public** repositories. For each one it shows:
  - name
  - description
  - primary language
  - star count
  - last-updated date
  - fork status (forks are clearly labelled)
- **FR-1.3** **Search:** A search bar filters repositories by name, without regard to letter case.
- **FR-1.4** **Sort:** by recently updated (default), most stars, or alphabetical (A–Z).
- **FR-1.5** **Filter:** all repositories (default), original repositories only, or forks only.
- **FR-1.6** Empty repositories are **hidden by default**. A toggle lets the user show them. Empty repos cannot be selected for analysis.
- **FR-1.7** **Large accounts:** the app fetches all pages of repositories from the GitHub API (100 per request), up to a cap of 1,000 repositories. Search, sort and filter apply to the **full** fetched list, not just the visible page. The UI displays results in pages or uses "Load more".
- **FR-1.8** Clear error messages for: user/org not found, an account with no public repos, GitHub rate limit reached, and network failure.

### FR-2 Repository ingestion

- **FR-2.1** Any non-empty public repository can be selected, **including forks**. For a fork, the fork's own default-branch code is analysed.
- **FR-2.2** The repo's default branch is downloaded in a single operation (archive download), not file by file.
- **FR-2.3** **Size limit:** repos over ~1,000 source files or ~20 MB of indexable code are rejected with a clear message.
- **FR-2.4** **All languages are supported.** Files are treated as text and split into chunks by line ranges with overlap. Each chunk keeps its file path and line numbers.
- **FR-2.5** **Excluded:** binaries, images, lock files, `node_modules`, virtual environments, build/dist output, minified files, and other generated or vendored files.
- **FR-2.6** **Included:** source code, config files, the README and documentation.
- **FR-2.7** The UI shows indexing progress and makes clear when the repo is ready.
- **FR-2.8** **Caching:** indexes are saved to disk and reused, together with the commit SHA they were built from.
- **FR-2.9** **Change detection:** when a previously indexed repo is selected, the app compares the stored commit SHA with the latest commit on the default branch. If they differ, the user is told the repo has changed and asked whether to re-index. Re-indexing never starts automatically.
- **FR-2.10** A manual **"Re-index"** button is always available.

### FR-3 Chat

- **FR-3.1** The user can ask natural-language questions about the selected repository.
- **FR-3.2** **Citations:** every answer is based on retrieved code and cites the source files and line ranges it used.
- **FR-3.3** **Explanation style:** a single style for the MVP that is clear and beginner-friendly without being condescending. A Beginner/Expert toggle is planned after the MVP (see §8).
- **FR-3.4** **Overview questions** ("What is this project about?", "Explain the architecture") use repository-level context: the README and file tree.
- **FR-3.5** **Unanswerable questions:** if the indexed code doesn't contain the answer, the assistant says "I couldn't find this in the indexed code" instead of guessing.
- **FR-3.6** **Conversation memory:** follow-up questions take the last few exchanges into account (a short memory window, not the full history).
- **FR-3.7** **Streaming:** answers appear progressively as they are generated.
- **FR-3.8** **Code snippets:** answers include short, relevant code snippets with syntax highlighting.
- **FR-3.9** **Code review:** the user can ask for bugs or improvements in specific files or functions. Requests to review the whole repo get a best-effort answer that states its limits first: only part of the code was reviewed, so the answer is not a full audit.

### FR-4 User experience

- **FR-4.1** **Two views:**
  - **Repo Browser:** username input, search, sort, filter, and the repo list.
  - **Chat:** repo name, index status, a "Back to repos" link, and the chat.
- **FR-4.2** **Indexing progress shows each step:** Downloading → Processing files (n / total) → Embedding → Ready.
- **FR-4.3** **One active chat at a time.** Switching repos clears the current chat. Each repo's index stays cached on disk.
- **FR-4.4** **Chat is not saved between sessions in the MVP.** A "Clear chat" button resets the conversation.
- **FR-4.5** **Starter questions:** the chat view shows 3–4 clickable example questions (e.g. "What is this project about?", "Explain the architecture").
- **FR-4.6** **Light and dark themes**, switched in the UI framework's built-in Settings menu. A custom in-page toggle is not part of the MVP.
- **FR-4.7** **One indexing job at a time.** Starting a second while one is running is blocked with a clear message.

## 6. Non-functional requirements

- **NFR-1 Simplicity:** the codebase stays small and readable enough for a junior engineer to fully understand. No unnecessary frameworks.
- **NFR-2 Runs locally** on a single Windows PC, for a single user. No accounts or authentication.
- **NFR-3 Secrets:** the GitHub token and LLM API key live in a local `.env` file and are never committed or logged.
- **NFR-4 GitHub API efficiency:** an authenticated, read-only Personal Access Token is used. API calls are kept to a minimum: paginated listing, one archive download per index, one commit check per selection.
- **NFR-5 UI:** clean, simple, responsive layout.
- **NFR-6 Performance targets:**
  - repo list for an account with fewer than 100 repos loads in under 5 s
  - a medium repo (~200 files) indexes in a few minutes
  - chat answers start within ~10 s
- **NFR-7 Language:** backend and AI logic are written in Python.
- **NFR-8 Honest failure:** every error shown to the user explains what happened. No silent failures.

## 7. MVP scope

- Repository discovery with search, sort, filter, empty-repo hiding and full pagination (FR-1)
- Ingestion of one repo at a time, with caching, change detection and manual re-index (FR-2)
- Chat with citations, memory, streaming, code snippets, beginner-friendly explanations and repo-overview support (FR-3)
- Two-view UI with step-by-step indexing progress, starter questions and light/dark themes (FR-4)

## 8. Out of scope (MVP)

- Private repositories and GitHub OAuth login
- Multiple users, accounts and online hosting
- Whole-repository bug or security audits. The assistant may review specific files or functions the user names, with stated limits.
- Chunking that understands each language's syntax (split by function or class)
- Analysing branches other than the default branch
- Comparing or chatting across multiple repos at once
- Editing code, opening PRs or writing back to GitHub

**Planned after the MVP (committed, not optional):**
- Beginner/Expert explanation-depth toggle
- Chat history saved between sessions

## 9. Acceptance criteria (MVP)

1. Entering a valid username **or** organisation name lists its public repos with all the fields in FR-1.2.
2. An account with more than 100 public repos shows all of them (up to the 1,000 cap). Search, sort and filter work across the full list.
3. Search, all three sort orders and all three filter modes produce correct results. Empty repos are hidden unless the toggle is on.
4. An invalid username shows a clear "not found" message. A rate-limit error shows a clear message.
5. A fork can be selected and indexed, and questions about it are answered like any other repo.
6. A repo over the size limit is rejected with a clear message.
7. Re-selecting an unchanged, already-indexed repo skips re-indexing. A repo with new commits triggers the change notice. "Re-index" rebuilds the index.
8. Asking "Which function handles X?" in a repo where X exists returns an answer that cites the correct file.
9. Asking about something not in the repo produces an "I couldn't find this in the code" response, not invented details.
10. No secrets appear in the source code, logs or UI.
11. Every chat answer that refers to code lists its source files and line ranges.
12. A follow-up question ("where is that called?") is answered correctly using the previous exchange.
13. Answers stream progressively and render code snippets with syntax highlighting.
14. A whole-repo "find all bugs" request gets an answer that states its limits up front.
15. Indexing shows each step with a file count. Starting a second indexing job while one is running is blocked.
16. Clicking a starter question sends it as a chat message.
17. "Clear chat" and switching repos both reset the conversation. The index is not rebuilt.
18. Switching between light and dark in the Settings menu changes the theme in both views.

## 10. Open items

- **LLM provider:** Groq or Gemini (Google AI Studio). To be decided in ARCHITECTURE.md, as it's an architecture decision.
