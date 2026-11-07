// Tests for the line chunker: line numbers, overlap and the size cap.
import { describe, expect, it } from "vitest";
import { MAX_CHUNK_CHARS, lineChunker } from "../src/chunking/lineChunker.js";
import type { SourceFile } from "../src/types.js";

function file(lineCount: number, lineText = (i: number) => `line ${i}`): SourceFile {
  const lines = Array.from({ length: lineCount }, (_, i) => lineText(i + 1));
  return { path: "src/a.ts", text: lines.join("\n"), language: "typescript" };
}

describe("lineChunker", () => {
  it("returns nothing for an empty file", () => {
    expect(lineChunker({ path: "a.txt", text: "  \n", language: "text" })).toEqual([]);
  });

  it("keeps a short file as one chunk with a header", () => {
    const [chunk, ...rest] = lineChunker(file(5));
    expect(rest).toHaveLength(0);
    expect(chunk).toMatchObject({ startLine: 1, endLine: 5, symbolType: "lines", chunker: "lines", path: "src/a.ts" });
    expect(chunk.text.split("\n")[0]).toBe("File: src/a.ts | Lines 1-5");
    expect(chunk.text).toContain("line 5");
  });

  it("uses 60-line windows with 10 lines of overlap", () => {
    const chunks = lineChunker(file(130));
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 60],
      [51, 110],
      [101, 130],
    ]);
    expect(new Set(chunks.map((c) => c.id)).size).toBe(3);
  });

  it("never makes a chunk bigger than the cap", () => {
    const chunks = lineChunker(file(60, (i) => `${i} ${"x".repeat(200)}`));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    // Windows still overlap and cover the whole file.
    expect(chunks[0].startLine).toBe(1);
    expect(chunks.at(-1)!.endLine).toBe(60);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].startLine).toBeLessThanOrEqual(chunks[i - 1].endLine);
  });

  it("cuts a single giant line instead of making a huge chunk", () => {
    const chunks = lineChunker({ path: "data.json", text: "x".repeat(10_000), language: "json" });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });
});
