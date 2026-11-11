// Tests for the call graph. Phase 1: reading functions and calls, and matching each call to a function.
// Phase 2: the function list and one function's callers and callees. Phase 3: the diagram.
// Small TypeScript and Python samples, each checking one matching rule. No network or disk.
import { describe, expect, it } from "vitest";
import { buildCallGraph, focusGraph, focusMermaid, isTestFile, listFunctions, type CallGraph } from "../src/callGraph.js";
import type { HistoryReport, SourceFile } from "../src/types.js";

const ts = (path: string, text: string): SourceFile => ({ path, text, language: "typescript" });
const py = (path: string, text: string): SourceFile => ({ path, text, language: "python" });

/** The arrow from one function to another, or undefined if there's none. */
const edge = (g: CallGraph, from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to);
/** Everything a function calls. */
const callsOf = (g: CallGraph, from: string) => g.edges.filter((e) => e.from === from).map((e) => e.to).sort();

describe("call graph: TypeScript", async () => {
  const g = await buildCallGraph(
    [
      ts("src/store.ts", `export function query() {}\nexport function keywordQuery() {}`),
      ts("src/util.ts", `export function helper() {}\nexport default function main() {}`),
      ts(
        "src/search.ts",
        `import { query, keywordQuery as kq } from "./store.js";
import * as util from "./util.js";
export function searchChunks() {
  query();
  kq();
  util.helper();
  console.log("library call: dropped");
  local();
}
function local() {}`,
      ),
      ts(
        "src/app.ts",
        `import main from "./util.js";
class Base { greet() {} }
class Child extends Base {
  run() { this.greet(); super.greet(); }
}
function go() {
  const c = new Child();
  c.run();
  main();
}`,
      ),
    ],
    { repoId: "o/r", commitSha: "abc" },
  );

  it("finds functions and methods, with their class in the name", () => {
    const ids = g.functions.map((f) => f.id);
    expect(ids).toContain("src/search.ts#searchChunks");
    expect(ids).toContain("src/app.ts#Child.run");
    expect(g.functions.find((f) => f.id === "src/app.ts#Base.greet")!.kind).toBe("method");
    expect(g.functions.find((f) => f.id === "src/app.ts#go")!.kind).toBe("function");
  });

  it("matches same-file, imported, renamed and module.fn() calls, and drops library calls", () => {
    expect(callsOf(g, "src/search.ts#searchChunks")).toEqual([
      "src/search.ts#local", // same file
      "src/store.ts#keywordQuery", // imported as kq
      "src/store.ts#query", // imported
      "src/util.ts#helper", // util.helper() with import * as util
    ]); // console.log isn't there
    expect(edge(g, "src/search.ts#searchChunks", "src/store.ts#query")!.certain).toBe(true);
  });

  it("matches this. and super. to the parent class, and a default import", () => {
    const greet = edge(g, "src/app.ts#Child.run", "src/app.ts#Base.greet")!;
    expect(greet).toMatchObject({ certain: true, count: 2 }); // this.greet() (inherited) and super.greet()
    expect(edge(g, "src/app.ts#go", "src/util.ts#main")!.certain).toBe(true); // import main from (default)
  });

  it("knows what class an object is when the same function made it", () => {
    expect(edge(g, "src/app.ts#go", "src/app.ts#Child.run")!.certain).toBe(true); // const c = new Child(); c.run()
  });
});

describe("call graph: Python", async () => {
  const g = await buildCallGraph(
    [
      py(
        "agents.py",
        `class Agent:
    def remember(self, m):
        pass

    @property
    def name(self):
        return "x"

class Chatbot(Agent):
    def respond(self, m):
        self.remember(m)

class Vision(Agent):
    def respond(self, m):
        self.remember(m)

def run_all(agents):
    return [a.respond("hi") for a in agents]
`,
      ),
      py(
        "tests/test_agents.py",
        `from agents import Chatbot

def test_respond():
    bot = Chatbot()
    bot.respond("hi")
    bot.items.append(1)
`,
      ),
      py("main.py", `import agents as ag\nag.run_all([])\n`),
    ],
    { repoId: "o/r", commitSha: "abc" },
  );

  it("treats decorated functions in a class as methods", () => {
    expect(g.functions.find((f) => f.id === "agents.py#Agent.name")!.kind).toBe("method");
  });

  it("matches self. calls to methods inherited from the parent class", () => {
    expect(edge(g, "agents.py#Chatbot.respond", "agents.py#Agent.remember")!.certain).toBe(true);
  });

  it("marks obj.method() with an unknown object as possible, for every nearby method of that name", () => {
    const calls = g.edges.filter((e) => e.from === "agents.py#run_all");
    expect(calls.map((e) => e.to).sort()).toEqual(["agents.py#Chatbot.respond", "agents.py#Vision.respond"]);
    expect(calls.every((e) => !e.certain)).toBe(true);
  });

  it("follows imports into a test, knows the object's class, and drops common library methods", () => {
    expect(callsOf(g, "tests/test_agents.py#test_respond")).toEqual(["agents.py#Chatbot.respond"]); // not .append()
    expect(edge(g, "tests/test_agents.py#test_respond", "agents.py#Chatbot.respond")!.certain).toBe(true);
    expect(g.functions.find((f) => f.id === "tests/test_agents.py#test_respond")!.isTest).toBe(true);
  });

  it("gives code outside any function a '(top level)' entry, and follows import x as y", () => {
    expect(edge(g, "main.py#(top level)", "agents.py#run_all")!.certain).toBe(true);
    expect(g.functions.find((f) => f.id === "main.py#(top level)")!.kind).toBe("top-level");
  });
});

describe("isTestFile", () => {
  it("recognises the usual test file names and folders", () => {
    for (const p of ["tests/test_a.py", "test_a.py", "a_test.py", "src/a.test.ts", "web/b.spec.js", "src/__tests__/c.ts"]) {
      expect(isTestFile(p), p).toBe(true);
    }
    for (const p of ["src/app.ts", "agents.py", "src/testing.ts", "contest.py"]) expect(isTestFile(p), p).toBe(false);
  });
});

// ---------- Phase 2: the function list and one function's callers and callees ----------

describe("listFunctions and focusGraph", async () => {
  // a → b → c, and t (a test) → b. So b has 2 callers and 1 callee.
  const g = await buildCallGraph(
    [
      ts("src/m.ts", `export function a() { b(); }\nexport function b() { c(); }\nexport function c() {}`),
      ts("src/m.test.ts", `import { b } from "./m.js";\nfunction t() { b(); }`),
    ],
    { repoId: "o/r", commitSha: "abc" },
  );

  it("lists functions most-called first, with caller and callee counts", () => {
    const list = listFunctions(g);
    expect(list[0]).toMatchObject({ id: "src/m.ts#b", callers: 2, callees: 1 });
  });

  it("gives a function's callers and callees, real code before tests", () => {
    const view = focusGraph(g, "src/m.ts#b", 1);
    expect(view.center.id).toBe("src/m.ts#b");
    expect(view.callers.map((i) => i.fn.id)).toEqual(["src/m.ts#a", "src/m.test.ts#t"]); // the test comes last
    expect(view.callees.map((i) => i.fn.id)).toEqual(["src/m.ts#c"]);
    expect(view.callers[1]).toMatchObject({ level: 1, parent: "src/m.ts#b", site: "src/m.test.ts", line: 2, certain: true });
  });

  it("goes one step further at depth 2", () => {
    const view = focusGraph(g, "src/m.ts#c", 2);
    expect(view.callers.map((i) => [i.fn.id, i.level, i.parent])).toEqual([
      ["src/m.ts#b", 1, "src/m.ts#c"],
      ["src/m.ts#a", 2, "src/m.ts#b"], // a calls b, which calls c
      ["src/m.test.ts#t", 2, "src/m.ts#b"],
    ]);
  });

  it("keeps at most 12 per side and counts the rest", async () => {
    const callers = Array.from({ length: 15 }, (_, i) => `export function f${i}() { target(); }`).join("\n");
    const big = await buildCallGraph([ts("src/big.ts", `${callers}\nexport function target() {}`)], { repoId: "o/r", commitSha: "abc" });
    const view = focusGraph(big, "src/big.ts#target", 1);
    expect(view.callers).toHaveLength(12);
    expect(view.more.callers).toBe(3);
  });

  it("says clearly when the function isn't in the graph", () => {
    expect(() => focusGraph(g, "src/m.ts#gone", 1)).toThrow("isn't in the call graph");
  });
});

// ---------- Phase 3: the diagram ----------

describe("focusMermaid", async () => {
  const g = await buildCallGraph(
    [
      ts("src/m.ts", `export function a() { b(); }\nexport function b() { c(); }\nexport function c() {}`),
      ts("src/m.test.ts", `import { b } from "./m.js";\nfunction t() { b(); }`),
      py("agents.py", `class A:\n    def go(self): pass\nclass B:\n    def go(self): pass\ndef run(x):\n    x.go()\n`),
    ],
    { repoId: "o/r", commitSha: "abc" },
  );

  it("draws callers → the function → callees, with the function highlighted and tests grey", () => {
    const text = focusMermaid(focusGraph(g, "src/m.ts#b", 1));
    expect(text.startsWith("flowchart LR")).toBe(true);
    expect(text).toContain('c["b()<br/>src/m.ts"]');
    expect(text).toMatch(/n\d --> c/); // a caller points at the function
    expect(text).toMatch(/c --> n\d/); // the function points at what it calls
    expect(text).toContain("class c center");
    expect(text).toMatch(/class n\d test/); // the test caller is grey
  });

  it("draws possible calls as dashed arrows, and tints hotspot files", () => {
    const history = { files: [{ path: "agents.py", score: 80 }] } as unknown as HistoryReport;
    const text = focusMermaid(focusGraph(g, "agents.py#run", 1), history);
    expect(text).toMatch(/c -\.-> n\d/);
    expect(text).toMatch(/class n\d,n\d heat3/);
  });

  it("keeps quotes and angle brackets in names from breaking the diagram", async () => {
    const odd = await buildCallGraph([ts('src/q"<x>.ts', `export function f() { g(); }\nexport function g() {}`)], { repoId: "o/r", commitSha: "abc" });
    const text = focusMermaid(focusGraph(odd, 'src/q"<x>.ts#f', 1));
    expect(text).toContain("src/q#quot;x.ts");
    expect(text).not.toContain("<x>");
  });
});
