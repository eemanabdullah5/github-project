// Tests for the vector store, using a temporary folder instead of data/.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Chunk, Manifest } from "../src/types.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "vs-test-"));
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  DATA_DIR: tempDir,
}));
const { deleteIndex, loadManifest, query, saveIndex, tableName } = await import("../src/vectorStore.js");

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
});
