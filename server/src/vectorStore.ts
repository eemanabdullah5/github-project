// Vector store (ARCHITECTURE §8.2–8.3): saves chunks and their vectors to disk with LanceDB,
// and finds the chunks closest to a question's vector.
// Each repo gets its own table in data/lancedb/, plus a small JSON "manifest" in
// data/manifests/ describing what was indexed and from which commit.
// The manifest is written LAST, so a half-finished index never looks complete.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { DATA_DIR } from "./config.js";
import type { Chunk, Manifest } from "./types.js";

const DB_DIR = path.join(DATA_DIR, "lancedb");
const MANIFEST_DIR = path.join(DATA_DIR, "manifests");

/** Opens (or creates) the LanceDB database folder. */
async function openDb() {
  return lancedb.connect(DB_DIR);
}

/** Table name for a repo: "repo_" + the first 16 characters of a hash of "owner/repo". */
export function tableName(repoId: string): string {
  return `repo_${createHash("sha1").update(repoId).digest("hex").slice(0, 16)}`;
}

/** File path of a repo's manifest, e.g. data/manifests/octo__hello.json. */
function manifestPath(repoId: string): string {
  return path.join(MANIFEST_DIR, `${repoId.replace("/", "__")}.json`);
}

/** Reads a repo's manifest, or returns null if the repo has never been fully indexed. */
export async function loadManifest(repoId: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(manifestPath(repoId), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

/** Removes a repo's manifest and table. The manifest goes first, so the index stops looking complete. */
export async function deleteIndex(repoId: string): Promise<void> {
  await rm(manifestPath(repoId), { force: true });
  const db = await openDb();
  if ((await db.tableNames()).includes(tableName(repoId))) {
    await db.dropTable(tableName(repoId));
  }
}

/**
 * Saves a full index: drops any old one, writes every chunk with its vector
 * into a fresh table, then writes the manifest last.
 */
export async function saveIndex(repoId: string, chunks: Chunk[], vectors: number[][], manifest: Manifest): Promise<void> {
  await deleteIndex(repoId);
  const rows = chunks.map((chunk, i) => ({ ...chunk, vector: vectors[i] }));
  const db = await openDb();
  await db.createTable(tableName(repoId), rows);

  await mkdir(MANIFEST_DIR, { recursive: true });
  await writeFile(manifestPath(repoId), JSON.stringify(manifest, null, 2));
}

/**
 * Returns the k chunks whose vectors are closest to the question's vector, best match first.
 * `where` (optional) is a LanceDB filter applied before the search, e.g. from scopeFilter() in scope.ts,
 * so a small folder still gets its k best chunks instead of whatever survives a repo-wide top k.
 */
export async function query(repoId: string, vector: number[], k: number, where?: string): Promise<Chunk[]> {
  const db = await openDb();
  const table = await db.openTable(tableName(repoId));
  let search = table.vectorSearch(vector).distanceType("cosine");
  if (where) search = search.where(where);
  const rows = await search.limit(k).toArray();
  // Return only the Chunk fields (drop the vector and the distance score).
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    path: r.path,
    startLine: r.startLine,
    endLine: r.endLine,
    language: r.language,
    symbol: r.symbol,
    symbolType: r.symbolType,
    chunker: r.chunker,
  }));
}
