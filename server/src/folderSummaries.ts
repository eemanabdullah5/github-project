// Phase 3 folder summaries: a short AI summary of each folder, written while indexing.
// Big-picture questions ("what are the main parts?") get the most related summaries in the prompt,
// instead of only 8 scattered code chunks.
// Saved in data/summaries/ with one vector each. A re-index only re-summarizes folders whose code changed.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  config,
  DATA_DIR,
  FOLDER_INPUT_CHARS,
  FOLDERS_PER_REQUEST,
  MAX_FOLDER_SUMMARIES,
  MIN_FILES_PER_FOLDER,
  SUMMARIES_IN_PROMPT,
  SUMMARY_CONCURRENCY,
} from "./config.js";
import { chat, embedDocuments } from "./llm.js";
import { FOLDER_SUMMARY_PROMPT } from "./prompts.js";
import { fingerprint } from "./reuseEmbeddings.js";
import type { Scope } from "./scope.js";
import type { SourceFile } from "./types.js";

const SUMMARIES_DIR = path.join(DATA_DIR, "summaries");
const MAX_SUMMARY_CHARS = 800; // cuts off a summary that runs too long
const MAX_NAMES_LISTED = 50; // file names listed per folder

export interface FolderSummary {
  path: string; // e.g. "server/src"
  fileCount: number; // files directly inside
  summary: string;
  fingerprint: string; // of the code sent to the AI, to know if it changed
  vector: number[];
}

export interface SummaryFile {
  repoId: string;
  commitSha: string;
  chatModel: string;
  embedModel: string;
  folders: FolderSummary[];
}

/** A folder to summarize and the files directly inside it. */
interface FolderInput {
  path: string;
  files: SourceFile[];
}

/** The folders worth a summary: at least 2 files directly inside, the biggest 40, sorted by path. Root is skipped (the README covers it). */
export function pickFolders(files: SourceFile[]): FolderInput[] {
  const byFolder = new Map<string, SourceFile[]>();
  for (const file of files) {
    const dir = path.posix.dirname(file.path);
    if (dir === ".") continue;
    byFolder.set(dir, [...(byFolder.get(dir) ?? []), file]);
  }
  return [...byFolder]
    .filter(([, list]) => list.length >= MIN_FILES_PER_FOLDER)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_FOLDER_SUMMARIES)
    .map(([dir, list]) => ({ path: dir, files: [...list].sort((a, b) => a.path.localeCompare(b.path)) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** What the AI sees for one folder: its file names, then the start of each file, up to FOLDER_INPUT_CHARS. */
export function folderInput(folder: FolderInput): string {
  const names = folder.files.map((f) => path.posix.basename(f.path));
  const more = names.length > MAX_NAMES_LISTED ? `, … (${names.length - MAX_NAMES_LISTED} more)` : "";
  let text = `Files: ${names.slice(0, MAX_NAMES_LISTED).join(", ")}${more}\n`;
  const perFile = Math.max(200, Math.floor(FOLDER_INPUT_CHARS / folder.files.length));
  for (const file of folder.files) {
    if (text.length >= FOLDER_INPUT_CHARS) break;
    text += `\n--- ${path.posix.basename(file.path)} ---\n${file.text.slice(0, perFile)}\n`;
  }
  return text.slice(0, FOLDER_INPUT_CHARS);
}

/** Reads the AI's "### folder\nsummary" blocks into folder → summary. Ignores folders that weren't asked for. */
export function parseSummaries(reply: string, asked: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const block of reply.split(/^#{2,4}\s+/m).slice(1)) {
    const [heading, ...body] = block.split("\n");
    const folder = heading.trim().replace(/^[`"']+|[`"':/]+$/g, "").replace(/\/$/, "");
    const summary = body.join("\n").replace(/<\/?summary>/gi, "").trim(); // drops <summary> tags if the AI adds them
    if (asked.includes(folder) && summary) result.set(folder, summary.slice(0, MAX_SUMMARY_CHARS));
  }
  return result;
}

/** The text that gets embedded for a summary. */
function embedText(s: Pick<FolderSummary, "path" | "summary">): string {
  return `Folder ${s.path}: ${s.summary}`;
}

/**
 * Summarizes the repo's folders, reusing last time's summary for folders whose code didn't change.
 * If an AI call fails, it stops and keeps the summaries it already has (a partial set still helps).
 * onProgress gets (done, total) in folders, for the progress bar.
 */
export async function buildFolderSummaries(
  files: SourceFile[],
  ctx: { repoId: string; commitSha: string },
  previous: SummaryFile | null,
  onProgress?: (done: number, total: number) => void,
): Promise<SummaryFile> {
  const sameChat = previous?.chatModel === config.chatModel;
  const sameEmbed = previous?.embedModel === config.embedModel;
  const old = new Map((sameChat ? previous!.folders : []).map((f) => [f.fingerprint, f]));

  // Reuse unchanged folders; the rest go to the AI.
  const folders = pickFolders(files).map((f) => {
    const input = folderInput(f);
    const fp = fingerprint(`${f.path}\n${input}`);
    const kept = old.get(fp);
    return { path: f.path, fileCount: f.files.length, input, fp, summary: kept?.summary ?? "", vector: sameEmbed ? (kept?.vector ?? []) : [] };
  });
  const todo = folders.filter((f) => !f.summary);
  onProgress?.(0, todo.length);

  // Summarize a few folders per AI call, with up to SUMMARY_CONCURRENCY calls at once.
  const batches: Array<typeof todo> = [];
  for (let i = 0; i < todo.length; i += FOLDERS_PER_REQUEST) batches.push(todo.slice(i, i + FOLDERS_PER_REQUEST));
  let next = 0;
  let finished = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < batches.length) {
      const batch = batches[next++];
      const user = batch.map((f) => `<<<REPO FOLDER ${f.path}>>>\n${f.input}\n<<<END FOLDER>>>`).join("\n\n");
      try {
        const reply = await chat([
          { role: "system", content: FOLDER_SUMMARY_PROMPT },
          { role: "user", content: user },
        ]);
        const parsed = parseSummaries(reply, batch.map((f) => f.path));
        for (const f of batch) f.summary = parsed.get(f.path) ?? "";
      } catch (err) {
        if (!stopped) console.error("Folder summaries stopped early:", err instanceof Error ? err.message : err);
        stopped = true; // no new calls; keep what's done
      }
      finished += batch.length;
      onProgress?.(finished, todo.length);
    }
  };
  await Promise.all(Array.from({ length: SUMMARY_CONCURRENCY }, worker));

  // Embed the summaries that don't have a vector yet.
  const done = folders.filter((f) => f.summary);
  const needVector = done.filter((f) => f.vector.length === 0);
  const vectors = await embedDocuments(needVector.map(embedText));
  needVector.forEach((f, i) => (f.vector = vectors[i]));

  return {
    repoId: ctx.repoId,
    commitSha: ctx.commitSha,
    chatModel: config.chatModel,
    embedModel: config.embedModel,
    folders: done.map((f) => ({ path: f.path, fileCount: f.fileCount, summary: f.summary, fingerprint: f.fp, vector: f.vector })),
  };
}

/** Where a repo's summaries are saved, e.g. data/summaries/octo__hello.json. */
function summaryPath(repoId: string): string {
  return path.join(SUMMARIES_DIR, `${repoId.replace("/", "__")}.json`);
}

/** Reads a repo's saved summaries, or null if there are none. */
export async function loadSummaries(repoId: string): Promise<SummaryFile | null> {
  try {
    return JSON.parse(await readFile(summaryPath(repoId), "utf8")) as SummaryFile;
  } catch {
    return null;
  }
}

export async function saveSummaries(file: SummaryFile): Promise<void> {
  await mkdir(SUMMARIES_DIR, { recursive: true });
  await writeFile(summaryPath(file.repoId), JSON.stringify(file));
}

/** Cosine similarity of two vectors (0 if either is empty or the lengths differ). */
function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** True if a summary belongs to the scope: the folder is inside it, or contains it. */
function inScope(folder: string, scope: Scope | null): boolean {
  if (!scope) return true;
  return folder === scope.path || folder.startsWith(`${scope.path}/`) || scope.path.startsWith(`${folder}/`);
}

/** The summaries closest to the question's vector, best first, as one text block for the prompt. Null if none. */
export function relevantSummaries(file: SummaryFile, vector: number[], scope: Scope | null, k = SUMMARIES_IN_PROMPT): string | null {
  const best = file.folders
    .filter((f) => inScope(f.path, scope))
    .map((f) => ({ f, score: cosine(f.vector, vector) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  if (best.length === 0) return null;
  return best.map(({ f }) => `${f.path}/ (${f.fileCount} files): ${f.summary}`).join("\n\n");
}

/** Summaries for chat, only if they match the indexed commit and embedding model (else they'd be stale). */
export async function summariesForChat(repoId: string, commitSha: string): Promise<SummaryFile | null> {
  const file = await loadSummaries(repoId);
  return file && file.commitSha === commitSha && file.embedModel === config.embedModel ? file : null;
}
