// Tests for hidden coupling (Phase 4): files that change together but don't import each other. No network.
import { describe, expect, it } from "vitest";
import { MAX_HIDDEN_PAIRS, findHiddenCoupling, importPath } from "../src/coupling.js";
import type { CoChangePair, HistoryReport, ImportGraph } from "../src/types.js";

const graph = (files: string[], edges: Array<[string, string]>): ImportGraph => ({
  repoId: "o/r",
  commitSha: "abc",
  generatedAt: "2026-11-11T00:00:00Z",
  files,
  edges: edges.map(([from, to]) => ({ from, to, line: 1 })),
  external: [],
  unresolved: [],
  stats: { imports: edges.length, internal: edges.length, external: 0, builtin: 0, unresolved: 0 },
});

const pair = (a: string, b: string, count: number, percent = 50): CoChangePair => ({ a, b, count, percent });

const history = (coChangeAll: CoChangePair[] | undefined, coChange: CoChangePair[] = []): HistoryReport => ({
  repoId: "o/r",
  commitSha: "abc",
  generatedAt: "2026-11-11T00:00:00Z",
  since: "2025-11-11T00:00:00Z",
  commitsAnalyzed: 20,
  skipped: { merges: 0, bots: 0, large: 0 },
  reachedLimit: false,
  filesChanged: 5,
  files: [],
  coChange,
  coChangeAll,
  areas: [],
});

describe("importPath", () => {
  const next = new Map([
    ["a", ["b"]],
    ["b", ["c"]],
    ["c", ["d"]],
    ["x", ["d"]],
  ]);

  it("finds the shortest import chain, following arrows one way only", () => {
    expect(importPath(next, "a", "d")).toEqual(["a", "b", "c", "d"]);
    expect(importPath(next, "d", "a")).toBeNull(); // arrows point the other way
    expect(importPath(next, "a", "x")).toBeNull();
  });

  it("doesn't loop forever on circular imports", () => {
    const loop = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    expect(importPath(loop, "a", "z")).toBeNull();
  });
});

describe("findHiddenCoupling", () => {
  const files = ["api/routes.py", "client/fetch.ts", "app/a.py", "app/b.py", "app/c.py", "lib/util.py"];
  const g = graph(files, [
    ["app/a.py", "app/b.py"], // a imports b directly
    ["app/b.py", "lib/util.py"],
    ["app/c.py", "lib/util.py"],
    ["lib/util.py", "app/a.py"], // so c → util → a (indirect)
  ]);

  it("keeps pairs with no direct import, fully hidden first, and drops pairs that import each other", () => {
    const result = findHiddenCoupling(
      g,
      history([
        pair("app/a.py", "app/b.py", 9), // direct import: not hidden
        pair("app/a.py", "app/c.py", 6), // c → util → a
        pair("api/routes.py", "client/fetch.ts", 4), // no link at all
      ]),
    );
    expect(result.pairsChecked).toBe(3);
    expect(result.partial).toBe(false);
    expect(result.pairs).toEqual([
      { ...pair("api/routes.py", "client/fetch.ts", 4), link: "none", via: [] },
      { ...pair("app/a.py", "app/c.py", 6), link: "indirect", via: ["app/c.py", "lib/util.py", "app/a.py"] },
    ]);
  });

  it("finds a direct import in either direction", () => {
    const result = findHiddenCoupling(g, history([pair("app/b.py", "app/a.py", 5)]));
    expect(result.pairs).toEqual([]);
    expect(result.pairsChecked).toBe(1);
  });

  it("only compares code files from the import graph", () => {
    const result = findHiddenCoupling(g, history([pair("README.md", "app/a.py", 8), pair("app/a.py", "config.yaml", 7)]));
    expect(result).toEqual({ pairsChecked: 0, pairs: [], partial: false });
  });

  it("falls back to the top pairs for history saved before this feature, and says so", () => {
    const result = findHiddenCoupling(g, history(undefined, [pair("api/routes.py", "client/fetch.ts", 3)]));
    expect(result.partial).toBe(true);
    expect(result.pairs).toHaveLength(1);
  });

  it("lists at most MAX_HIDDEN_PAIRS pairs, the ones that change together most", () => {
    const many = Array.from({ length: 15 }, (_, i) => `m/f${i}.py`);
    const pairs = many.slice(1).map((f, i) => pair(many[0], f, 3 + i));
    const result = findHiddenCoupling(graph(many, []), history(pairs));
    expect(result.pairsChecked).toBe(14);
    expect(result.pairs).toHaveLength(MAX_HIDDEN_PAIRS);
    expect(result.pairs[0].count).toBe(16);
  });
});
