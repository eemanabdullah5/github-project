// Tests for incremental re-index: matching chunks by their text and putting the vectors back in order. No network.
import { describe, expect, it } from "vitest";
import { fingerprint, planEmbedding } from "../src/reuseEmbeddings.js";
import type { Chunk } from "../src/types.js";

const chunk = (id: string, text: string): Chunk => ({
  id, text, path: "a.ts", startLine: 1, endLine: 2, language: "typescript", symbol: "", symbolType: "lines", chunker: "lines",
});

describe("fingerprint", () => {
  it("is the same for the same text and different for different text", () => {
    expect(fingerprint("const a = 1;")).toBe(fingerprint("const a = 1;"));
    expect(fingerprint("const a = 1;")).not.toBe(fingerprint("const a = 2;"));
  });
});

describe("planEmbedding", () => {
  const saved = new Map([
    [fingerprint("unchanged one"), [1, 1]],
    [fingerprint("unchanged two"), [2, 2]],
  ]);

  it("embeds only new or changed chunks and keeps every vector in chunk order", () => {
    // Chunk ids moved (code was added above), but the text of two chunks is the same as last time.
    const chunks = [chunk("a.ts#0", "brand new"), chunk("a.ts#1", "unchanged one"), chunk("a.ts#2", "edited"), chunk("a.ts#3", "unchanged two")];
    const plan = planEmbedding(chunks, saved);
    expect(plan.toEmbed.map((c) => c.text)).toEqual(["brand new", "edited"]);
    expect(plan.reused).toBe(2);
    expect(plan.combine([[9, 9], [8, 8]])).toEqual([[9, 9], [1, 1], [8, 8], [2, 2]]);
  });

  it("embeds everything when there's nothing saved (first index, or the model changed)", () => {
    const plan = planEmbedding([chunk("x", "a"), chunk("y", "b")], new Map());
    expect(plan.toEmbed).toHaveLength(2);
    expect(plan.reused).toBe(0);
  });

  it("needs no AI call when nothing changed", () => {
    const plan = planEmbedding([chunk("x", "unchanged one")], saved);
    expect(plan.toEmbed).toEqual([]);
    expect(plan.combine([])).toEqual([[1, 1]]);
  });

  it("refuses to combine if the AI returned the wrong number of vectors", () => {
    const plan = planEmbedding([chunk("x", "new")], saved);
    expect(() => plan.combine([])).toThrow("Expected 1 new vectors, got 0.");
  });
});
