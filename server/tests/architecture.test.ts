// Tests for the architecture map (Phase 4): grouping files into modules, finding cycles,
// hotspot colours and the Mermaid diagram. No network.
import { describe, expect, it } from "vitest";
import { buildArchitecture, chooseDepth, findCycles, heatLevel, moduleOf } from "../src/architecture.js";
import type { HistoryReport, ImportGraph } from "../src/types.js";

describe("moduleOf / chooseDepth", () => {
  it("groups a file by its folder, cut to the chosen depth", () => {
    expect(moduleOf("server/src/chunking/a.ts", 3)).toBe("server/src/chunking");
    expect(moduleOf("server/src/chunking/a.ts", 1)).toBe("server");
    expect(moduleOf("server/app.ts", 3)).toBe("server");
    expect(moduleOf("main.py", 2)).toBe("(root)");
  });

  it("picks the deepest level that keeps the number of modules within the limit", () => {
    const files = ["a/x/1.py", "a/y/2.py", "b/z/3.py", "b/w/4.py", "top.py"];
    expect(chooseDepth(files, 5)).toBe(2); // (root), a/x, a/y, b/z, b/w
    expect(chooseDepth(files, 3)).toBe(1); // (root), a, b
    expect(chooseDepth(["main.py"], 5)).toBe(1);
  });
});

describe("findCycles", () => {
  it("finds groups that depend on each other in a loop, ignoring one-way chains", () => {
    const nodes = ["a", "b", "c", "d", "e"];
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" }, // a → b → c → a
      { from: "c", to: "d" }, // d is only reached, not part of a loop
      { from: "e", to: "e" }, // a file importing itself doesn't count
    ];
    expect(findCycles(nodes, edges)).toEqual([["a", "b", "c"]]);
  });

  it("returns nothing for a graph without loops, and handles long chains without recursion", () => {
    expect(findCycles(["a", "b"], [{ from: "a", to: "b" }])).toEqual([]);
    const n = 20000;
    const nodes = Array.from({ length: n }, (_, i) => `f${i}`);
    const chain = nodes.slice(1).map((to, i) => ({ from: nodes[i], to }));
    expect(findCycles(nodes, [...chain, { from: nodes[n - 1], to: nodes[0] }])[0]).toHaveLength(n);
  });
});

describe("heatLevel", () => {
  it("bands hotspot scores into colours", () => {
    expect([undefined, 0, 10, 34, 66, 67, 100].map((s) => heatLevel(s))).toEqual([0, 0, 1, 2, 2, 3, 3]);
  });
});

describe("buildArchitecture", () => {
  const graph: ImportGraph = {
    repoId: "o/r",
    commitSha: "abc",
    generatedAt: "2026-11-09T00:00:00Z",
    files: ["main.py", "app/routes.py", "app/models.py", "lib/db.py", "lib/util.py"],
    edges: [
      { from: "main.py", to: "app/routes.py", line: 1 },
      { from: "app/routes.py", to: "app/models.py", line: 2 }, // inside one module: no arrow
      { from: "app/models.py", to: "lib/db.py", line: 3 },
      { from: "app/routes.py", to: "lib/util.py", line: 4 },
      { from: "lib/db.py", to: "app/models.py", line: 5 }, // lib → app makes a loop with app → lib
    ],
    external: [],
    unresolved: [],
    stats: { imports: 5, internal: 5, external: 0, builtin: 0, unresolved: 0 },
  };
  const history = { files: [{ path: "app/routes.py", score: 100 }, { path: "lib/util.py", score: 20 }] } as unknown as HistoryReport;

  it("adds file imports up into module arrows, with examples, and finds module and file cycles", () => {
    const map = buildArchitecture(graph, history);
    expect(map.modules.map((m) => [m.name, m.files.length, m.uses, m.usedBy, m.inCycle])).toEqual([
      ["(root)", 1, 1, 0, false],
      ["app", 2, 1, 2, true],
      ["lib", 2, 1, 1, true],
    ]);
    expect(map.links.map((l) => [l.from, l.to, l.count, l.inCycle])).toEqual([
      ["app", "lib", 2, true],
      ["(root)", "app", 1, false],
      ["lib", "app", 1, true],
    ]);
    expect(map.links[0].examples.map((e) => e.line)).toEqual([3, 4]);
    expect(map.cycles).toEqual([["app", "lib"]]);
    expect(map.fileCycles).toEqual([["app/models.py", "lib/db.py"]]);
    expect(map.coverage).toBe(1);
  });

  it("colours each module by its riskiest file, and only when the history was analysed", () => {
    const map = buildArchitecture(graph, history);
    expect(map.hotspotsAnalysed).toBe(true);
    expect(map.modules.find((m) => m.name === "app")?.hotspot).toEqual({ score: 100, file: "app/routes.py" });
    expect(map.modules.find((m) => m.name === "(root)")?.hotspot).toBeNull();
    const plain = buildArchitecture(graph, null);
    expect(plain.hotspotsAnalysed).toBe(false);
    expect(plain.mermaid).not.toContain("class m");
  });

  it("writes a Mermaid flowchart with boxes, numbered arrows, colours and red cycle arrows", () => {
    const { mermaid } = buildArchitecture(graph, history);
    expect(mermaid.split("\n")[0]).toBe("flowchart LR");
    expect(mermaid).toContain('m1["app<br/>2 files"]');
    expect(mermaid).toContain("m1 -->|2| m2");
    expect(mermaid).toContain("class m1 heat3");
    expect(mermaid).toContain("class m2 heat1");
    expect(mermaid).toContain("linkStyle 0,2 stroke:#c0392b");
  });

  it("keeps quotes in folder names from breaking the diagram", () => {
    const odd = { ...graph, files: ['we"ird/a.py'], edges: [] };
    expect(buildArchitecture(odd, null).mermaid).toContain('m0["we#quot;ird<br/>1 file"]');
  });
});
