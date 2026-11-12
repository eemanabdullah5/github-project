// Tests for the call graph chat hook (phase 4): finding function names in a question, matching them to the
// graph, and the CALL GRAPH block + sources added to the chat prompt. No network, disk or AI.
import { describe, expect, it } from "vitest";
import { buildCallGraph } from "../src/callGraph.js";
import { callGraphContext, functionNamesIn, matchFunctions, wantsImpact } from "../src/callGraphChat.js";
import { buildPrompt } from "../src/rag.js";
import type { HistoryReport, SourceFile } from "../src/types.js";

const ts = (path: string, text: string): SourceFile => ({ path, text, language: "typescript" });

const graphPromise = buildCallGraph(
  [
    ts("src/store.ts", `export function query() {}\nexport function load() {}`),
    ts(
      "src/rag.ts",
      `import { query } from "./store.js";
export function answer() {
  query();
  helper();
}
function helper() {}`,
    ),
    ts("src/app.ts", `import { answer } from "./rag.js";\nexport function handleChat() {\n  answer();\n}`),
    ts("src/cli.ts", `import { answer } from "./rag.js";\nexport function main() {\n  answer();\n}`),
    ts("tests/rag.test.ts", `import { answer } from "../src/rag.js";\nfunction checksAnswer() {\n  answer();\n}`),
    ts("other/rag.ts", `export function answer() {}`), // a second function with the same name, never called
  ],
  { repoId: "o/r", commitSha: "abc" },
);

describe("functionNamesIn", () => {
  it("finds code-looking names and backticked names, but not file names", () => {
    expect(functionNamesIn("Where is searchChunks used in `rag.ts`?")).toEqual(["searchChunks"]);
    expect(functionNamesIn("what does `load_manifest` do")).toEqual(["load_manifest"]);
  });

  it("finds plain lowercase names only when the question marks them as a function", () => {
    expect(functionNamesIn("who calls answer?")).toEqual(["answer"]);
    expect(functionNamesIn("where is answer called")).toEqual(["answer"]);
    expect(functionNamesIn("what does answer() call")).toEqual(["answer"]);
    expect(functionNamesIn("list the callers of query")).toEqual(["query"]);
    expect(functionNamesIn("how is the answer built?")).toEqual([]); // ordinary English
  });

  it("ignores ordinary words after 'calls'", () => {
    expect(functionNamesIn("which code calls the database?")).toEqual(["database"]); // only used if a function has that name
    expect(functionNamesIn("who calls this function")).toEqual([]);
  });
});

describe("matchFunctions", () => {
  it("prefers the most-called function when a name matches several, and notes the rest", async () => {
    const g = await graphPromise;
    const { functions, skipped } = matchFunctions(g, ["answer"]);
    expect(functions.map((f) => f.id)).toEqual(["src/rag.ts#answer"]);
    expect(skipped.get("answer")).toBe(1);
  });

  it("prefers a function inside the chosen folder", async () => {
    const g = await graphPromise;
    const { functions } = matchFunctions(g, ["answer"], { kind: "folder", path: "other" });
    expect(functions.map((f) => f.id)).toEqual(["other/rag.ts#answer"]);
  });

  it("takes one function per name, up to two, and skips names not in the graph", async () => {
    const g = await graphPromise;
    const { functions } = matchFunctions(g, ["nope", "answer", "query", "load"]);
    expect(functions.map((f) => f.id)).toEqual(["src/rag.ts#answer", "src/store.ts#query"]);
  });
});

describe("callGraphContext", () => {
  it("returns null when the question names no function in the graph", async () => {
    expect(callGraphContext(await graphPromise, "How does indexing work?")).toBeNull();
  });

  it("lists every caller with its call line, marks tests, and lists what the function calls", async () => {
    const ctx = callGraphContext(await graphPromise, "who calls answer?")!;
    expect(ctx.text).toContain("Function: answer() in src/rag.ts, defined at [src/rag.ts:L2-L5]");
    expect(ctx.text).toContain("Called by (3):");
    expect(ctx.text).toContain("handleChat() in src/app.ts, call at [src/app.ts:L3]");
    expect(ctx.text).toContain("main() in src/cli.ts, call at [src/cli.ts:L3]");
    expect(ctx.text).toContain("checksAnswer() in tests/rag.test.ts, call at [tests/rag.test.ts:L3] (test code)");
    expect(ctx.text).toContain("Calls (2):");
    expect(ctx.text).toContain("query() in src/store.ts (defined at [src/store.ts:L1]), called at [src/rag.ts:L3]");
    expect(ctx.text).toContain('Note: 1 other function named "answer" not shown.');
  });

  it("returns the cited lines as sources, without repeats", async () => {
    const ctx = callGraphContext(await graphPromise, "who calls answer?")!;
    expect(ctx.sources).toContainEqual({ path: "src/rag.ts", startLine: 2, endLine: 5, symbol: "answer" });
    expect(ctx.sources).toContainEqual({ path: "src/app.ts", startLine: 3, endLine: 3, symbol: "handleChat() calls answer()" });
    const keys = ctx.sources.map((s) => `${s.path}:${s.startLine}-${s.endLine}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("says when nothing calls a function", async () => {
    const ctx = callGraphContext(await graphPromise, "who calls load?")!;
    expect(ctx.text).toContain("Called by (0):\n- none found");
  });
});

describe("change impact in chat", () => {
  it("spots questions about changes, risk and tests", () => {
    expect(wantsImpact("What breaks if I change query?")).toBe(true);
    expect(wantsImpact("Is answer tested?")).toBe(true);
    expect(wantsImpact("How risky is refactoring answer?")).toBe(true);
    expect(wantsImpact("Who calls answer?")).toBe(false);
  });

  it("finds the function in 'if I change X' and 'is X tested' questions", () => {
    expect(functionNamesIn("what happens if I change query")).toEqual(["query"]);
    expect(functionNamesIn("is answer tested?")).toEqual(["answer"]);
  });

  it("matches module.function names", async () => {
    const { functions } = matchFunctions(await graphPromise, ["store.query"]);
    expect(functions.map((f) => f.id)).toEqual(["src/store.ts#query"]);
  });

  it("adds callers all the way up, entry points and the tests that reach it", async () => {
    const ctx = callGraphContext(await graphPromise, "what breaks if I change query?")!;
    expect(ctx.text).toContain("If it changes (callers followed all the way up):");
    expect(ctx.text).toContain("- Affects 3 functions, up to 2 steps away, in 4 files.");
    expect(ctx.text).toContain("- Further callers: 2 steps: handleChat(), main()");
    expect(ctx.text).toContain("- Entry points reached (code nothing else calls): handleChat() in src/app.ts, main() in src/cli.ts");
    expect(ctx.text).toContain("- Tests that reach it (1):");
    expect(ctx.text).toContain("checksAnswer() in tests/rag.test.ts, 2 steps away, at [tests/rag.test.ts:L3]");
    expect(ctx.sources).toContainEqual({ path: "tests/rag.test.ts", startLine: 3, endLine: 3, symbol: "test reaches query()" });
  });

  it("names hotspot files when the history has been analysed", async () => {
    const history = { files: [{ path: "src/app.ts", score: 90 }] } as unknown as HistoryReport;
    const ctx = callGraphContext(await graphPromise, "what breaks if I change query?", null, history)!;
    expect(ctx.text).toContain("in 4 files (1 of them hotspots)");
    expect(ctx.text).toContain("- Hotspot files reached: src/app.ts");
  });

  it("says clearly when no test reaches it", async () => {
    const ctx = callGraphContext(await graphPromise, "is load tested?")!;
    expect(ctx.text).toContain("Nothing in the repo calls it");
    expect(ctx.text).toContain("NO test reaches it");
  });

  it("leaves the impact part out of plain 'who calls' questions", async () => {
    expect(callGraphContext(await graphPromise, "who calls query?")!.text).not.toContain("If it changes");
  });
});

describe("buildPrompt with a call graph block", () => {
  const manifest = { repoId: "o/r", fileTree: "src/rag.ts", readme: "" };

  it("adds the block and its rules only when there is one", () => {
    const withGraph = buildPrompt({ question: "who calls answer?", history: [], chunks: [], manifest, callGraph: "Function: answer()" });
    const system = withGraph.messages[0].content;
    expect(system).toContain("<<<REPO CALL GRAPH>>>\nFunction: answer()\n<<<END CALL GRAPH>>>");
    expect(system).toContain("treat its lists as complete");

    const without = buildPrompt({ question: "what is this repo?", history: [], chunks: [], manifest });
    expect(without.messages[0].content).not.toContain("CALL GRAPH");
  });
});
