// Ingestion (ARCHITECTURE §6): turns a downloaded zip into a list of text files.
// It skips things that aren't useful to the AI (dependencies, build output, images,
// lock files, minified files, binaries, huge files) and enforces the size limits.
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
 * inside a skipped folder, a lock file, a minified file, or a binary/media extension.
 */
export function isSkippedPath(path: string): boolean {
  const parts = path.split("/");
  const fileName = parts[parts.length - 1].toLowerCase();
  if (parts.slice(0, -1).some((dir) => SKIP_DIRS.has(dir))) return true;
  if (SKIP_FILES.has(fileName)) return true;
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
 * 500 KB, skip binary files, then check the total file count and size limits.
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
    files.push({ path, text, language: detectLanguage(path) });
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
