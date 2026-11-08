# UI brief: GitHub Repository AI Assistant

Use this brief to redesign the web app's interface. It describes every screen, what it shows, its states, the data it receives, and the behaviour that must keep working.

**How to use it with v0 (or a similar tool):** paste the sections **1–5** once as context, then ask for **one screen at a time** (section 6). Each screen should come back as a single React component with the same name and props as listed.

---

## 1. The product

A web app that runs on the user's own computer. It lists the GitHub repositories the user can access, indexes one, and lets them:
- **chat** with the code (answers cite the files they used)
- see **hotspots** from the git history (files that change often and are complex)
- generate a one-page **health report**

**Users:** CTOs, VPs of Engineering and engineering managers who need to understand a codebase without reading it. Developers are secondary users.

## 2. Design direction

- **Calm, professional, trustworthy.** A tool a CTO would show in a meeting. Think GitHub, Linear or Vercel's dashboard: clean, quiet, information-dense but easy to scan.
- **Avoid the generic "AI app" look:** no gradients, no glowing purple, no sparkle icons, no emoji, no oversized hero text, no rounded-everything bubbles.
- **Typography does the work:** clear hierarchy, comfortable line length for answers (about 70–80 characters), monospace for file paths and code.
- **One accent colour** for primary actions and links. Everything else neutral.
- **Light and dark themes**, both first-class, not an automatic colour flip.
- Desktop first (laptop screens around 1280–1440 px wide), but nothing should break at 768 px.

## 3. Technical constraints (important)

| Rule | Why |
|---|---|
| **React 19 + Vite + TypeScript.** Plain React components. **Not Next.js**: no `"use client"`, no `next/link`, no `next/image`, no server components, no app router. | The app is a Vite single-page app |
| **Tailwind CSS + shadcn/ui** components are fine. Icons from **lucide-react**. | Bundled with the app |
| **No external network requests from the UI:** no Google Fonts, no CDN scripts or styles, no remote images, no analytics. Use system fonts or fonts bundled with the app. | Privacy requirement: the app must only talk to its own local server |
| **Markdown is rendered with `react-markdown` + `rehype-highlight`**, never with raw HTML (no `rehype-raw`, no `dangerouslySetInnerHTML`) | AI output must never be able to inject HTML or scripts |
| Every link to GitHub opens in a **new tab** with `rel="noopener noreferrer"` | Keeps the app open |
| Don't fetch data or invent API calls. Use the props and the API functions listed in section 5. Mock data for previews must match the types in section 4. | The data layer already exists and is tested |
| Accessible: real `<button>`s and `<a>`s, visible keyboard focus, labels on inputs, colour never the only signal (pair it with an icon or text), WCAG AA contrast | |

## 4. Data types

These come from the existing `web/src/api.ts`. Don't change them.

```ts
interface Repo {
  repoId: string; owner: string; name: string;
  description: string | null; language: string | null;
  stars: number; updatedAt: string; // ISO date
  isFork: boolean; isPrivate: boolean;
  sizeKb: number;          // 0 = empty repo (can't be selected)
  defaultBranch: string;
}

type IndexStatus = "missing" | "fresh" | "stale";
interface StatusResponse {
  status: IndexStatus;
  manifest: { commitSha: string; branch: string; indexedAt: string; fileCount: number; chunkCount: number } | null;
}

interface IndexJob {
  repoId: string;
  step: "downloading" | "processing" | "embedding" | "ready" | "failed";
  done: number; total: number;   // progress within the current step
  error: string | null; startedAt: string;
}

interface Source { path: string; startLine: number; endLine: number; symbol: string }

type AnswerDepth = "executive" | "technical";
interface ChatMessage {
  role: "user" | "assistant";
  content: string;          // Markdown for assistant messages
  sources?: Source[];
  followUps?: string[];     // suggested next questions
}

interface HotspotFile {
  path: string; changes: number; linesAdded: number; linesDeleted: number;
  authors: number; lastChanged: string; lines: number;
  complexity: number; score: number; // score 0–100, riskiest file = 100
}
interface HistoryReport {
  repoId: string; commitSha: string; generatedAt: string; since: string;
  commitsAnalyzed: number;
  skipped: { merges: number; bots: number; large: number };
  reachedLimit: boolean;      // true if only the newest 500 commits were used
  filesChanged: number;       // total; `files` holds only the top 100
  files: HotspotFile[];
  coChange: Array<{ a: string; b: string; count: number; percent: number }>;
  areas: Array<{ area: string; commits: number; authors: number; files: number; singleContributor: boolean }>;
}

interface HealthReport { repoId: string; commitSha: string; generatedAt: string; markdown: string; sources: Source[] }
```

## 5. Existing functions the UI calls

All of these exist in `web/src/api.ts`. Every one throws an `Error` whose `message` is safe to show to the user.

| Function | Returns | Used by |
|---|---|---|
| `listRepos(refresh?)` | `Repo[]` | Repo Browser |
| `getRepo(owner, name)` | `Repo` | Paste-a-URL box |
| `getStatus(owner, name)` | `StatusResponse` | Selecting a repo, chat header |
| `startIndex(owner, name)` | `IndexJob` (throws "Another repo is being indexed…" if busy) | Repo Browser, Re-index |
| `getIndexJob()` | `IndexJob \| null` (polled every second) | Progress panel |
| `streamChat(owner, name, question, history, depth, { onSources, onToken, onFollowUps })` | streams the answer: sources first, then text pieces, then follow-ups | Chat |
| `getHotspots(owner, name)` / `analyzeHotspots(owner, name)` | `HistoryReport \| null` / `HistoryReport` | Hotspots tab |
| `getReport(owner, name)` / `generateReport(owner, name)` | `HealthReport \| null` / `HealthReport` | Report tab |

From `web/src/sourceLinks.ts`:
- `linkCitations(markdown, target, sources)` turns citations like `[src/app.py:L10-L16]` in an answer into GitHub links.
- `sourceUrl(target, source)` gives the GitHub link for one source.

`target` is `{ owner, name, ref }`, where `ref` is the indexed commit SHA.

---

## 6. Screens

### 6.1 App shell — `App`

- **Header** on every screen: product name ("GitHub Repository AI Assistant", or a short name plus a small subtitle) on the left, **light/dark theme toggle** on the right (an icon button with an accessible label).
- The theme starts from the operating system setting, and the user's choice is saved in `localStorage` under `theme`.
- Two views: **Repo Browser** and **Chat** (for the selected repo).

### 6.2 Repo Browser — `RepoBrowser({ onOpenChat })`

The first screen. Find a repo and open it.

**Top: paste a URL.** One input ("Paste a GitHub URL or owner/repo") and an **Open** button. Accepts `https://github.com/owner/repo`, `github.com/owner/repo` and `owner/repo`.

**Filter bar** (one row, wraps on small screens):
- Search box: "Search by name or owner"
- Sort: Recently updated (default) · Most stars · Name (A–Z)
- Type: All types · Original only · Forks only
- Visibility: Public and private · Public · Private
- Owner: All owners · one entry per owner in the list
- Checkbox: **Show empty repos** (off by default)
- **Refresh** button (reloads the list from GitHub)

**Repo list:** 20 per page, with Previous / Next and "Page 2 of 5 · 93 repos". Each item shows:
- `owner/` (muted) + **name** (bold)
- badges: **Private**, **Fork**, **Empty**
- description (one or two lines, may be missing)
- language · ★ stars · "Updated 3 Nov 2026"
- The whole item is clickable. **Empty repos can't be selected** (disabled look).

**States:**
| State | What to show |
|---|---|
| Loading | "Loading repositories…" (a skeleton list is fine) |
| Error | The error message, e.g. "GitHub token missing or invalid. Check GITHUB_TOKEN in your .env file." |
| Token sees no repos | "Your GitHub token can't access any repositories." |
| Nothing matches the filters | "No repositories match your search and filters." |
| Selected repo has new commits | A panel: "**owner/name** has new commits since it was indexed. Re-index?" with **Re-index** (primary) and **Use the existing index** (secondary) |
| Indexing | The progress panel (6.3) above the list. The list is disabled while indexing. |
| Message | Inline error text, e.g. "Another repo is being indexed (owner/repo). Please wait for it to finish." or "This repo is empty, so it can't be analysed." |

### 6.3 Indexing progress — `IndexProgress({ onReady, onFailed })`

A compact panel: "Indexing **owner/repo**", then 4 steps in order:

**Downloading → Processing files (12 / 40) → Embedding (64 / 120) → Ready**

- Each step is *done* (check), *active* (highlighted, with its count when `total > 0`), or *to do* (muted).
- A progress bar for the active step is welcome.
- Indexing can take several minutes, so it should feel alive, not stuck.
- On failure, the parent shows the error message.

### 6.4 Chat view — `Chat({ repo, messages, setMessages, onBack })`

**Header:**
- **← Back to repos** on the left
- **owner/name** (bold), with a muted line below: status ("Up to date" / "New commits since indexing" / "Not indexed") · short commit SHA (`9126829`) · "17 files"
- **Re-index** and **Clear chat** buttons on the right. Clear chat is disabled when there are no messages.
- When Re-index is running, the progress panel (6.3) shows under the header.

**Tabs:** **Chat | Hotspots | Report.** The chat messages are kept while another tab is open.

**Chat tab:**
- **Empty state:** "Try one of these:" and 4 starter question buttons:
  "Summarise this project and its tech stack" · "How is it structured?" · "What external services does it depend on?" · "What are the main risks or tech debt?"
- **User message:** plain text, visually distinct from answers.
- **Assistant message:**
  - Markdown with headings, lists and **syntax-highlighted code blocks**. Long code scrolls sideways.
  - Citations inside the text are **links** (blue, open GitHub in a new tab).
  - Before the first text arrives, show "Thinking…".
  - The answer **streams in word by word**, so the layout must not jump around as text grows.
  - Under the answer: a collapsible **Sources (8)** list. Each item is a monospace link like `src/agents.py:L23-L45` with an optional muted symbol name (`AuthService.login`).
  - Under the **latest** answer only, once it has finished: **"Ask next:"** with up to 3 suggestion buttons (full question text, can be long).
- **Answer style switch** above the input: **Executive | Technical** (a segmented control).
  - Executive tooltip: "Short, plain-language answers for leaders. No code."
  - Technical tooltip: "Full detail with code, for developers."
  - The choice is saved in `localStorage` under `answerDepth`. Default: Technical.
- **Input row:** "Ask a question about this repo" + **Send**. While answering, the button says "Answering…" and the input is disabled.
- **Error:** shown above the input, e.g. "Gemini rate limit or quota reached. Wait a minute and try again."
- Auto-scroll to the newest message while streaming.

### 6.5 Hotspots tab — `Hotspots({ repo })`

**Not analysed yet:** an intro panel.
- *"**Hotspots** show which files change most often and are most complex: that's usually where bugs and slow delivery come from. They also show files that change together, and areas only one person works on."*
- Muted: *"Reads the last 12 months of commits from GitHub. No code is sent to the AI."*
- **Analyse history** button. While running: "Analysing…" plus *"Reading git history… this can take up to a minute or two for busy repos."*

**With a report:**
1. Top line: "Last 12 months · analysed 8 Nov 2026" (plus "· only the newest 500 commits were used" when `reachedLimit`), and a **Refresh** button.
2. **Three stat tiles:** Commits analysed · Files changed · Areas with one contributor.
3. Notes: "Only 4 commits: results get more meaningful with more history." (when under 10), or "No commits in the last 12 months, so there's nothing to show." (when 0).
4. **Top hotspots:** a horizontal **bar chart** of the 10 highest scores.
   - Subtitle: "Risk score = how often a file changes × how complex it is. The riskiest file is 100."
   - File path on the left. Long paths are cut **at the start**, so the file name stays visible (`…/routers/submissions.py`).
   - **One** accent colour, with the score number at the end of each bar.
   - Hover or keyboard focus shows a tooltip: path, "9 changes · complexity 14 · 210 lines", "4 people · last changed 26 Oct 2026".
   - File names link to GitHub.
5. **All changed files** table, top 25 rows: File (monospace link) · Changes · Complexity · Lines · People · Last changed · Score. Numbers right-aligned, with "Showing the top 25 of 116 files." below.
6. **Files that change together:** subtitle "Often changed in the same commit. This can mean a hidden dependency between them." Then a list: `backend/app/main.py` ⇄ `backend/app/schemas.py` — together 6 times (75%). Empty: "No pair of files changed together 3 or more times."
7. **Knowledge risk:** subtitle "How many different people changed each top-level folder. No names are shown or stored." Table: Area · Commits · People · Files · Status. Status is **"⚠ Only one person"** (warning colour **plus** the icon and text) or a muted "OK".
8. Footer note: "Skipped: 0 merge commits and 0 bot commits. 1 large commits (over 30 files) count for hotspots but were left out of 'files that change together'."

**Never show people's names anywhere on this tab.** The data doesn't contain them.

### 6.6 Report tab — `HealthReport({ repo })`

**No report yet:** an intro panel.
- *"A one-page **health report** for leaders: what the project does, tech stack, structure, dependencies, risks, onboarding notes, and hotspots from the git history."*
- Tip: *"Run 'Analyse history' in the Hotspots tab first, so the report includes hotspots."*
- **Generate report** button. While running: *"Writing the report… this usually takes 20-40 seconds."*

**With a report:**
- Top line: "Generated 8 Nov 2026, 14:32", plus **Download .md** (secondary) and **Regenerate** (primary) buttons.
- The report renders as a **document**: a readable page width, a clear H1, H2 sections with a divider, bullet lists, monospace file paths, and citation links to GitHub. It should look like something you'd forward to a board, not like a chat bubble.
- The sections are always: Facts · Overview · Tech stack · Structure · Dependencies and external services · Risks and tech debt · Onboarding notes · Hotspots and knowledge risk (from git history).

---

## 7. Behaviour that must keep working

When integrating a redesigned screen, check all of these:

1. Citations in answers and reports become GitHub links, but **only for files in that answer's sources** (handled by `linkCitations`). Don't remove that step.
2. Links open in a new tab.
3. Answers stream progressively. Sources appear once the answer is done; follow-ups appear only under the latest answer.
4. The Executive/Technical choice is sent with every question and remembered.
5. "Clear chat" and switching repos reset the conversation. The index is not rebuilt.
6. Empty repos are hidden unless "Show empty repos" is on, and can never be selected.
7. Only one indexing job at a time. The "Another repo is being indexed" message is shown when relevant.
8. Theme choice persists after reload, in both views.
9. No people's names on the Hotspots tab or in the report.
10. No raw HTML rendering and no external network requests from the UI.
