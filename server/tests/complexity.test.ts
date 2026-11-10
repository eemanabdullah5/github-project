// Tests for F4 complexity: per-function cognitive complexity with tree-sitter, and the fallback estimate.
import { describe, expect, it } from "vitest";
import { countDecisionPoints, estimateComplexity, measureComplexity } from "../src/complexity.js";
import type { SourceFile } from "../src/types.js";

const src = (path: string, language: string, lines: string[]): SourceFile => ({ path, language, text: lines.join("\n") });

describe("measureComplexity", () => {
  it("adds 1 extra for each level of nesting (TypeScript)", async () => {
    const file = src("a.ts", "typescript", [
      "function process(items: Item[]) {",
      "  for (const x of items) {", //          +1
      "    if (x.ok) {", //                      +2 (nested once)
      "      try { save(x); } catch (e) {}", //  +3 (nested twice)
      "    }",
      "  }",
      "}",
    ]);
    expect(await measureComplexity(file)).toEqual({
      complexity: 6,
      method: "syntax",
      topFunction: { name: "process", line: 1, endLine: 7, complexity: 6 },
    });
  });

  it("counts else if and else as +1 without a nesting bonus", async () => {
    const file = src("a.js", "javascript", [
      "function grade(n) {",
      "  if (n > 90) return 'A';", //       +1
      "  else if (n > 80) return 'B';", //  +1
      "  else return 'C';", //              +1
      "}",
    ]);
    expect((await measureComplexity(file)).complexity).toBe(3);
  });

  it("counts a chain of the same logical operator once", async () => {
    const same = src("a.ts", "typescript", ["function f() { if (a && b && c) {} }"]); // if +1, && chain +1
    const mixed = src("a.ts", "typescript", ["function f() { if (a && b || c) {} }"]); // if +1, && +1, || +1
    expect((await measureComplexity(same)).complexity).toBe(2);
    expect((await measureComplexity(mixed)).complexity).toBe(3);
  });

  it("ignores keywords in comments and strings", async () => {
    const file = src("a.ts", "typescript", [
      "function f() {",
      "  // if this, for that, while x && y",
      '  return "if (a || b) { for … }";',
      "}",
    ]);
    expect(await measureComplexity(file)).toMatchObject({ complexity: 0, method: "syntax", topFunction: null });
  });

  it("uses the most complex function, so a big flat file scores lower than a small nested one", async () => {
    const flat = src("flat.ts", "typescript", Array.from({ length: 40 }, (_, i) => `function f${i}(x) { if (x) return ${i}; }`));
    const nested = src("nested.ts", "typescript", [
      "function tangled(rows) {",
      "  for (const r of rows) {",
      "    while (r.next) {",
      "      if (r.ok) { r.done ? stop() : go(); }",
      "    }",
      "  }",
      "}",
    ]);
    const flatResult = await measureComplexity(flat);
    const nestedResult = await measureComplexity(nested);
    expect(flatResult.complexity).toBe(1); // the old whole-file count gave 40
    expect(countDecisionPoints(flat.text)).toBe(40);
    expect(nestedResult.complexity).toBe(10); // for 1 + while 2 + if 3 + ?: 4
    expect(nestedResult.complexity).toBeGreaterThan(flatResult.complexity);
  });

  it("scores named arrow functions and methods on their own, with the class name", async () => {
    const file = src("a.ts", "typescript", [
      "const simple = (x) => (x ? 1 : 2);", // +1
      "class Store {",
      "  save(items) {",
      "    for (const i of items) { if (i) {} }", // +1, +2
      "  }",
      "}",
    ]);
    expect((await measureComplexity(file)).topFunction).toMatchObject({ name: "Store.save", line: 3, complexity: 3 });
  });

  it("counts anonymous callbacks as part of their function, one level deeper", async () => {
    const file = src("a.ts", "typescript", [
      "function run(list) {",
      "  list.forEach((x) => {",
      "    if (x) {}", // +2: nested inside the callback
      "  });",
      "}",
    ]);
    expect((await measureComplexity(file)).topFunction).toMatchObject({ name: "run", complexity: 2 });
  });

  it("Python: elif, except, and code outside any function", async () => {
    const file = src("a.py", "python", [
      "def load(path):",
      "    try:", //                       try itself adds nothing (only except does)
      "        if path.endswith('.json'):", // +1
      "            return 1",
      "        elif path.endswith('.csv'):", // +1
      "            return 2",
      "    except OSError:", //               +1
      "        return 0",
      "",
      "for p in paths:", //                    top-level code: +1
      "    load(p)",
    ]);
    const result = await measureComplexity(file);
    expect(result.topFunction).toMatchObject({ name: "load", line: 1, complexity: 3 });
  });

  it("Java and Go are parsed too", async () => {
    const java = src("A.java", "java", [
      "class A {",
      "  int f(int[] xs) {",
      "    for (int x : xs) { if (x > 0) return x; }", // +1, +2
      "    return 0;",
      "  }",
      "}",
    ]);
    const go = src("a.go", "go", [
      "package main",
      "func f(xs []int) int {",
      "  for _, x := range xs {", // +1
      "    switch x {", //            +2
      "    case 1:",
      "      return 1",
      "    }",
      "  }",
      "  return 0",
      "}",
    ]);
    expect((await measureComplexity(java)).topFunction).toMatchObject({ name: "A.f", complexity: 3 });
    expect((await measureComplexity(go)).topFunction).toMatchObject({ name: "f", complexity: 3 });
  });

  it("falls back to the estimate for unsupported languages and syntax errors", async () => {
    const ruby = src("a.rb", "ruby", ["if x && y", "  puts 1", "end"]);
    expect(await measureComplexity(ruby)).toEqual({ complexity: 2, method: "estimate", topFunction: null });

    const broken = src("a.ts", "typescript", ["function f( {", "  if (x) {"]);
    expect(await measureComplexity(broken)).toMatchObject({ method: "estimate" });
  });

  it("gives docs and config files 0", () => {
    expect(estimateComplexity(src("README.md", "markdown", ["if you want, for example"]))).toEqual({
      complexity: 0,
      method: "none",
      topFunction: null,
    });
  });
});

describe("countDecisionPoints (fallback estimate)", () => {
  it("counts decision points", () => {
    expect(countDecisionPoints("if (a && b) { for (x of y) {} } else if (c || d) {}")).toBe(5); // if, for, if, &&, ||
    expect(countDecisionPoints("const v = ok ? 1 : 2;")).toBe(1);
  });

  it("ignores ?. and ?? and optional types", () => {
    expect(countDecisionPoints("const a = b?.c ?? d; function f(x?: number) {}")).toBe(0);
  });

  it("doesn't count words that only contain a keyword", () => {
    expect(countDecisionPoints("const notify = format; caseStudy();")).toBe(0);
  });
});
