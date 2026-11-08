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
  manifest: { commitSha: string; branch: string; indexedAt: string; fileCount: number; chunkCount: number } | null;
}

export interface IndexJob {
  repoId: string;
  step: "downloading" | "processing" | "embedding" | "ready" | "failed";
  done: number;
  total: number;
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
  complexity: number; // decision points (if, for, while, …)
  score: number; // 0-100, riskiest file = 100
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
  handlers: {
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
      body: JSON.stringify({ question, depth, history: history.map(({ role, content }) => ({ role, content })) }),
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
      if (event === "sources") handlers.onSources(data);
      if (event === "token") handlers.onToken(data);
      if (event === "followups") handlers.onFollowUps(data); // F3
      if (event === "error") throw new Error(data.error);
      if (event === "done") return;
    }
  }
}
