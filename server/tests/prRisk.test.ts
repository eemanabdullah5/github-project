// Tests for the PR risk briefing: reading PR links, diffs → changed lines → functions, the risk score, reviewers.
import { describe, expect, it } from "vitest";
import { buildCallGraph } from "../src/callGraph.js";
import type { PullRequestFile, PullRequestInfo } from "../src/githubClient.js";
import { buildBriefing, changedLines, functionsAtLines, parsePrInput, pickReviewers, scoreFor, scoreRisk } from "../src/prRisk.js";
import type { HistoryReport, SourceFile } from "../src/types.js";

const ts = (path: string, text: string): SourceFile => ({ path, text, language: "typescript" });

// store.query ← rag.answer ← app.handleChat; store.load is called by nothing; a test reaches answer.
const graphPromise = buildCallGraph(
  [
    ts("src/store.ts", `export function query() {\n  return 1;\n}\nexport function load() {\n  return 2;\n}`),
    ts("src/rag.ts", `import { query } from "./store.js";\nexport function answer() {\n  query();\n}`),
    ts("src/app.ts", `import { answer } from "./rag.js";\nexport function handleChat() {\n  answer();\n}`),
    ts("tests/rag.test.ts", `import { answer } from "../src/rag.js";\nfunction checksAnswer() {\n  answer();\n}`),
  ],
  { repoId: "o/r", commitSha: "head" },
);

const pr: PullRequestInfo = {
  number: 7, title: "Change query", url: "https://github.com/o/r/pull/7", author: "alice", state: "open", draft: false,
  baseRef: "main", headSha: "head", baseSha: "base", additions: 10, deletions: 2, changedFiles: 1, updatedAt: "2026-11-12T00:00:00Z",
};
const file = (path: string, patch?: string, status = "modified"): PullRequestFile => ({ path, status, additions: 1, deletions: 1, patch });

describe("parsePrInput", () => {
  it("reads PR links, owner/repo#n and plain numbers", () => {
    expect(parsePrInput("https://github.com/octo/hello/pull/42/files")).toEqual({ owner: "octo", repo: "hello", number: 42 });
    expect(parsePrInput("octo/hello#42")).toEqual({ owner: "octo", repo: "hello", number: 42 });
    expect(parsePrInput("#42")).toEqual({ number: 42 });
    expect(parsePrInput("42")).toEqual({ number: 42 });
    expect(parsePrInput("hello")).toBeNull();
    expect(parsePrInput("0")).toBeNull();
  });
});

describe("changedLines", () => {
  it("finds added lines and where deletions happened, in new-file line numbers", () => {
    const patch = "@@ -1,4 +1,4 @@\n line one\n-old two\n+new two\n line three\n@@ -10,2 +10,3 @@\n ten\n+eleven\n twelve";
    expect(changedLines(patch)).toEqual([2, 11]);
  });

  it("ignores the 'no newline' marker", () => {
    expect(changedLines("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b")).toEqual([1]);
  });
});

describe("functionsAtLines", () => {
  it("maps lines to the function containing them", async () => {
    const g = await graphPromise;
    expect(functionsAtLines(g, "src/store.ts", [2, 5]).map((f) => f.id)).toEqual(["src/store.ts#query", "src/store.ts#load"]);
    expect(functionsAtLines(g, "src/store.ts", [99])).toEqual([]); // outside every function, and no top-level code
  });
});

describe("scoreRisk", () => {
  const base = { lines: 10, affected: 0, untested: [], codeChanged: true, testsChanged: true, hotspots: [], missingPartners: 0, knowledgeRisk: [] };

  it("is low with no reasons for a small, tested change", () => {
    expect(scoreRisk(base)).toEqual({ score: 0, level: "low", reasons: [] });
  });

  it("adds points with a reason for each risk", () => {
    const risk = scoreRisk({
      ...base,
      lines: 600,
      affected: 30,
      testsChanged: false,
      hotspots: [{ file: "src/app.ts", heat: 3 }],
      missingPartners: 1,
      knowledgeRisk: ["server"],
    });
    expect(risk.reasons.map((r) => r.points)).toEqual([2, 2, 1, 2, 1, 1]);
    expect(risk.score).toBe(9);
    expect(risk.level).toBe("high");
    expect(risk.reasons[0].text).toBe("Large change: 600 lines");
  });
});

describe("buildBriefing", () => {
  it("finds changed functions, what depends on them and the tests that reach them", async () => {
    const b = buildBriefing({ pr, prFiles: [file("src/store.ts", "@@ -1,3 +1,3 @@\n export function query() {\n-  return 0;\n+  return 1;\n }")], graph: await graphPromise, graphFrom: "pr", history: null });
    expect(b.changedFunctions.map((c) => c.fn.id)).toEqual(["src/store.ts#query"]);
    expect(b.affected.functions).toBe(2); // answer, handleChat
    expect(b.tests.reaching.map((f) => f.id)).toEqual(["tests/rag.test.ts#checksAnswer"]);
    expect(b.tests.untested).toEqual([]);
    expect(b.risk.reasons.map((r) => r.text)).toEqual(["Changes code but no test files"]);
    expect(b.notes[0]).toMatch(/Git history hasn't been analysed/);
  });

  it("flags changed functions no test reaches", async () => {
    const b = buildBriefing({ pr, prFiles: [file("src/store.ts", "@@ -4,3 +4,3 @@\n export function load() {\n-  return 0;\n+  return 2;\n }")], graph: await graphPromise, graphFrom: "pr", history: null });
    expect(b.tests.untested.map((f) => f.id)).toEqual(["src/store.ts#load"]);
    expect(b.risk.reasons[0].text).toBe("1 changed function isn't reached by any test: load()");
  });

  it("uses history: hotspots, missing co-change partners and knowledge risk", async () => {
    const history = {
      files: [{ path: "src/store.ts", score: 90 }],
      coChange: [],
      coChangeAll: [{ a: "src/store.ts", b: "docs/api.md", count: 5, percent: 80 }],
      areas: [{ area: "src", commits: 5, authors: 1, files: 3, singleContributor: true }],
    } as unknown as HistoryReport;
    const b = buildBriefing({ pr, prFiles: [file("src/store.ts", "@@ -2 +2 @@\n-  return 0;\n+  return 1;")], graph: await graphPromise, graphFrom: "pr", history });
    expect(b.files[0].hotspot).toBe(3);
    expect(b.missingPartners).toEqual([{ changed: "src/store.ts", partner: "docs/api.md", count: 5, percent: 80 }]);
    expect(b.knowledgeRisk).toEqual(["src"]);
    expect(b.risk.reasons.map((r) => r.points)).toEqual([1, 2, 1, 1]); // no tests changed, hotspot, partner, knowledge
  });

  it("notes code files GitHub gave no diff for", async () => {
    const b = buildBriefing({ pr, prFiles: [file("src/big.ts")], graph: await graphPromise, graphFrom: "pr", history: null });
    expect(b.files[0].noDiff).toBe(true);
    expect(b.notes.some((n) => n.includes("no diff"))).toBe(true);
  });
});

describe("complexity before and after", () => {
  it("finds a function's score by line in the new code and by name in the old code", async () => {
    const fn = (await graphPromise).functions.find((f) => f.id === "src/store.ts#query")!;
    expect(scoreFor(fn, [{ name: "query", line: 1, endLine: 3, complexity: 7 }], true)).toBe(7);
    expect(scoreFor(fn, [{ name: "query", line: 40, endLine: 50, complexity: 2 }], false)).toBe(2);
    expect(scoreFor(fn, [{ name: "other", line: 1, endLine: 3, complexity: 9 }], false)).toBeNull();
  });

  it("adds a risk point, with before → after, when a function gets much harder to follow", () => {
    const base = { lines: 10, affected: 0, untested: [], codeChanged: true, testsChanged: true, hotspots: [], missingPartners: 0, knowledgeRisk: [] };
    const risk = scoreRisk({ ...base, moreComplex: [{ name: "buildPrompt()", before: 6, after: 14 }, { name: "x()", before: null, after: 11 }] });
    expect(risk.reasons).toEqual([{ points: 1, text: "Makes code harder to follow: buildPrompt() complexity 6 → 14 and 1 more" }]);
    expect(scoreRisk({ ...base, moreComplex: [{ name: "big()", before: 20, after: 30 }] }).reasons[0].points).toBe(2);
  });

  it("only counts big rises and complex new functions", async () => {
    const patch = "@@ -1,3 +1,3 @@\n export function query() {\n-  return 0;\n+  return 1;\n }";
    const testPatch = "@@ -1 +1 @@\n-a\n+b"; // a test file changes too, so only the complexity rule can apply
    const g = await graphPromise;
    const brief = (before: number | null, after: number) =>
      buildBriefing({
        pr,
        prFiles: [file("src/store.ts", patch), file("tests/rag.test.ts", testPatch)],
        graph: g,
        graphFrom: "pr",
        history: null,
        complexity: new Map([["src/store.ts#query", { before, after }]]),
      });
    expect(brief(6, 14).risk.reasons.map((r) => r.text)).toEqual(["Makes code harder to follow: query() complexity 6 → 14"]);
    expect(brief(6, 9).risk.reasons).toEqual([]); // a rise of 3: not counted
    expect(brief(null, 12).risk.reasons[0].text).toBe("Makes code harder to follow: query() new, complexity 12");
    expect(brief(6, 14).changedFunctions[0].complexity).toEqual({ before: 6, after: 14 });
  });
});

describe("history age", () => {
  it("shows when history was analysed, and notes when it's old", async () => {
    const history = { generatedAt: "2026-09-01T00:00:00Z", files: [], coChange: [], areas: [] } as unknown as HistoryReport;
    const b = buildBriefing({ pr, prFiles: [], graph: await graphPromise, graphFrom: "pr", history, now: new Date("2026-11-12T00:00:00Z") });
    expect(b.historyDate).toBe("2026-09-01T00:00:00Z");
    expect(b.notes[0]).toMatch(/analysed 72 days ago/);
    const fresh = buildBriefing({ pr, prFiles: [], graph: await graphPromise, graphFrom: "pr", history, now: new Date("2026-09-10T00:00:00Z") });
    expect(fresh.notes).toEqual([]);
  });
});

describe("pickReviewers", () => {
  it("ranks people by how many of the files they changed, leaving out the PR author", () => {
    expect(pickReviewers([["bob", "alice", "bob"], ["carol", "bob"], ["alice"]], "alice")).toEqual([
      { login: "bob", files: 2 },
      { login: "carol", files: 1 },
    ]);
  });
});
