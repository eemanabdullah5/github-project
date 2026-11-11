// Vector store: saves each repo's code chunks and finds the ones that match a question.
//
// Two ways to search:
//  - query()        → by meaning (vectors). Good for "how does login work?"
//  - keywordQuery() → by exact word.        Good for "where is formatChunk used?"
// hybridSearch.ts decides when to use both.
//
// On disk:
//  - data/lancedb/    one table per repo (chunks + vectors + keyword index)
//  - data/manifests/  one small JSON per repo: what was indexed, and from which commit
// The manifest is written last, so a half-finished index never looks complete.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { DATA_DIR } from "./config.js";
import { fingerprint } from "./reuseEmbeddings.js";
import type { Chunk, Manifest } from "./types.js";

const DB_DIR = path.join(DATA_DIR, "lancedb");
const MANIFEST_DIR = path.join(DATA_DIR, "manifests");

/** Opens the database folder (creates it if missing). */
async function openDb() {
  return lancedb.connect(DB_DIR);
}

/** The repo's table name, e.g. "repo_7cb1b7c858759292". Why a hash: repo names can have characters tables can't. */
export function tableName(repoId: string): string {
  return `repo_${createHash("sha1").update(repoId).digest("hex").slice(0, 16)}`;
}

/** Where the repo's manifest is saved, e.g. data/manifests/octo__hello.json. */
function manifestPath(repoId: string): string {
  return path.join(MANIFEST_DIR, `${repoId.replace("/", "__")}.json`);
}

/** Reads the repo's manifest. Returns null if the repo was never fully indexed. */
export async function loadManifest(repoId: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(manifestPath(repoId), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

/** Deletes the repo's index. The manifest goes first, so the index stops looking complete straight away. */
export async function deleteIndex(repoId: string): Promise<void> {
  await rm(manifestPath(repoId), { force: true });
  keywordIndexReady.delete(repoId); // Why: the new table will need its own keyword index
  const db = await openDb();
  if ((await db.tableNames()).includes(tableName(repoId))) {
    await db.dropTable(tableName(repoId));
  }
}

/**
 * Saves a fresh index: deletes the old one, saves the chunks with their vectors,
 * builds the keyword index, then writes the manifest last.
 */
export async function saveIndex(repoId: string, chunks: Chunk[], vectors: number[][], manifest: Manifest): Promise<void> {
  await deleteIndex(repoId);
  const rows = chunks.map((chunk, i) => ({ ...chunk, vector: vectors[i] }));
  const db = await openDb();
  const table = await db.createTable(tableName(repoId), rows);
  // If the keyword index fails, indexing still succeeds: meaning search doesn't need it,
  // and the next keyword search tries to build it again.
  await ensureKeywordIndex(repoId, table).catch((err) => console.error("Keyword index not built:", err instanceof Error ? err.message : err));

  await mkdir(MANIFEST_DIR, { recursive: true });
  await writeFile(manifestPath(repoId), JSON.stringify(manifest, null, 2));
}

/**
 * The repo's saved vectors, by text fingerprint (for incremental re-index, see reuseEmbeddings.ts).
 * Empty if the repo has no index yet. Why read the text, not a stored fingerprint: indexes made before
 * this feature have the text too, so they can be reused without re-indexing everything once.
 */
export async function loadSavedVectors(repoId: string): Promise<Map<string, number[]>> {
  const db = await openDb();
  if (!(await db.tableNames()).includes(tableName(repoId))) return new Map();
  const table = await db.openTable(tableName(repoId));
  const rows = await table.query().select(["text", "vector"]).toArray();
  return new Map(rows.map((r) => [fingerprint(r.text as string), Array.from(r.vector as Iterable<number>)]));
}

/** Turns a database row into a plain chunk (drops the vector and the score). Used by both searches. */
function toChunk(r: Record<string, unknown>): Chunk {
  return {
    id: r.id as string,
    text: r.text as string,
    path: r.path as string,
    startLine: r.startLine as number,
    endLine: r.endLine as number,
    language: r.language as string,
    symbol: r.symbol as string,
    symbolType: r.symbolType as Chunk["symbolType"],
    chunker: r.chunker as Chunk["chunker"],
  };
}

/**
 * Search by meaning: the k chunks closest to the question's vector, best first.
 * `where` (optional) limits it to one folder or file ("Ask about one folder").
 * Why the filter runs before the search: so a small folder still gets its k best chunks.
 */
export async function query(repoId: string, vector: number[], k: number, where?: string): Promise<Chunk[]> {
  const db = await openDb();
  const table = await db.openTable(tableName(repoId));
  let search = table.vectorSearch(vector).distanceType("cosine");
  if (where) search = search.where(where);
  return (await search.limit(k).toArray()).map(toChunk);
}

// ---------- Keyword search (for hybrid search) ----------

// Keyword index settings.
//  - "code" tokenizer: keeps camelCase / snake_case names whole, so searching "format" doesn't match formatChunk.
//  - lowercase: case in the question doesn't matter.
//  - no stemming: code names must match exactly.
// Why a function: LanceDB's settings object can only be used once.
const keywordIndexConfig = () => lancedb.Index.fts({ baseTokenizer: "code", lowercase: true, stem: false, removeStopWords: false });

// Repos whose keyword index is ready (or being built right now).
// Why: so we check only once, and two questions at the same time don't both build it.
const keywordIndexReady = new Map<string, Promise<void>>();

/**
 * Makes sure the repo has a keyword index, and builds it if not (under a second).
 * Why: repos indexed before hybrid search get one automatically, with no Re-index.
 */
async function ensureKeywordIndex(repoId: string, table: lancedb.Table): Promise<void> {
  let ready = keywordIndexReady.get(repoId);
  if (!ready) {
    ready = (async () => {
      const indices = await table.listIndices();
      const exists = indices.some((i) => i.indexType === "FTS" && i.columns.includes("text"));
      if (!exists) await table.createIndex("text", { config: keywordIndexConfig(), replace: true });
    })();
    keywordIndexReady.set(repoId, ready);
    ready.catch(() => keywordIndexReady.delete(repoId)); // if it failed, try again next time
  }
  return ready;
}

/**
 * Search by exact word: up to k chunks that contain the words in `text`, best first.
 * `where` works the same as in query().
 */
export async function keywordQuery(repoId: string, text: string, k: number, where?: string): Promise<Chunk[]> {
  const db = await openDb();
  const table = await db.openTable(tableName(repoId));
  await ensureKeywordIndex(repoId, table);
  let search = table.query().fullTextSearch(text);
  if (where) search = search.where(where);
  return (await search.limit(k).toArray()).map(toChunk);
}
