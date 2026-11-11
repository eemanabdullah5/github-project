// Tests for the call graph (phase 1): reading functions and calls, and matching each call to a function.
// Small TypeScript and Python samples, each checking one matching rule. No network or disk.
import { describe, expect, it } from "vitest";
import { buildCallGraph, isTestFile, type CallGraph } from "../src/callGraph.js";
import type { SourceFile } from "../src/types.js";

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
