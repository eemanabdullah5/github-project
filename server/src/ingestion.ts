// Ingestion (ARCHITECTURE §6): turns a downloaded zip into a list of text files.
// It skips things that aren't useful to the AI (dependencies, build output, images,
// lock files, minified files, binaries, huge files) and enforces the size limits.
// It also keeps secrets out: secret files (.env, private keys) are skipped, and
// well-known key formats in other files are masked before anything is stored or sent to the AI.
// The zip is read in memory, nothing is written to disk, and no repo code is ever run.
import { unzipSync } from "fflate";
import { MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES } from "./config.js";
import { AppError } from "./errors.js";
import type { Repo, SourceFile } from "./types.js";

/** Folders that hold dependencies, build output or tool caches. Anything inside is skipped. */
const SKIP_DIRS = new Set([
  "node_modules", "venv", ".venv", "env", "dist", "build", ".git",
  "__pycache__", "vendor", "target", ".next", "coverage",
]);

/** Lock files: long, generated and not useful for answering questions. */
const SKIP_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "pipfile.lock",
  "cargo.lock", "composer.lock", "gemfile.lock", "go.sum", "bun.lockb",
]);

/** Extensions for images, archives, binaries, fonts and media. */
const SKIP_EXTENSIONS = new Set([
  // images
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg", "tif", "tiff", "psd",
  // archives
  "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "war",
  // binaries
  "exe", "dll", "so", "dylib", "bin", "o", "a", "class", "pyc", "pyo", "wasm", "pdb", "obj",
  // fonts
  "ttf", "otf", "woff", "woff2", "eot",
  // media and documents
  "mp3", "mp4", "wav", "ogg", "flac", "avi", "mov", "mkv", "webm", "pdf",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  // data blobs
  "db", "sqlite", "sqlite3", "parquet", "pkl", "npy", "h5",
]);

/**
 * Files that usually hold real secrets. They are never indexed.
 * Templates like ".env.example" are kept: they show which settings a project needs,
 * and any keys left in them are still masked by redactSecrets().
 */
const SECRET_FILES = new Set([
  ".npmrc", ".pypirc", ".netrc", ".git-credentials",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
]);
const SECRET_EXTENSIONS = new Set(["pem", "key", "p12", "pfx", "jks", "keystore"]);
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);

/** True for secret files: .env and .env.* (except templates), private keys and credential files. */
export function isSecretFile(fileName: string): boolean {
  const name = fileName.toLowerCase();
  if ((name === ".env" || name.startsWith(".env.")) && !ENV_TEMPLATES.has(name)) return true;
  if (SECRET_FILES.has(name)) return true;
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return SECRET_EXTENSIONS.has(ext);
}

/**
 * Well-known secret formats, each replaced with a [REDACTED …] label.
 * Only formats with a distinctive shape are listed, so normal code is not touched.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "PRIVATE KEY"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, "GITHUB TOKEN"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/g, "GITHUB TOKEN"],
  [/\bAIza[0-9A-Za-z_-]{35}/g, "GOOGLE API KEY"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "AWS KEY"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "SLACK TOKEN"],
  [/\b[sr]k_live_[0-9A-Za-z]{20,}/g, "STRIPE KEY"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}/g, "API KEY"],
];

/**
 * Masks well-known secrets in a file's text. A multi-line private key keeps its
 * line breaks, so the line numbers shown in answers still match the real file.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, label] of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => `[REDACTED ${label}]` + "\n".repeat(match.split("\n").length - 1));
  }
  return result;
}

/** File extension → language name. Anything not listed is "text". */
const LANGUAGES: Record<string, string> = {
  py: "python", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  java: "java", go: "go", rb: "ruby", php: "php", cs: "csharp", c: "c", h: "c",
  cpp: "cpp", cc: "cpp", hpp: "cpp", rs: "rust", kt: "kotlin", swift: "swift",
  scala: "scala", sh: "shell", bash: "shell", ps1: "powershell", sql: "sql",
  html: "html", css: "css", scss: "scss", vue: "vue", svelte: "svelte",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml",
  md: "markdown", rst: "rst", txt: "text",
};

/** Works out a file's language from its extension. */
export function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGES[ext] ?? "text";
}

/**
 * Decides from the path alone whether a file should be skipped:
 * inside a skipped folder, a lock file, a secret file, a minified file, or a binary/media extension.
 */
export function isSkippedPath(path: string): boolean {
  const parts = path.split("/");
  const fileName = parts[parts.length - 1].toLowerCase();
  if (parts.slice(0, -1).some((dir) => SKIP_DIRS.has(dir))) return true;
  if (SKIP_FILES.has(fileName)) return true;
  if (isSecretFile(fileName)) return true;
  if (fileName.endsWith(".min.js") || fileName.endsWith(".min.css")) return true;
  const ext = fileName.includes(".") ? fileName.split(".").pop()! : "";
  return SKIP_EXTENSIONS.has(ext);
}

/**
 * Turns file bytes into text, or returns null if the file looks binary
 * (it has a null byte, or it isn't valid UTF-8).
 */
function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Rejects a repo before downloading if GitHub says it is bigger than the limit.
 * GitHub reports size in KB. Saves a pointless large download.
 */
export function checkRepoSize(repo: Repo): void {
  if (repo.sizeKb * 1024 > MAX_TOTAL_BYTES) {
    const mb = (repo.sizeKb / 1024).toFixed(0);
    throw new AppError(
      `This repo is too large to index (${mb} MB; the limit is ${MAX_TOTAL_BYTES / 1024 / 1024} MB).`,
      413,
    );
  }
}

/**
 * Reads a GitHub zip archive and returns the text files worth indexing.
 * Steps: strip the top folder GitHub adds, skip unwanted paths and files over
 * 500 KB, skip binary files, mask secrets, then check the total file count and size limits.
 */
export function extractSourceFiles(zip: Uint8Array): SourceFile[] {
  // GitHub puts everything inside one folder like "owner-repo-abc1234/". This removes it.
  const stripTop = (name: string) => name.slice(name.indexOf("/") + 1);

  // The filter runs before each file is unzipped, so skipped files cost nothing.
  const entries = unzipSync(zip, {
    filter: (f) => {
      const path = stripTop(f.name);
      return path !== "" && !path.endsWith("/") && f.originalSize <= MAX_FILE_BYTES && !isSkippedPath(path);
    },
  });

  const files: SourceFile[] = [];
  let totalBytes = 0;
  for (const [name, bytes] of Object.entries(entries)) {
    const text = decodeText(bytes);
    if (text === null) continue;
    const path = stripTop(name);
    files.push({ path, text: redactSecrets(text), language: detectLanguage(path) });
    totalBytes += bytes.length;
  }

  if (files.length > MAX_FILES) {
    throw new AppError(`This repo has too many files to index (${files.length}; the limit is ${MAX_FILES}).`, 413);
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    const mb = (totalBytes / 1024 / 1024).toFixed(1);
    throw new AppError(`This repo has too much code to index (${mb} MB; the limit is ${MAX_TOTAL_BYTES / 1024 / 1024} MB).`, 413);
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}
