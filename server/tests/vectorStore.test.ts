// Tests for the vector store, using a temporary folder instead of data/.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { fingerprint } from "../src/reuseEmbeddings.js";
import type { Chunk, Manifest } from "../src/types.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "vs-test-"));
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  DATA_DIR: tempDir,
}));
const { deleteIndex, keywordQuery, loadManifest, loadSavedVectors, query, saveIndex, tableName } = await import("../src/vectorStore.js");

afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

const chunk = (id: string): Chunk => ({
  id, text: `text ${id}`, path: `${id}.ts`, startLine: 1, endLine: 2,
  language: "typescript", symbol: "", symbolType: "lines", chunker: "lines",
});
const manifest = { repoId: "octo/hello", commitSha: "abc" } as Manifest;

describe("vectorStore", () => {
  it("names tables from a hash of the repo ID", () => {
    expect(tableName("octo/hello")).toMatch(/^repo_[0-9a-f]{16}$/);
  });

  it("saves, finds the nearest chunks, and deletes", async () => {
    await saveIndex("octo/hello", [chunk("a"), chunk("b"), chunk("c")], [[1, 0], [0, 1], [0.7, 0.7]], manifest);
    expect(await loadManifest("octo/hello")).toEqual(manifest);

    const results = await query("octo/hello", [1, 0.1], 2);
    expect(results.map((r) => r.id)).toEqual(["a", "c"]);
    expect(results[0]).toEqual(chunk("a")); // no vector or distance fields leak out

    await deleteIndex("octo/hello");
    expect(await loadManifest("octo/hello")).toBeNull();
  });

  // Phase 2 hybrid search: real keyword search on a real (temporary) LanceDB table.
  const named = (id: string, text: string, file = `src/${id}.ts`): Chunk => ({ ...chunk(id), text, path: file });
  const chunks = [
    named("a", "export function formatChunk(chunk) { return chunk.text; }"),
    named("b", "const text = formatChunk(c); // uses formatChunk", "web/b.ts"),
    named("c", "function somethingElse() { return 1; }"),
  ];
  const vectors = [[1, 0], [0, 1], [0.7, 0.7]];

  it("finds chunks containing a code name with keyword search, whole names only", async () => {
    await saveIndex("octo/kw", chunks, vectors, manifest);
    expect((await keywordQuery("octo/kw", "formatChunk", 5)).map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(await keywordQuery("octo/kw", "format", 5)).toEqual([]); // "format" alone isn't a whole name in the code
    expect(await keywordQuery("octo/kw", "FORMATCHUNK", 5)).toHaveLength(2); // case doesn't matter
  });

  it("applies the folder filter to keyword search too", async () => {
    const results = await keywordQuery("octo/kw", "formatChunk", 5, "starts_with(path, 'web/')");
    expect(results.map((r) => r.id)).toEqual(["b"]);
    expect(results[0]).toEqual(chunks[1]); // no score fields leak out
  });

  it("reads the saved vectors by text fingerprint, for incremental re-index", async () => {
    await saveIndex("octo/reuse", chunks, vectors, manifest);
    const saved = await loadSavedVectors("octo/reuse");
    expect(saved.size).toBe(3);
    const vector = saved.get(fingerprint(chunks[1].text))!;
    expect(vector[0]).toBeCloseTo(0);
    expect(vector[1]).toBeCloseTo(1);
    expect(await loadSavedVectors("octo/never-indexed")).toEqual(new Map());
  });

  it("builds the keyword index on first use for tables made before hybrid search", async () => {
    // A table created directly, without the keyword index (like a repo indexed before this feature).
    const lancedb = await import("@lancedb/lancedb");
    const db = await lancedb.connect(path.join(tempDir, "lancedb"));
    await db.createTable(tableName("octo/old"), chunks.map((c, i) => ({ ...c, vector: vectors[i] })));
    expect((await keywordQuery("octo/old", "somethingElse", 5)).map((r) => r.id)).toEqual(["c"]);
  });
});
