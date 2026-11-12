// Tests for change impact: callers followed backwards, tests that reach a function, files and hotspots.
import { describe, expect, it } from "vitest";
import { buildCallGraph, type CallGraph } from "../src/callGraph.js";
import { changeImpact } from "../src/impact.js";
import type { HistoryReport, SourceFile } from "../src/types.js";

const ts = (path: string, text: string): SourceFile => ({ path, text, language: "typescript" });

// store.query ← rag.answer ← app.handleChat ← app.start (entry point); a test calls answer; cli.main also calls answer.
const graphPromise = buildCallGraph(
  [
    ts("src/store.ts", `export function query() {}\nexport function unused() {}`),
    ts("src/rag.ts", `import { query } from "./store.js";\nexport function answer() {\n  query();\n}`),
    ts(
      "src/app.ts",
      `import { answer } from "./rag.js";
export function handleChat() {
  answer();
}
export function start() {
  handleChat();
}`,
    ),
    ts("src/cli.ts", `import { answer } from "./rag.js";\nexport function main() {\n  answer();\n}`),
    ts("tests/rag.test.ts", `import { answer } from "../src/rag.js";\nfunction checksAnswer() {\n  answer();\n}`),
  ],
  { repoId: "o/r", commitSha: "abc" },
);

const ids = (items: { fn: { id: string } }[]) => items.map((i) => i.fn.id);

describe("changeImpact", () => {
  it("follows callers all the way up, nearest first", async () => {
    const impact = changeImpact(await graphPromise, "src/store.ts#query");
    expect(ids(impact.affected)).toEqual(["src/rag.ts#answer", "src/app.ts#handleChat", "src/cli.ts#main", "src/app.ts#start"]);
    expect(impact.affected.map((i) => i.distance)).toEqual([1, 2, 2, 3]);
    expect(impact.totals.maxDistance).toBe(3);
  });

  it("records the path: which function each one calls on the way, and where", async () => {
    const impact = changeImpact(await graphPromise, "src/store.ts#query");
    const start = impact.affected.find((i) => i.fn.id === "src/app.ts#start")!;
    expect(start.via).toBe("src/app.ts#handleChat");
    expect(start.line).toBe(6);
  });

  it("lists tests separately, including ones that reach it indirectly", async () => {
    const impact = changeImpact(await graphPromise, "src/store.ts#query");
    expect(ids(impact.tests)).toEqual(["tests/rag.test.ts#checksAnswer"]);
    expect(impact.tests[0].distance).toBe(2);
    expect(impact.totals.tests).toBe(1);
  });

  it("finds entry points: affected functions nothing calls", async () => {
    const impact = changeImpact(await graphPromise, "src/store.ts#query");
    expect(ids(impact.entryPoints)).toEqual(["src/cli.ts#main", "src/app.ts#start"]);
  });

  it("counts files, including the target's own file", async () => {
    const impact = changeImpact(await graphPromise, "src/store.ts#query");
    expect(impact.files.map((f) => f.file).sort()).toEqual(["src/app.ts", "src/cli.ts", "src/rag.ts", "src/store.ts"]);
    expect(impact.files.find((f) => f.file === "src/app.ts")!.functions).toBe(2);
  });

  it("puts hotspot files first", async () => {
    const history = { files: [{ path: "src/cli.ts", score: 80 }] } as unknown as HistoryReport;
    const impact = changeImpact(await graphPromise, "src/store.ts#query", history);
    expect(impact.files[0]).toEqual({ file: "src/cli.ts", functions: 1, hotspot: 3 });
    expect(impact.totals.hotspotFiles).toBe(1);
  });

  it("returns nothing affected and no tests for an unused function", async () => {
    const impact = changeImpact(await graphPromise, "src/store.ts#unused");
    expect(impact.affected).toEqual([]);
    expect(impact.tests).toEqual([]);
    expect(impact.files).toEqual([{ file: "src/store.ts", functions: 0, hotspot: 0 }]);
  });

  it("throws for a function that isn't in the graph", async () => {
    expect(() => changeImpact({ functions: [], edges: [] } as unknown as CallGraph, "nope")).toThrow(/isn't in the call graph/);
  });
});

describe("changeImpact with possible calls and cycles", () => {
  const fn = (id: string, isTest = false) => ({
    id, name: id, qualified: id, file: `${id}.ts`, line: 1, endLine: 2, kind: "function" as const, isTest,
  });
  const edge = (from: string, to: string, certain = true) => ({ from, to, line: 1, count: 1, certain });

  it("prefers a certain path, and marks functions reached only by possible calls", () => {
    // a → t (possible), b → a, b → t (certain); c → a only
    const graph = {
      functions: ["t", "a", "b", "c"].map((id) => fn(id)),
      edges: [edge("a", "t", false), edge("b", "a"), edge("b", "t"), edge("c", "a")],
    } as unknown as CallGraph;
    const impact = changeImpact(graph, "t");
    const byId = new Map(impact.affected.map((i) => [i.fn.id, i]));
    expect(byId.get("b")!.certain).toBe(true);
    expect(byId.get("a")!.certain).toBe(false);
    expect(byId.get("c")!.certain).toBe(false);
    expect(impact.totals.certain).toBe(1);
  });

  it("stops on cycles", () => {
    const graph = {
      functions: ["t", "a", "b"].map((id) => fn(id)),
      edges: [edge("a", "t"), edge("b", "a"), edge("a", "b"), edge("t", "t")],
    } as unknown as CallGraph;
    expect(ids(changeImpact(graph, "t").affected)).toEqual(["a", "b"]);
  });
});
