// Tests for the syntax chunker: one per language, plus decorators/comments, big classes,
// oversized functions, module code and the fallback on syntax errors.
import { describe, expect, it } from "vitest";
import { chunkFile } from "../src/chunking/index.js";
import { MAX_CHUNK_CHARS } from "../src/chunking/lineChunker.js";
import { syntaxChunker } from "../src/chunking/syntaxChunker.js";
import type { Chunk, SourceFile } from "../src/types.js";

const src = (path: string, language: string, lines: string[]): SourceFile => ({ path, language, text: lines.join("\n") });

/** A short summary of each chunk: [symbol, symbolType, startLine, endLine]. */
const shape = (chunks: Chunk[] | null) => chunks!.map((c) => [c.symbol, c.symbolType, c.startLine, c.endLine]);

describe("syntaxChunker", () => {
  it("Python: functions with decorators and comments, a class, and module code", async () => {
    const file = src("app.py", "python", [
      "import os", //                 1
      "",
      "# Says hello.", //             3
      "@cache", //                    4
      "def hello(name):", //          5
      "    return name",
      "",
      "class User:", //               8
      "    def save(self):",
      "        pass", //              10
      "",
      "MAX = 3", //                   12
    ]);
    const chunks = await syntaxChunker(file);
    expect(shape(chunks)).toEqual([
      ["", "module", 1, 2],
      ["hello", "function", 3, 6],
      ["User", "class", 8, 10],
      ["", "module", 11, 12],
    ]);
    expect(chunks!.every((c) => c.chunker === "syntax")).toBe(true);
    expect(chunks![1].text.split("\n")[0]).toBe("File: app.py | Symbol: hello (function) | Lines 3-6");
    expect(chunks![1].text).toContain("@cache");
  });

  it("JavaScript: function, exported arrow function and class", async () => {
    const file = src("a.js", "javascript", [
      "function add(a, b) {", //       1
      "  return a + b;",
      "}",
      "/** Logs in. */", //            4
      "export const login = async (user) => {",
      "  return user;",
      "};", //                         7
      "class Cart {", //               8
      "  total() { return 0; }",
      "}", //                          10
    ]);
    expect(shape(await syntaxChunker(file))).toEqual([
      ["add", "function", 1, 3],
      ["login", "function", 4, 7],
      ["Cart", "class", 8, 10],
    ]);
  });

  it("TypeScript and TSX parse with their own grammars", async () => {
    const ts = src("a.ts", "typescript", ["export function f(x: number): number {", "  return x;", "}"]);
    expect(shape(await syntaxChunker(ts))).toEqual([["f", "function", 1, 3]]);

    const tsx = src("A.tsx", "tsx", ["export const App = () => {", "  return <div>Hi</div>;", "};"]);
    expect(shape(await syntaxChunker(tsx))).toEqual([["App", "function", 1, 3]]);
  });

  it("Java: a class", async () => {
    const file = src("A.java", "java", ["package demo;", "", "public class A {", "  void run() {}", "}"]);
    expect(shape(await syntaxChunker(file))).toEqual([
      ["", "module", 1, 2],
      ["A", "class", 3, 5],
    ]);
  });

  it("Go: function, method and type", async () => {
    const file = src("main.go", "go", [
      "package main", //                  1
      "",
      "type Server struct{}", //          3
      "",
      "func (s *Server) Start() {}", //   5
      "",
      "// main starts it.", //            7
      "func main() {}", //                8
    ]);
    // Blank lines between definitions don't become chunks.
    expect(shape(await syntaxChunker(file))).toEqual([
      ["", "module", 1, 2],
      ["Server", "class", 3, 3],
      ["Start", "method", 5, 5],
      ["main", "function", 7, 8],
    ]);
  });

  it("splits a class that is too big into methods, each starting with the class line", async () => {
    const body = (name: string) => [`  ${name}() {`, ...Array.from({ length: 30 }, (_, i) => `    const v${i} = "${"x".repeat(40)}";`), "  }"];
    const file = src("big.ts", "typescript", ["class Big {", "  field = 1;", ...body("one"), ...body("two"), "}"]);
    const chunks = (await syntaxChunker(file))!;

    const methods = chunks.filter((c) => c.symbolType === "method");
    expect(methods.map((c) => c.symbol)).toEqual(["Big.one", "Big.two"]);
    for (const m of methods) expect(m.text.split("\n")[1]).toBe("class Big {");
    expect(methods[0]).toMatchObject({ startLine: 3, endLine: 34 });
    // The header line and field are kept in a "class" chunk.
    expect(chunks.some((c) => c.symbolType === "class" && c.symbol === "Big" && c.startLine === 1)).toBe(true);
  });

  it("splits an oversized function into parts that repeat the signature", async () => {
    const file = src("long.py", "python", ["def long_one():", ...Array.from({ length: 200 }, (_, i) => `    v${i} = ${"1".repeat(40)}`)]);
    const chunks = (await syntaxChunker(file))!;
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => {
      expect(c.symbol).toBe(`long_one part ${i + 1}/${chunks.length}`);
      expect(c.text.split("\n")[1]).toBe("def long_one():");
      expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    });
    expect(chunks[0].startLine).toBe(1);
    expect(chunks.at(-1)!.endLine).toBe(201);
  });

  it("returns null for syntax errors and unsupported languages", async () => {
    expect(await syntaxChunker(src("bad.py", "python", ["def broken(:", "  pass"]))).toBeNull();
    expect(await syntaxChunker(src("a.rb", "ruby", ["def x; end"]))).toBeNull();
  });
});

describe("chunkFile", () => {
  it("uses the syntax chunker for supported languages", async () => {
    const chunks = await chunkFile(src("a.py", "python", ["def f():", "    pass"]));
    expect(chunks[0]).toMatchObject({ chunker: "syntax", symbol: "f" });
  });

  it("falls back to line chunks for syntax errors and other languages", async () => {
    expect((await chunkFile(src("bad.py", "python", ["def broken(:"])))[0].chunker).toBe("lines");
    expect((await chunkFile(src("README.md", "markdown", ["# Hi"])))[0].chunker).toBe("lines");
  });
});
