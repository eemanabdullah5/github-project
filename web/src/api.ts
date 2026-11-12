// Typed calls to the server API (ARCHITECTURE §4.2). The UI talks to the server only through this file.
// Every function throws an Error whose message is safe to show to the user.

// These types mirror server/src/types.ts.
export interface Repo {
  repoId: string;
  owner: string;
  name: string;
  description: string | null;
  language: string | null;
  stars: number;
  updatedAt: string;
  isFork: boolean;
  isPrivate: boolean;
  sizeKb: number;
  defaultBranch: string;
}

export type IndexStatus = "missing" | "fresh" | "stale";

export interface StatusResponse {
  status: IndexStatus;
  manifest: {
    commitSha: string;
    branch: string;
    indexedAt: string;
    fileCount: number;
    chunkCount: number;
    folders: string[]; // Phase 2: folders with indexed files, for the "Ask about one folder" picker
    files: string[]; // … and the indexed files themselves
  } | null;
}

export interface IndexJob {
  repoId: string;
  step: "downloading" | "processing" | "embedding" | "ready" | "failed";
  done: number;
  total: number;
  reused?: number; // embedding: unchanged chunks that kept their saved vector (re-index)
  error: string | null;
  startedAt: string;
}

export interface Source {
  path: string;
  startLine: number;
  endLine: number;
  symbol: string;
}

// F4: git history hotspot report (same shape as HistoryReport in server/src/types.ts).
export interface HotspotFile {
  path: string;
  changes: number; // how many commits changed it
  linesAdded: number;
  linesDeleted: number;
  authors: number; // how many different people changed it
  lastChanged: string;
  lines: number;
  complexity: number; // cognitive complexity of the most complex function
  // "syntax" = parsed, "estimate" = counted decision words, "none" = docs/config. Missing in older saved history.
  complexityMethod?: "syntax" | "estimate" | "none";
  topFunction?: { name: string; line: number; endLine: number; complexity: number } | null;
  score: number; // hotspot score 0-100, top hotspot = 100
}

export interface HistoryReport {
  repoId: string;
  commitSha: string; // the code version that was measured (used for GitHub links)
  generatedAt: string;
  since: string;
  commitsAnalyzed: number;
  skipped: { merges: number; bots: number; large: number };
  reachedLimit: boolean;
  filesChanged: number; // total files changed (the list shows only the top 100)
  files: HotspotFile[];
  coChange: Array<{ a: string; b: string; count: number; percent: number }>;
  areas: Array<{ area: string; commits: number; authors: number; files: number; singleContributor: boolean }>;
}

// F5: a saved health report (same shape as HealthReport in server/src/report.ts).
export interface HealthReport {
  repoId: string;
  commitSha: string; // the indexed commit the report describes (used for GitHub links)
  generatedAt: string;
  markdown: string; // the full report text
  sources: Source[]; // the code the AI was given, so citations can become links
}

// F2: answer style. "executive" = short and simple, "technical" = full detail with code.
export type AnswerDepth = "executive" | "technical";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  followUps?: string[]; // F3: suggested next questions, shown as buttons under the latest answer
  scope?: string; // Phase 2: on a question, the folder or file it was limited to (shown as a tag)
}

/**
 * Sends a request and returns the JSON body.
 * If the server replies with an error, throws its {error} message.
 * If the server can't be reached at all, throws a "server not running" message.
 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error("Can't reach the server. Is it running? (npm run dev)");
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json() as Promise<T>;
}

/** Reads the {error} message from a failed response, with a fallback if there isn't one. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body?.error) return body.error;
  } catch {
    // not JSON
  }
  return `The server returned an error (${res.status}).`;
}

/** Builds "/api/repos/owner/repo" with both parts safely encoded. */
const repoPath = (owner: string, name: string) => `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

/** All repos the token can access. Pass refresh=true to make the server ask GitHub again. */
export function listRepos(refresh = false): Promise<Repo[]> {
  return request(`/api/repos${refresh ? "?refresh=1" : ""}`);
}

/** Looks up one repo (for the paste-a-URL box). */
export function getRepo(owner: string, name: string): Promise<Repo> {
  return request(repoPath(owner, name));
}

/** Whether the repo's index is missing, fresh or stale. */
export function getStatus(owner: string, name: string): Promise<StatusResponse> {
  return request(`${repoPath(owner, name)}/status`);
}

/** Starts indexing. Throws "Another repo is being indexed" if a job is already running. */
export function startIndex(owner: string, name: string): Promise<IndexJob> {
  return request(`${repoPath(owner, name)}/index`, { method: "POST" });
}

// F4: the saved hotspot report, or null if this repo's history hasn't been analysed yet.
export async function getHotspots(owner: string, name: string): Promise<HistoryReport | null> {
  try {
    return await request<HistoryReport>(`${repoPath(owner, name)}/hotspots`);
  } catch (err) {
    // "Not analysed yet" is a normal state, not an error, so it becomes null.
    if ((err as Error).message.includes("hasn't been analysed yet")) return null;
    throw err;
  }
}

// F4: analyses the repo's git history now and returns the new report. Can take up to a minute or two.
export function analyzeHotspots(owner: string, name: string): Promise<HistoryReport> {
  return request(`${repoPath(owner, name)}/hotspots`, { method: "POST" });
}

// F5: the saved health report, or null if none has been generated yet.
export async function getReport(owner: string, name: string): Promise<HealthReport | null> {
  try {
    return await request<HealthReport>(`${repoPath(owner, name)}/report`);
  } catch (err) {
    // "No report yet" is a normal state, not an error, so it becomes null.
    if ((err as Error).message.includes("No health report")) return null;
    throw err;
  }
}

// F5: generates a new health report now. Takes about 20-40 seconds.
export function generateReport(owner: string, name: string): Promise<HealthReport> {
  return request(`${repoPath(owner, name)}/report`, { method: "POST" });
}

/** The current indexing job, or null if none has run since the server started. */
export function getIndexJob(): Promise<IndexJob | null> {
  return request("/api/index-job");
}

/**
 * Asks a question and streams the answer.
 * The browser's EventSource only supports GET, so we POST with fetch and read the
 * Server-Sent Events from the response body ourselves. Each event looks like:
 *   event: token
 *   data: "some text"
 *   (blank line)
 */
export async function streamChat(
  owner: string,
  name: string,
  question: string,
  history: ChatMessage[],
  depth: AnswerDepth, // F2: the answer style chosen with the toggle
  scope: string, // Phase 2: the folder or file to search in, or "" for the whole repo
  conversationId: string | null, // saved chat history: the chat this question belongs to (null = start a new one)
  handlers: {
    onConversation: (id: string) => void; // saved chat history: called first, with the chat's id
    onSources: (sources: Source[]) => void;
    onToken: (text: string) => void;
    onFollowUps: (questions: string[]) => void; // F3: called once, after the answer is complete
  },
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${repoPath(owner, name)}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // F2: depth is sent with every question, so the server knows which answer style to use.
      body: JSON.stringify({ question, depth, scope, conversationId, history: history.map(({ role, content }) => ({ role, content })) }),
    });
  } catch {
    throw new Error("Can't reach the server. Is it running? (npm run dev)");
  }
  if (!res.ok || !res.body) throw new Error(await errorMessage(res));

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;

    // Events are separated by a blank line. Keep any unfinished event in the buffer.
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const raw of events) {
      const event = raw.match(/^event: (.*)$/m)?.[1];
      const data = JSON.parse(raw.match(/^data: (.*)$/m)?.[1] ?? "null");
      if (event === "conversation") handlers.onConversation(data.id);
      if (event === "sources") handlers.onSources(data);
      if (event === "token") handlers.onToken(data);
      if (event === "followups") handlers.onFollowUps(data); // F3
      if (event === "error") throw new Error(data.error);
      if (event === "done") return;
    }
  }
}

// ---------- Call graph (same shapes as server/src/callGraph.ts) ----------

/** One function in the call graph. `callers` / `callees`: how many call it, and how many it calls. */
export interface CallFunction {
  id: string; // "server/src/rag.ts#answer"
  name: string;
  qualified: string; // with its class: "Agent.remember"
  file: string;
  line: number;
  endLine: number;
  kind: "function" | "method" | "top-level";
  isTest: boolean;
  callers?: number;
  callees?: number;
}

/** A function next to the focused one in the diagram. */
export interface FocusItem {
  fn: CallFunction;
  level: 1 | 2; // 2 = one step further from the focused function
  parent: string; // the function it connects to
  line: number; // where the call is written
  site: string; // the file the call is written in
  certain: boolean; // false = "possible" (a method matched by its name)
}

/** One function's callers and callees, and its Mermaid diagram. */
export interface CallFocus {
  commitSha: string;
  center: CallFunction;
  depth: 1 | 2;
  callers: FocusItem[];
  callees: FocusItem[];
  more: { callers: number; callees: number };
  mermaid: string;
}

export interface CallGraphStats {
  calls: number;
  certain: number;
  possible: number;
  dropped: number;
}

/** Every function in the repo's call graph, most-called first (for the picker). */
export function getCallFunctions(owner: string, name: string): Promise<{ commitSha: string; stats: CallGraphStats; functions: CallFunction[] }> {
  return request(`${repoPath(owner, name)}/calls`);
}

/** One function's callers and callees (depth 1 or 2), with its diagram. */
export function getCallFocus(owner: string, name: string, fn: string, depth: 1 | 2): Promise<CallFocus> {
  return request(`${repoPath(owner, name)}/calls/focus?fn=${encodeURIComponent(fn)}&depth=${depth}`);
}

// ---------- Change impact (same shapes as server/src/impact.ts) ----------

/** One affected function: how far it is from the changed one, and the call it makes on the way. */
export interface ImpactItem {
  fn: CallFunction;
  distance: number; // 1 = calls it directly
  via: string; // the function it calls on the way
  line: number; // where it makes that call
  certain: boolean; // false = only reached through a "possible" call
}

/** A file the change reaches, with its hotspot heat (0 = not a hotspot). */
export interface ImpactFile {
  file: string;
  functions: number;
  hotspot: 0 | 1 | 2 | 3;
}

export interface ChangeImpact {
  commitSha: string;
  target: CallFunction;
  affected: ImpactItem[];
  tests: ImpactItem[];
  entryPoints: ImpactItem[];
  files: ImpactFile[];
  totals: { affected: number; certain: number; tests: number; files: number; hotspotFiles: number; maxDistance: number };
  more: { affected: number; tests: number };
}

/** What a change to one function affects, and which tests reach it. */
export function getCallImpact(owner: string, name: string, fn: string): Promise<ChangeImpact> {
  return request(`${repoPath(owner, name)}/calls/impact?fn=${encodeURIComponent(fn)}`);
}

// ---------- PR risk briefing (same shapes as server/src/prRisk.ts) ----------

export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  author: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  baseRef: string;
  headSha: string;
  baseSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  updatedAt: string;
}

export interface PrFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  isTest: boolean;
  isCode: boolean;
  hotspot: 0 | 1 | 2 | 3;
  functions: string[];
  noDiff: boolean;
}

export interface PrBriefing {
  pr: PullRequestInfo;
  graphFrom: "pr" | "indexed";
  files: PrFile[];
  changedFunctions: Array<{ fn: CallFunction; affected: number; tests: number; maxDistance: number; complexity?: { before: number | null; after: number } }>;
  affected: { functions: number; files: number; hotspotFiles: string[]; entryPoints: CallFunction[] };
  tests: { changedTestFiles: string[]; reaching: CallFunction[]; untested: CallFunction[] };
  missingPartners: Array<{ changed: string; partner: string; count: number; percent: number }>;
  knowledgeRisk: string[];
  risk: { score: number; level: "low" | "medium" | "high"; reasons: Array<{ points: number; text: string }> };
  reviewers: Array<{ login: string; files: number }>;
  historyDate: string | null; // when the git history was analysed
  notes: string[];
}

/** The newest open pull requests. */
export function listPullRequests(owner: string, name: string): Promise<PullRequestInfo[]> {
  return request(`${repoPath(owner, name)}/pulls`);
}

/** The risk briefing for one pull request. */
export function getPrBriefing(owner: string, name: string, number: number): Promise<PrBriefing> {
  return request(`${repoPath(owner, name)}/pulls/${number}/briefing`);
}

// ---------- Saved chat history (same shapes as server/src/chatHistory.ts) ----------

/** One saved chat, as shown in the "Past chats" list. */
export interface ChatSummary {
  id: string;
  title: string; // the first question, shortened
  updatedAt: string;
  messageCount: number;
}

/** One saved chat with its messages. */
export interface SavedChat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

/** The repo's saved chats, most recent first. */
export function listChats(owner: string, name: string): Promise<ChatSummary[]> {
  return request(`${repoPath(owner, name)}/chats`);
}

/** One saved chat with all its messages. */
export function getChat(owner: string, name: string, id: string): Promise<SavedChat> {
  return request(`${repoPath(owner, name)}/chats/${encodeURIComponent(id)}`);
}

/** Deletes several saved chats at once ("Delete selected"). Returns how many were deleted. */
export async function deleteChats(owner: string, name: string, ids: string[]): Promise<number> {
  const result = await request<{ deleted: number }>(`${repoPath(owner, name)}/chats/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  return result.deleted;
}

/** Deletes one saved chat. */
export async function deleteChat(owner: string, name: string, id: string): Promise<void> {
  await request(`${repoPath(owner, name)}/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---------- Phase 4: architecture map (same shape as ArchitectureMap in server/src/architecture.ts) ----------

export interface ArchModule {
  id: string;
  name: string; // folder, e.g. "server/src/chunking", or "(root)"
  files: string[];
  uses: number; // other modules it imports from
  usedBy: number; // other modules that import from it
  hotspot: { score: number; file: string } | null; // top hotspot file from F4, if analysed
  inCycle: boolean;
}

export interface ArchLink {
  from: string;
  to: string;
  count: number; // file-to-file imports behind this arrow
  examples: Array<{ from: string; to: string; line: number }>;
  inCycle: boolean;
}

export interface ArchitectureMap {
  repoId: string;
  commitSha: string;
  depth: number;
  modules: ArchModule[];
  links: ArchLink[];
  cycles: string[][];
  fileCycles: string[][];
  coverage: number | null;
  hotspotsAnalysed: boolean;
  mermaid: string;
  hiddenCoupling: HiddenCoupling | null; // null if the history hasn't been analysed
}

// Phase 4: code files that change together but don't import each other (server/src/coupling.ts).
export interface HiddenCouplingPair {
  a: string;
  b: string;
  count: number; // commits that changed both
  percent: number; // count as a % of the changes to the less-changed file
  link: "none" | "indirect"; // no import path at all, or only through other files
  via: string[]; // for "indirect": the shortest import chain, both ends included
}

export interface HiddenCoupling {
  pairsChecked: number;
  pairs: HiddenCouplingPair[];
  partial: boolean; // history saved before this feature: only the top pairs were checked
}

// Phase 4: the architecture map. Built from the import graph (a few seconds the first time for older indexes).
export function getArchitecture(owner: string, name: string): Promise<ArchitectureMap> {
  return request(`${repoPath(owner, name)}/architecture`);
}
