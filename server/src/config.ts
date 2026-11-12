// Loads settings from the project-root .env file and defines all constants
// (ARCHITECTURE §12). Every other module reads settings from here.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// server/src/config.ts and server/dist/config.js are both two levels below the root.
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA_DIR = path.join(ROOT_DIR, "data");

dotenv.config({ path: path.join(ROOT_DIR, ".env"), quiet: true });

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

/**
 * Which AI service answers questions and makes embeddings (DECISIONS D16):
 *  - "gemini": Google's Gemini API. Fast, but repo code is sent to Google.
 *  - "ollama": Qwen running locally in Ollama. Code stays on this machine (D3, D4, D13).
 */
const llmProvider = env("LLM_PROVIDER", "gemini").toLowerCase();
if (llmProvider !== "gemini" && llmProvider !== "ollama") {
  throw new Error(`LLM_PROVIDER must be "gemini" or "ollama" (got "${llmProvider}"). Check your .env file.`);
}

/** Default models for each provider, used when CHAT_MODEL / EMBED_MODEL are left empty in .env. */
const DEFAULT_MODELS = {
  gemini: { chat: "gemini-3.6-flash", embed: "gemini-embedding-001" },
  ollama: { chat: "", embed: "" }, // must be set in .env: they depend on the hardware
};

export const config = {
  githubToken: env("GITHUB_TOKEN"),
  llmProvider: llmProvider as "gemini" | "ollama",
  geminiApiKey: env("GEMINI_API_KEY"),
  ollamaHost: env("OLLAMA_HOST", "http://127.0.0.1:11434"),
  chatModel: env("CHAT_MODEL", DEFAULT_MODELS[llmProvider].chat),
  embedModel: env("EMBED_MODEL", DEFAULT_MODELS[llmProvider].embed),
  // Local only (DECISIONS D14): never bind to 0.0.0.0.
  host: "127.0.0.1",
  port: Number(env("PORT", "3001")),
};

// GitHub
export const MAX_REPOS = 1000;

// F4: git history hotspots. GitHub needs one request per commit to tell us which files changed,
// so we limit how far back we look. GitHub allows 5,000 requests per hour with a token.
export const HISTORY_MONTHS = 12; // look at the last 12 months only
export const MAX_COMMITS = 500; // and at most 500 commits
// Commits that changed more than 30 files still count for hotspots, but are left out of "files that change together":
// one 46-file commit would otherwise create 1,035 fake pairs.
export const MAX_FILES_PER_COMMIT = 30;
export const MIN_CO_CHANGES = 3; // two files must change together at least 3 times to be listed
export const HISTORY_CONCURRENCY = 5; // how many commit requests we send to GitHub at the same time

// Ingestion limits
export const MAX_FILES = 1000;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_BYTES = 500 * 1024;

// Chunking
export const LINE_CHUNK_SIZE = 60;
export const LINE_CHUNK_OVERLAP = 10;
export const MAX_CHUNK_TOKENS = 800;
export const CHARS_PER_TOKEN = 4;

// RAG
export const TOP_K = 8;
// Phase 2 hybrid search (hybridSearch.ts): when a question names something in the code (e.g. `resolveScope`),
// keyword search runs alongside the meaning (vector) search. HYBRID_SEARCH=off in .env turns it off.
export const HYBRID_SEARCH = env("HYBRID_SEARCH", "on").toLowerCase() !== "off";
export const HISTORY_TURNS = 3;
export const MAX_TREE_LINES = 200;
export const MAX_README_TOKENS = 1500;
export const NUM_CTX = 16384;

// Phase 3 folder summaries (folderSummaries.ts). FOLDER_SUMMARIES=off in .env turns them off.
export const FOLDER_SUMMARIES = env("FOLDER_SUMMARIES", "on").toLowerCase() !== "off";
export const MIN_FILES_PER_FOLDER = 2; // folders with fewer files directly inside are skipped
export const MAX_FOLDER_SUMMARIES = 40; // the 40 biggest folders at most, to stay within Gemini's free tier
export const FOLDERS_PER_REQUEST = 5; // folders summarized in one AI call
export const SUMMARY_CONCURRENCY = 3; // AI calls running at the same time
export const FOLDER_INPUT_CHARS = 3000; // code sent per folder (file names + the start of each file)
export const SUMMARIES_IN_PROMPT = 3; // most related summaries added to each chat answer
