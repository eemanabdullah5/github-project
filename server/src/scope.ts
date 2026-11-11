// Phase 2 — Ask about one folder: limit a chat question to a folder or file, such as "server/src" or "web/src/api.ts".
// The search then only looks at code inside it, so all 8 retrieved chunks are about that area.
//
// Safety: the scope comes from the browser, so it's never put into the search filter as typed. It must match a
// folder or file in the repo's index (the manifest's file tree), and quotes are escaped before it goes into
// LanceDB's filter. Anything else is rejected with a clear message.
import { AppError } from "./errors.js";

export interface Scope {
  kind: "folder" | "file";
  path: string; // e.g. "server/src" (no slash at either end) or "web/src/api.ts"
}

/** Longest scope accepted. Real paths are much shorter; this stops someone sending a huge string. */
const MAX_SCOPE_LENGTH = 500;

/**
 * Tidies what the user typed into a repo path: "./server/src/", "/server/src" and "server\\src" all become "server/src".
 * Returns "" for "the whole repo".
 */
export function normalizeScope(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .replace(/\\/g, "/") // Windows-style slashes
    .replace(/\/{2,}/g, "/") // "a//b" → "a/b"
    .replace(/^(?:\.\/|\/)+/, "") // leading "./" or "/"
    .replace(/\/+$/, ""); // trailing "/"
}

/** Every folder that contains at least one indexed file, sorted. Used for the folder picker in the chat. */
export function listFolders(fileTree: string): string[] {
  const folders = new Set<string>();
  for (const file of fileTree.split("\n")) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  return [...folders].sort();
}

/**
 * Checks the scope against the indexed files. Returns null for the whole repo.
 * Throws a 400 error if it isn't a folder or file in the index.
 */
export function resolveScope(raw: unknown, fileTree: string): Scope | null {
  const scopePath = normalizeScope(raw);
  if (!scopePath) return null;
  if (scopePath.length > MAX_SCOPE_LENGTH) throw new AppError("That folder path is too long.", 400);

  const files = fileTree.split("\n").filter(Boolean);
  if (files.includes(scopePath)) return { kind: "file", path: scopePath };
  if (files.some((f) => f.startsWith(`${scopePath}/`))) return { kind: "folder", path: scopePath };
  throw new AppError(`"${scopePath}" isn't a folder or file in this repo's index. Pick one from the list, or clear it to search the whole repo.`, 400);
}

/** The LanceDB filter for a scope: an exact prefix match for a folder (no wildcards), an exact match for a file. */
export function scopeFilter(scope: Scope): string {
  const quoted = scope.path.replace(/'/g, "''"); // SQL escaping: ' becomes ''
  return scope.kind === "folder" ? `starts_with(path, '${quoted}/')` : `path = '${quoted}'`;
}
