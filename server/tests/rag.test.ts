// Tests for buildPrompt: order, delimiters, history window and the prompt budget.
import { describe, expect, it } from "vitest";
import { MAX_TREE_LINES } from "../src/config.js";
import { SYSTEM_RULES, buildPrompt } from "../src/rag.js";
import type { ChatMessage, Chunk } from "../src/types.js";

const chunk = (id: string, text = `code ${id}`): Chunk => ({
  id, text, path: `src/${id}.ts`, startLine: 1, endLine: 10,
  language: "typescript", symbol: id === "a" ? "login" : "", symbolType: "lines", chunker: "lines",
});
const manifest = { repoId: "octo/hello", fileTree: "README.md\nsrc/a.ts", readme: "# Hello project" };

describe("buildPrompt", () => {
  it("puts rules, repo context, chunks, history and question in order", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ];
    const { messages, usedChunks } = buildPrompt({ question: "Where is login?", history, chunks: [chunk("a"), chunk("b")], manifest });

    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages.at(-1)!.content).toBe("Where is login?");

    const system = messages[0].content;
    expect(system.startsWith(SYSTEM_RULES)).toBe(true);
    const order = ["<<<REPO FILE TREE>>>", "<<<REPO README>>>", "<<<REPO CHUNK 1: src/a.ts | login | Lines 1-10>>>", "<<<REPO CHUNK 2: src/b.ts | Lines 1-10>>>"];
    const positions = order.map((marker) => system.indexOf(marker));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    expect(system).toContain("<<<END CHUNK 2>>>");
    expect(usedChunks.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("keeps only the last 3 exchanges of history", () => {
    const history: ChatMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i}`,
    }));
    const { messages } = buildPrompt({ question: "q", history, chunks: [], manifest });
    expect(messages.slice(1, -1).map((m) => m.content)).toEqual(["m4", "m5", "m6", "m7", "m8", "m9"]);
  });

  it("drops the lowest-ranked chunks when over budget", () => {
    const big = "x".repeat(3000 * 4); // ≈ 3,000 tokens each
    const chunks = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => chunk(id, big));
    const { usedChunks, messages } = buildPrompt({ question: "q", history: [], chunks, manifest });
    expect(usedChunks.length).toBeLessThan(8);
    expect(usedChunks.length).toBeGreaterThan(0);
    expect(usedChunks.map((c) => c.id)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"].slice(0, usedChunks.length));
    expect(messages[0].content).not.toContain(`CHUNK ${usedChunks.length + 1}:`);
  });

  it("truncates a long file tree", () => {
    const fileTree = Array.from({ length: MAX_TREE_LINES + 50 }, (_, i) => `f${i}.ts`).join("\n");
    const { messages } = buildPrompt({ question: "q", history: [], chunks: [], manifest: { ...manifest, fileTree } });
    expect(messages[0].content).toContain("… (50 more files)");
    expect(messages[0].content).not.toContain(`f${MAX_TREE_LINES}.ts\n`);
  });
});
