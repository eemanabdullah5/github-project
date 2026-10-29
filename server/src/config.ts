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

export const config = {
  githubToken: env("GITHUB_TOKEN"),
  // LLM settings are pending senior confirmation (DECISIONS D3, D4, D13).
  ollamaHost: env("OLLAMA_HOST", "http://127.0.0.1:11434"),
  chatModel: env("CHAT_MODEL"),
  embedModel: env("EMBED_MODEL"),
  // Local only (DECISIONS D14): never bind to 0.0.0.0.
  host: "127.0.0.1",
  port: Number(env("PORT", "3001")),
};

// GitHub
export const MAX_REPOS = 1000;

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
export const HISTORY_TURNS = 3;
export const MAX_TREE_LINES = 200;
export const MAX_README_TOKENS = 1500;
export const NUM_CTX = 16384;
