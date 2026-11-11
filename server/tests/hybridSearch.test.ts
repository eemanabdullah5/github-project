// Tests for hybrid search (Phase 2): spotting code names, merging ranked lists, and when keyword search runs.
// The vector store is mocked, so no database or AI is needed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chunk } from "../src/types.js";

vi.mock("../src/vectorStore.js", () => ({
  query: vi.fn(),
  keywordQuery: vi.fn(),
}));
const { codeNames, mergeRanked, searchChunks } = await import("../src/hybridSearch.js");
const { query, keywordQuery } = await import("../src/vectorStore.js");

const chunk = (id: string): Chunk => ({
  id, text: id, path: `${id}.ts`, startLine: 1, endLine: 2,
  language: "typescript", symbol: "", symbolType: "lines", chunker: "lines",
});
const ids = (chunks: Chunk[]) => chunks.map((c) => c.id);

describe("codeNames", () => {
  it("finds camelCase, PascalCase, snake_case and file names", () => {
    expect(codeNames("Where is formatChunk used?")).toEqual(["formatChunk"]);
    expect(codeNames("What does RecommenderAgent do with MAX_HIDDEN_PAIRS?")).toEqual(["RecommenderAgent", "MAX_HIDDEN_PAIRS"]);
    expect(codeNames("What's in rag.ts and package.json?")).toEqual(["rag.ts", "package.json"]);
    expect(codeNames("Explain load_manifest.")).toEqual(["load_manifest"]);
  });

  it("takes anything in backticks, keeping only the name-like parts", () => {
    expect(codeNames("What does `query` return?")).toEqual(["query"]);
    expect(codeNames("Explain `foo(bar)` and `__init__`")).toEqual(["foo", "bar", "__init__"]);
  });

  it("ignores plain English, all-caps words and repeats", () => {
    expect(codeNames("How does indexing work?")).toEqual([]);
    expect(codeNames("Which API does the README mention? What about SQL?")).toEqual([]);
    expect(codeNames("Is toSources the same as `toSources`? toSources!")).toEqual(["toSources"]);
  });

  it("keeps at most 5 names", () => {
    expect(codeNames("aB cD eF gH iJ kL mN")).toHaveLength(5);
  });
});

describe("mergeRanked", () => {
  it("puts chunks found by both searches first, then the rest by rank", () => {
    const merged = mergeRanked([[chunk("a"), chunk("b"), chunk("c")], [chunk("x"), chunk("c")]], 4);
    // c is in both lists, so it wins. Then the two top-ranked chunks (a, x), then b.
    expect(ids(merged)).toEqual(["c", "a", "x", "b"]);
  });

  it("keeps a single list in its order, and returns at most k", () => {
    expect(ids(mergeRanked([[chunk("a"), chunk("b"), chunk("c")], []], 2))).toEqual(["a", "b"]);
  });
});

describe("searchChunks", () => {
  beforeEach(() => {
    vi.mocked(query).mockReset().mockResolvedValue([chunk("v1"), chunk("v2"), chunk("shared")]);
    vi.mocked(keywordQuery).mockReset().mockResolvedValue([chunk("shared"), chunk("k1")]);
  });

  it("uses vector search alone for plain-English questions", async () => {
    const result = await searchChunks("o/r", "How does indexing work?", [1, 0], 8);
    expect(keywordQuery).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith("o/r", [1, 0], 8, undefined);
    expect(result.names).toEqual([]);
    expect(ids(result.chunks)).toEqual(["v1", "v2", "shared"]);
  });

  it("adds keyword search when the question names code, with the same folder filter", async () => {
    const where = "starts_with(path, 'src/')";
    const result = await searchChunks("o/r", "Where is formatChunk used?", [1, 0], 4, where);
    expect(keywordQuery).toHaveBeenCalledWith("o/r", "formatChunk", 8, where);
    expect(query).toHaveBeenCalledWith("o/r", [1, 0], 8, where);
    expect(result.names).toEqual(["formatChunk"]);
    // "shared" was found by both, so it's first. k1 (keyword only) is added; on a tie the vector result goes first.
    expect(ids(result.chunks)).toEqual(["shared", "v1", "v2", "k1"]);
  });

  it("falls back to vector results if keyword search fails", async () => {
    vi.mocked(keywordQuery).mockRejectedValue(new Error("no index"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await searchChunks("o/r", "Where is formatChunk used?", [1, 0], 2);
    expect(ids(result.chunks)).toEqual(["v1", "v2"]);
    expect(result.names).toEqual([]);
  });
});
