// Shared data types (ARCHITECTURE §9).

/** A GitHub repository, as shown in the Repo Browser. */
export interface Repo {
  repoId: string; // "owner/repo", lower case
  owner: string;
  name: string;
  description: string | null;
  language: string | null;
  stars: number;
  updatedAt: string; // ISO date
  isFork: boolean;
  isPrivate: boolean;
  sizeKb: number;
  defaultBranch: string;
}

/** One text file taken from a repo's zip archive. */
export interface SourceFile {
  path: string;
  text: string;
  language: string;
}

export type SymbolType = "function" | "class" | "method" | "module" | "lines";

/** One piece of a file, stored with its vector in the vector store. */
export interface Chunk {
  id: string;
  text: string; // context header + code, as sent to the embedding model
  path: string;
  startLine: number;
  endLine: number;
  language: string;
  symbol: string; // empty for line chunks
  symbolType: SymbolType;
  chunker: "syntax" | "lines";
}

/** Saved after a repo is indexed. Written last, so a partial index never looks complete. */
export interface Manifest {
  repoId: string;
  commitSha: string;
  branch: string;
  indexedAt: string; // ISO date
  embedModel: string;
  fileCount: number;
  chunkCount: number;
  fileTree: string;
  readme: string;
}

export type IndexStatus = "missing" | "fresh" | "stale";

export type IndexStep = "downloading" | "processing" | "embedding" | "ready" | "failed";

/** The single indexing job the server runs at a time. */
export interface IndexJob {
  repoId: string;
  step: IndexStep;
  done: number;
  total: number;
  error: string | null;
  startedAt: string; // ISO date
}

/** A code location cited under a chat answer. */
export interface Source {
  path: string;
  startLine: number;
  endLine: number;
  symbol: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
}

// ---------- F4: git history hotspots ----------

// One commit, as we save it. The author is a scrambled code (hash), never a name or email.
export interface CommitRecord {
  sha: string;
  author: string; // hash, only used to count how many different people changed something
  date: string; // when the commit was made (ISO date)
  fileCount: number; // how many files the commit changed
  files: Array<{ path: string; added: number; deleted: number }>; // files that were only renamed/moved are left out
}

// One file's history and complexity.
export interface HotspotFile {
  path: string;
  changes: number; // how many commits changed it
  linesAdded: number;
  linesDeleted: number;
  authors: number; // how many different people changed it
  lastChanged: string; // date of the latest change
  lines: number; // how long the file is now
  complexity: number; // number of decision points (if, for, while, case, catch, &&, ||, ?)
  score: number; // 0-100: changes × complexity, scaled so the riskiest file is 100
}

// Two files that keep being changed in the same commit.
export interface CoChangePair {
  a: string;
  b: string;
  count: number; // how many commits changed both
  percent: number; // count as a % of the changes to the less-changed file
}

// One top-level folder and how many people work on it. No names.
export interface AreaStats {
  area: string;
  commits: number;
  authors: number;
  files: number;
  singleContributor: boolean; // true if only 1 person changed it (with at least 3 commits)
}

// Everything the Hotspots tab shows.
export interface HistoryReport {
  repoId: string;
  commitSha: string; // the version of the code the complexity was measured on (used for GitHub links)
  generatedAt: string;
  since: string; // start of the 12-month window
  commitsAnalyzed: number;
  skipped: { merges: number; bots: number; large: number }; // large = commits over 30 files, left out of "files that change together" only
  reachedLimit: boolean; // true if there were more than MAX_COMMITS commits, so only the newest were used
  filesChanged: number; // how many current files changed in total (the list below shows only the top 100)
  files: HotspotFile[];
  coChange: CoChangePair[];
  areas: AreaStats[];
}
