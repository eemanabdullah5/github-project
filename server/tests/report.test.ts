// Tests for F5 — repo health report. These cover the parts that don't need the AI or the network.
import { describe, expect, it } from "vitest";
import {
  REPORT_SECTIONS,
  buildReportPrompt,
  factsSection,
  hotspotsSection,
  languageBreakdown,
  architectureSection,
  dependenciesSection,
  libraryRows,
  mergeRoundRobin,
  removeDependencyCitations,
  structureSection,
} from "../src/report.js";
import { buildArchitecture } from "../src/architecture.js";
import type { DependencyScan } from "../src/dependencies.js";
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

  it("leaves out the git history rule and block when history hasn't been analysed", () => {
    const system = buildReportPrompt(manifest, [chunk("x")], null).messages[0].content;
    expect(system).not.toContain("GIT HISTORY SUMMARY");
    expect(system).not.toContain("Git history summary");
  });

  it("gives the AI a short hotspot summary and a rule to use it in the risks", () => {
    const history = {
      commitsAnalyzed: 24,
      files: [
        { path: "src/app.ts", score: 100, changes: 9, authors: 1, complexity: 14 },
        { path: "README.md", score: 0, changes: 5, authors: 2, complexity: 0 }, // score 0: left out
      ],
      coChange: [{ a: "src/app.ts", b: "src/db.ts", count: 6, percent: 75 }],
      areas: [{ area: "server", singleContributor: true }],
    } as unknown as HistoryReport;
    const system = buildReportPrompt(manifest, [chunk("x")], history).messages[0].content;
    expect(system).toContain("<<<REPO GIT HISTORY SUMMARY (24 commits, last 12 months)>>>");
    expect(system).toContain("- src/app.ts: score 100, 9 changes, 1 author, complexity 14");
    expect(system).not.toContain("README.md: score");
    expect(system).toContain("- src/app.ts and src/db.ts: 6 times (75%)");
    expect(system).toContain("Areas only one person has changed: server");
    expect(system).toContain('In "Risks and tech debt", mention');
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

  it("lists hidden coupling when the history was analysed, and leaves it out when it wasn't", () => {
    const history = {
      repoId: "o/r", commitSha: "abc", generatedAt: "", since: "", commitsAnalyzed: 10,
      skipped: { merges: 0, bots: 0, large: 0 }, reachedLimit: false, filesChanged: 3, files: [], areas: [],
      coChange: [],
      coChangeAll: [
        { a: "app/a.py", b: "lib/b.py", count: 5, percent: 80 }, // imports each other: not listed
        { a: "app/a.py", b: "main.py", count: 4, percent: 50 }, // main imports a: not listed
        { a: "lib/b.py", b: "main.py", count: 3, percent: 60 }, // main → a → b: indirect
      ],
    } satisfies HistoryReport;
    const text = architectureSection(buildArchitecture(graph, history));
    expect(text).toContain("**Hidden coupling**");
    expect(text).toContain("- `lib/b.py` and `main.py`: changed together 3 times (60%), linked only through `app/a.py`");
    expect(architectureSection(buildArchitecture(graph, null))).not.toContain("Hidden coupling");

    const allLinked = { ...history, coChangeAll: history.coChangeAll.slice(0, 2) };
    expect(architectureSection(buildArchitecture(graph, allLinked))).toContain("None: all 2 pairs of code files");
  });
});

describe("dependenciesSection and the AI's dependency list", () => {
  const dep = (name: string, version: string, file: string, kind: "runtime" | "dev" = "runtime", ecosystem: "npm" | "pip" = "npm") => ({ name, version, kind, ecosystem, file });
  const scan: DependencyScan = {
    repoId: "o/r",
    commitSha: "abc",
    generatedAt: "",
    files: [
      { path: "server/package.json", ecosystem: "npm", count: 3 },
      { path: "web/package.json", ecosystem: "npm", count: 2 },
      { path: "requirements.txt", ecosystem: "pip", count: 1 },
      { path: "broken/package.json", ecosystem: "npm", count: 0, error: "Unexpected token" },
    ],
    dependencies: [
      dep("express", "^5.1.0", "server/package.json"),
      dep("typescript", "^5.6.0", "server/package.json", "dev"),
      dep("vitest", "^3.2.0", "server/package.json", "dev"),
      dep("typescript", "^5.7.0", "web/package.json", "dev"), // same library, another file and version
      dep("vitest", "1 || 2", "web/package.json", "dev"),
      dep("requests", "", "requirements.txt", "runtime", "pip"), // no version
    ],
  };

  it("counts each library once, lists every version and file, and runtime ones first", () => {
    const rows = libraryRows(scan);
    expect(rows.map((r) => r.name)).toEqual(["express", "requests", "typescript", "vitest"]);
    expect(rows.find((r) => r.name === "typescript")).toMatchObject({ versions: ["^5.6.0", "^5.7.0"], files: ["server/package.json", "web/package.json"] });
  });

  it("writes the section with counts, a no-version warning, read errors and a table per language", () => {
    const text = dependenciesSection(scan);
    expect(text).toContain("## Dependencies (from the dependency files)");
    expect(text).toContain("Read 3 dependency files: `server/package.json` (3), `web/package.json` (2), `requirements.txt` (1).");
    expect(text).toContain("**4 libraries**: 2 needed to run the app, 2 only for development and tests.");
    expect(text).toContain("⚠ **1 library has no version**");
    expect(text).toContain("`requests`");
    expect(text).toContain("⚠ Couldn't read `broken/package.json`: Unexpected token");
    expect(text).toContain("### JavaScript / TypeScript (npm)");
    expect(text).toContain("### Python (pip)");
    expect(text).toContain("| express | `^5.1.0` | runtime | `server/package.json` |");
    expect(text).toContain("`1 \\|\\| 2`"); // "|" escaped so the table doesn't break
    expect(text).toContain("| requests | _none_ | runtime | `requirements.txt` |");
  });

  it("says so when there are no dependency files, or the scan failed", () => {
    expect(dependenciesSection({ ...scan, files: [], dependencies: [] })).toContain("No dependency files found");
    expect(dependenciesSection(null)).toContain("couldn't be read");
  });

  it("gives the AI the exact list and a rule not to contradict it", () => {
    const system = buildReportPrompt(manifest, [chunk("x")], null, scan).messages[0].content;
    expect(system).toContain("<<<REPO DEPENDENCY FILES (exact)>>>");
    expect(system).toContain("needed to run: express ^5.1.0");
    expect(system).toContain("development only: typescript ^5.6.0 / ^5.7.0");
    expect(system).toContain("requests (no version)");
    expect(system).toContain("7. The \"Dependency files\" block is the exact list"); // rule 7 when there's no history
    const without = buildReportPrompt(manifest, [chunk("x")]).messages[0].content;
    expect(without).not.toContain("DEPENDENCY FILES");
    expect(without).not.toContain("Dependency files");
  });
});

describe("removeDependencyCitations", () => {
  it("removes made-up 'Dependency files' citations and keeps real ones", () => {
    expect(removeDependencyCitations("Express 5 [README.md:L1-L2, Dependency files].")).toBe("Express 5 [README.md:L1-L2].");
    expect(removeDependencyCitations("React 19 [Dependency files].")).toBe("React 19.");
    expect(removeDependencyCitations("Uses [a.ts:L1-L3] and [b.ts:L4].")).toBe("Uses [a.ts:L1-L3] and [b.ts:L4].");
  });
});
