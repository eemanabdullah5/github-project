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
