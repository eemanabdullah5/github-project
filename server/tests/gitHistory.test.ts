// Tests for F4 — git history hotspots.
// GitHub is replaced with fakes (no network), and data/ is a temporary folder.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors.js";
import type { CommitRecord, SourceFile } from "../src/types.js";

const tempDir = mkdtempSync(path.join(tmpdir(), "history-test-"));
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  DATA_DIR: tempDir,
}));
// Fake GitHub: each test decides what these return.
vi.mock("../src/githubClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/githubClient.js")>()),
  getRepo: vi.fn(async () => ({ sizeKb: 10, defaultBranch: "main" })),
  getLatestCommitSha: vi.fn(async () => "sha-now"),
  downloadZipball: vi.fn(async () => new Uint8Array()),
  listCommits: vi.fn(),
  getCommitFiles: vi.fn(),
}));
// Fake ingestion: the "current code" is one small file.
vi.mock("../src/ingestion.js", () => ({
  checkRepoSize: vi.fn(),
  extractSourceFiles: vi.fn(() => [{ path: "src/a.ts", text: "if (x) {}", language: "typescript" }]),
}));

const { analyzeHistory, computeReport, countComplexity, loadHistory } = await import("../src/gitHistory.js");
const { getCommitFiles, listCommits } = await import("../src/githubClient.js");

afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

// Small helpers to build test data.
const file = (p: string, text: string, language = "typescript"): SourceFile => ({ path: p, text, language });
const commit = (sha: string, author: string, paths: string[], date = "2026-06-01T00:00:00Z"): CommitRecord => ({
  sha,
  author,
  date,
  fileCount: paths.length,
  files: paths.map((p) => ({ path: p, added: 10, deleted: 2 })),
});
const meta = {
  repoId: "octo/hello",
  commitSha: "sha-now",
  since: "2025-11-08T00:00:00Z",
  skipped: { merges: 0, bots: 0, large: 0 },
  reachedLimit: false,
};

describe("countComplexity", () => {
  it("counts decision points", () => {
    expect(countComplexity("if (a && b) { for (x of y) {} } else if (c || d) {}")).toBe(5); // if, for, if, &&, ||
    expect(countComplexity("const v = ok ? 1 : 2;")).toBe(1);
  });

  it("ignores ?. and ?? and optional types", () => {
    expect(countComplexity("const a = b?.c ?? d; function f(x?: number) {}")).toBe(0);
  });

  it("doesn't count words that only contain a keyword", () => {
    expect(countComplexity("const notify = format; caseStudy();")).toBe(0);
  });
});

describe("computeReport", () => {
  const files = [
    file("src/billing.ts", "if (a) {}\nif (b) {}\nwhile (c) {}"), // complexity 3
    file("src/util.ts", "if (a) {}"), // complexity 1
    file("README.md", "if you read this", "markdown"), // docs count as 0
    file("docs/guide.md", "hello", "markdown"),
  ];
  const commits = [
    commit("c1", "alice", ["src/billing.ts", "src/util.ts"]),
    commit("c2", "alice", ["src/billing.ts", "src/util.ts"]),
    commit("c3", "bob", ["src/billing.ts", "src/util.ts", "README.md"], "2026-09-01T00:00:00Z"),
    commit("c4", "alice", ["src/util.ts"]),
    commit("c5", "carol", ["docs/guide.md"]),
    commit("c6", "carol", ["docs/guide.md"]),
    commit("c7", "carol", ["docs/guide.md"]),
    commit("c8", "alice", ["deleted/old.ts"]), // this file no longer exists
  ];
  const report = computeReport(commits, files, meta);

  it("scores files by changes × complexity, with the riskiest file at 100", () => {
    const billing = report.files.find((f) => f.path === "src/billing.ts")!;
    expect(billing).toMatchObject({ changes: 3, complexity: 3, authors: 2, linesAdded: 30, linesDeleted: 6, lines: 3, score: 100 });
    expect(billing.lastChanged).toBe("2026-09-01T00:00:00Z");
    // util: 4 changes × 1 = 4. billing: 3 × 3 = 9. So util = round(400 / 9) = 44.
    expect(report.files.find((f) => f.path === "src/util.ts")!.score).toBe(44);
    expect(report.files[0].path).toBe("src/billing.ts");
    expect(report.filesChanged).toBe(4); // billing, util, README, guide (the deleted file doesn't count)
  });

  it("gives docs a complexity of 0 and ignores deleted files", () => {
    expect(report.files.find((f) => f.path === "README.md")).toMatchObject({ complexity: 0, score: 0 });
    expect(report.files.some((f) => f.path === "deleted/old.ts")).toBe(false);
  });

  it("lists files that changed together at least 3 times", () => {
    expect(report.coChange).toEqual([{ a: "src/billing.ts", b: "src/util.ts", count: 3, percent: 100 }]);
  });

  it("flags folders only one person changed, without storing any names", () => {
    expect(report.areas.find((a) => a.area === "docs")).toEqual({ area: "docs", commits: 3, authors: 1, files: 1, singleContributor: true });
    expect(report.areas.find((a) => a.area === "src")).toMatchObject({ authors: 2, singleContributor: false });
    expect(report.areas.find((a) => a.area === "(root files)")).toMatchObject({ commits: 1, singleContributor: false });
    expect(JSON.stringify(report)).not.toMatch(/alice|bob|carol/);
  });

  it("counts big commits for hotspots, but leaves them out of 'files that change together'", () => {
    // 3 big commits (40 files each) that all change billing.ts and util.ts together.
    const bigFiles = ["src/billing.ts", "src/util.ts", ...Array.from({ length: 38 }, (_, i) => `f${i}.ts`)];
    const big = ["b1", "b2", "b3"].map((sha) => commit(sha, "dave", bigFiles));
    const r = computeReport([...commits, ...big], files, meta);

    expect(r.skipped.large).toBe(3);
    expect(r.commitsAnalyzed).toBe(commits.length + 3);
    // Hotspots: billing.ts goes from 3 changes to 6, and "dave" counts as a person.
    expect(r.files.find((f) => f.path === "src/billing.ts")).toMatchObject({ changes: 6, authors: 3 });
    // Co-change: still 3 (from the small commits), not 6.
    expect(r.coChange[0]).toMatchObject({ a: "src/billing.ts", b: "src/util.ts", count: 3 });
  });
});

describe("analyzeHistory", () => {
  // A fake entry from GitHub's commit list.
  const summary = (sha: string, extra = {}) => ({ sha, authorId: "octo", date: "2026-06-01T00:00:00Z", isMerge: false, isBot: false, ...extra });

  beforeEach(() => {
    vi.mocked(listCommits).mockReset();
    vi.mocked(getCommitFiles).mockReset();
    vi.mocked(getCommitFiles).mockResolvedValue([{ path: "src/a.ts", added: 1, deleted: 0, status: "modified" }]);
  });

  it("skips merges and bots, saves the report, and stores no names", async () => {
    vi.mocked(listCommits).mockResolvedValue([summary("s1"), summary("s2", { isMerge: true }), summary("s3", { isBot: true })]);
    const report = await analyzeHistory("octo", "hello");

    expect(getCommitFiles).toHaveBeenCalledTimes(1); // only s1
    expect(report).toMatchObject({ commitSha: "sha-now", commitsAnalyzed: 1, skipped: { merges: 1, bots: 1, large: 0 } });
    expect((await loadHistory("octo/hello"))!.report.files[0].path).toBe("src/a.ts");
    // The author "octo" must only appear as a hash in the saved file.
    expect(readFileSync(path.join(tempDir, "history", "octo__hello.json"), "utf8")).not.toContain('"octo"');
  });

  it("reuses saved commits and only asks GitHub about new ones", async () => {
    vi.mocked(listCommits).mockResolvedValue([summary("s4"), summary("s1")]); // s1 was saved by the test above
    const report = await analyzeHistory("octo", "hello");
    expect(getCommitFiles).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getCommitFiles).mock.calls[0][2]).toBe("s4");
    expect(report.commitsAnalyzed).toBe(2);
  });

  it("ignores files that were only renamed (no lines changed)", async () => {
    vi.mocked(listCommits).mockResolvedValue([summary("r1")]);
    vi.mocked(getCommitFiles).mockResolvedValue([
      { path: "src/a.ts", added: 0, deleted: 0, status: "renamed" }, // just moved: not work
      { path: "src/b.ts", added: 2, deleted: 1, status: "renamed" }, // moved and edited: counts
    ]);
    await analyzeHistory("octo", "renames");
    const saved = (await loadHistory("octo/renames"))!;
    expect(saved.commits[0].files.map((f) => f.path)).toEqual(["src/b.ts"]);
    expect(saved.commits[0].fileCount).toBe(2);
  });

  it("passes GitHub errors on, so the user sees the message", async () => {
    vi.mocked(listCommits).mockRejectedValue(new AppError("GitHub rate limit reached. Try again after 3:00 PM.", 429));
    await expect(analyzeHistory("octo", "other")).rejects.toThrow(/rate limit/);
  });

  it("refuses to analyse the same repo twice at the same time", async () => {
    let finish!: () => void;
    vi.mocked(listCommits).mockReturnValue(new Promise((resolve) => (finish = () => resolve([]))));
    const first = analyzeHistory("octo", "busy");
    await expect(analyzeHistory("octo", "busy")).rejects.toMatchObject({ status: 409 });
    finish();
    await first;
  });
});
