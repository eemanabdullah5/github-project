// Tests for F5 — repo health report. These cover the parts that don't need the AI or the network.
import { describe, expect, it } from "vitest";
import {
  REPORT_SECTIONS,
  buildReportPrompt,
  factsSection,
  hotspotsSection,
  languageBreakdown,
  architectureSection,
  mergeRoundRobin,
  structureSection,
} from "../src/report.js";
import { buildArchitecture } from "../src/architecture.js";
import type { Chunk, HistoryReport, ImportGraph, Manifest } from "../src/types.js";

// Small helpers to build test data.
const chunk = (id: string, text = `code ${id}`): Chunk => ({
  id, text, path: `src/${id}.py`, startLine: 1, endLine: 10,
  language: "python", symbol: "", symbolType: "lines", chunker: "lines",
});
const manifest: Manifest = {
  repoId: "octo/hello",
  commitSha: "abcdef1234567",
  branch: "main",
  indexedAt: "2026-11-08T10:00:00Z",
  embedModel: "m",
  fileCount: 6,
  chunkCount: 20,
  fileTree: "README.md\napp.py\nlib/a.py\nlib/b.py\nweb/index.js\nconfig.yaml",
  readme: "# Hello",
};

describe("languageBreakdown", () => {
  it("counts code files per language and leaves out docs and config", () => {
    expect(languageBreakdown(manifest.fileTree)).toEqual([
      { language: "python", files: 3, percent: 75 },
      { language: "javascript", files: 1, percent: 25 },
    ]);
  });

  it("groups everything after the top 5 as 'other'", () => {
    const tree = ["a.py", "b.py", "c.js", "d.ts", "e.go", "f.java", "g.rb", "h.rs"].join("\n");
    const rows = languageBreakdown(tree);
    expect(rows).toHaveLength(6);
    expect(rows.at(-1)).toMatchObject({ language: "other", files: 2 });
  });

  it("returns nothing when there are no code files", () => {
    expect(languageBreakdown("README.md\nnotes.txt")).toEqual([]);
  });
});

describe("factsSection", () => {
  it("lists repo, commit, size and languages", () => {
    const text = factsSection(manifest);
    expect(text).toContain("**Repository:** octo/hello");
    expect(text).toContain("commit `abcdef1` on `main` (indexed 2026-11-08)");
    expect(text).toContain("6 files indexed");
    expect(text).toContain("python 75%, javascript 25%");
  });
});

describe("hotspotsSection", () => {
  it("explains how to get the data when history hasn't been analysed", () => {
    expect(hotspotsSection(null)).toContain("Analyse history");
  });

  it("copies the top hotspots, the top pair and knowledge risk from F4", () => {
    const history = {
      commitsAnalyzed: 24,
      generatedAt: "2026-11-08T10:00:00Z",
      files: [
        { path: "a.py", score: 100, changes: 9, complexity: 14 },
        { path: "README.md", score: 0, changes: 5, complexity: 0 }, // score 0: not listed as a hotspot
      ],
      coChange: [{ a: "a.py", b: "b.py", count: 6, percent: 75 }],
      areas: [
        { area: "docs", singleContributor: true },
        { area: "src", singleContributor: false },
      ],
    } as unknown as HistoryReport;
    const text = hotspotsSection(history);
    expect(text).toContain("Based on 24 commits");
    expect(hotspotsSection({ ...history, commitsAnalyzed: 1 })).toContain("Based on 1 commit in"); // singular
    expect(text).toContain("`a.py`: score 100 (9 changes, complexity 14)");
    expect(text).not.toContain("README.md");
    expect(text).toContain("`a.py` and `b.py` changed together 6 times");
    expect(text).toContain("only one person has changed `docs`");
  });
});

describe("mergeRoundRobin", () => {
  it("takes each section's best chunk first, then the second best, and skips repeats", () => {
    const merged = mergeRoundRobin([
      [chunk("a1"), chunk("a2")],
      [chunk("b1"), chunk("a1"), chunk("b3")], // a1 is a repeat
    ]);
    expect(merged.map((c) => c.id)).toEqual(["a1", "b1", "a2", "b3"]);
  });
});

describe("buildReportPrompt", () => {
  it("asks for every section heading and includes the chunks", () => {
    const { messages, usedChunks } = buildReportPrompt(manifest, [chunk("x"), chunk("y")]);
    const system = messages[0].content;
    for (const s of REPORT_SECTIONS) expect(system).toContain(`## ${s.heading}`);
    expect(system).toContain("not a full audit");
    expect(system).toContain("<<<REPO CHUNK 2: src/y.py | Lines 1-10>>>");
    expect(usedChunks.map((c) => c.id)).toEqual(["x", "y"]);
  });

  it("drops chunks that don't fit, keeping the first ones", () => {
    const big = "x".repeat(4000 * 4); // about 4,000 tokens each
    const chunks = ["c1", "c2", "c3", "c4", "c5"].map((id) => chunk(id, big));
    const { usedChunks } = buildReportPrompt(manifest, chunks);
    expect(usedChunks.length).toBeGreaterThan(0);
    expect(usedChunks.length).toBeLessThan(5);
    expect(usedChunks[0].id).toBe("c1");
  });
});

describe("structureSection (Phase 4 import graph)", () => {
  const graph: ImportGraph = {
    repoId: "o/r",
    commitSha: "abc",
    generatedAt: "2026-11-09T00:00:00Z",
    files: ["agents.py", "demo.py", "tests/test_agents.py"],
    edges: [
      { from: "demo.py", to: "agents.py", line: 1 },
      { from: "tests/test_agents.py", to: "agents.py", line: 2 },
    ],
    external: [{ name: "pytest", files: ["tests/test_agents.py"] }],
    unresolved: [],
    stats: { imports: 4, internal: 2, external: 1, builtin: 1, unresolved: 0 },
  };

  it("lists the most depended-on files, outside packages and files nothing imports", () => {
    const text = structureSection(graph);
    expect(text).toContain("## Code structure (from imports)");
    expect(text).toContain("Read 3 code files with 2 import links between them. 100% of imports between repo files could be followed.");
    expect(text).toContain("- `agents.py`: imported by 2 files");
    expect(text).toContain("**Outside packages used:** `pytest` (1 file).");
    expect(text).toContain("`demo.py`, `tests/test_agents.py`.");
  });

  it("explains when there is no graph, or no supported code files", () => {
    expect(structureSection(null)).toContain("couldn't be built");
    expect(structureSection({ ...graph, files: [], edges: [], external: [] })).toContain("No Python, JavaScript or TypeScript files");
  });
});

describe("architectureSection (Phase 4 architecture map)", () => {
  const graph: ImportGraph = {
    repoId: "o/r",
    commitSha: "abc",
    generatedAt: "2026-11-09T00:00:00Z",
    files: ["main.py", "app/a.py", "lib/b.py"],
    edges: [
      { from: "main.py", to: "app/a.py", line: 1 },
      { from: "app/a.py", to: "lib/b.py", line: 1 },
      { from: "lib/b.py", to: "app/a.py", line: 2 },
    ],
    external: [],
    unresolved: [],
    stats: { imports: 3, internal: 3, external: 0, builtin: 0, unresolved: 0 },
  };

  it("includes the diagram as a mermaid block and lists the cycles", () => {
    const text = architectureSection(buildArchitecture(graph, null));
    expect(text).toContain("## Architecture map");
    expect(text).toContain("```mermaid\nflowchart LR");
    expect(text).toContain("Red arrows are part of a cycle.");
    expect(text).toContain("- Folders: `app` ⇄ `lib`");
    expect(text).toContain("- Files: `app/a.py` ⇄ `lib/b.py`");
  });

  it("says when there are no cycles, and is empty when there's nothing to draw", () => {
    const oneWay = { ...graph, edges: graph.edges.slice(0, 2) };
    expect(architectureSection(buildArchitecture(oneWay, null))).toContain("No cycles");
    expect(architectureSection(null)).toBe("");
    expect(architectureSection(buildArchitecture({ ...graph, files: [], edges: [] }, null))).toBe("");
  });
});
