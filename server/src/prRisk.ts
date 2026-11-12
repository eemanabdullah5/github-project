// PR risk briefing: a one-screen summary of a pull request: what it changes, how far that spreads, whether
// tests reach it, and a risk score where every point has a reason. Built from the call graph, change impact
// and git history. No AI.
import { buildCallGraph, getCallGraph, isTestFile, type CallFunction, type CallGraph } from "./callGraph.js";
import { heatLevel } from "./architecture.js";
import { measureFunctions, type FunctionScore } from "./complexity.js";
import { AppError } from "./errors.js";
import {
  downloadZipball,
  getFileAtRef,
  getPullRequest,
  getPullRequestFiles,
  recentFileAuthors,
  toRepoId,
  type PullRequestFile,
  type PullRequestInfo,
} from "./githubClient.js";
import { areaOf, loadHistory } from "./gitHistory.js";
import { changeImpact, isHotspot } from "./impact.js";
import { detectLanguage, extractSourceFiles } from "./ingestion.js";
import type { HistoryReport, SourceFile } from "./types.js";

/** Files whose authors are looked up for reviewers (one GitHub call each). */
const MAX_REVIEWER_FILES = 5;
const MAX_REVIEWERS = 3;
/** Co-change pairs this strong count as "usually change together". */
const PARTNER_MIN_PERCENT = 50;
/** Files whose old version is fetched to compare complexity (one GitHub call each). */
const MAX_COMPLEXITY_FILES = 20;
/** History older than this gets a "may be out of date" note. */
const STALE_HISTORY_DAYS = 30;
/** Code file extensions, for "code changed but no tests". */
const CODE_FILE = /\.(?:py|[cm]?[jt]sx?|go|java|kt|rb|php|cs|rs|swift|c|cc|cpp|h|hpp|scala)$/i;

// ---------- Types ----------

export interface PrFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  isTest: boolean;
  isCode: boolean;
  hotspot: 0 | 1 | 2 | 3;
  functions: string[]; // ids of changed functions in it
  noDiff: boolean; // GitHub gave no diff (binary or very large), so its functions are unknown
}

export interface PrFunction {
  fn: CallFunction;
  affected: number; // functions that depend on it
  tests: number; // tests that reach it
  maxDistance: number;
  complexity?: Complexity; // before → after, if it could be measured
}

/** A function's complexity before and after the PR; before = null for a new function. */
export interface Complexity {
  before: number | null;
  after: number;
}

export interface RiskReason {
  points: number;
  text: string;
}

export interface PrBriefing {
  pr: PullRequestInfo;
  graphFrom: "pr" | "indexed"; // which code the call graph was built from
  files: PrFile[];
  changedFunctions: PrFunction[]; // most affected first
  affected: { functions: number; files: number; hotspotFiles: string[]; entryPoints: CallFunction[] }; // all changed functions together
  tests: { changedTestFiles: string[]; reaching: CallFunction[]; untested: CallFunction[] };
  missingPartners: Array<{ changed: string; partner: string; count: number; percent: number }>;
  knowledgeRisk: string[]; // touched folders only one person has changed
  risk: { score: number; level: "low" | "medium" | "high"; reasons: RiskReason[] };
  reviewers: Array<{ login: string; files: number }>;
  historyDate: string | null; // when the git history was analysed
  notes: string[];
}

// ---------- Pure helpers ----------

/** Reads a PR from "https://github.com/o/r/pull/12", "o/r#12", "#12" or "12". */
export function parsePrInput(input: string): { owner?: string; repo?: string; number: number } | null {
  const text = input.trim();
  const url = text.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i);
  if (url) return { owner: url[1], repo: url[2], number: Number(url[3]) };
  const short = text.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (short) return { owner: short[1], repo: short[2], number: Number(short[3]) };
  const num = text.match(/^#?(\d+)$/);
  return num && Number(num[1]) > 0 ? { number: Number(num[1]) } : null;
}

/** New-file line numbers a diff adds or changes, plus where deletions happened. */
export function changedLines(patch: string): number[] {
  const lines = new Set<number>();
  let line = 0;
  for (const row of patch.split("\n")) {
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (row.startsWith("+")) lines.add(line++);
    else if (row.startsWith("-")) lines.add(Math.max(1, line)); // a deletion touches the line where it was
    else if (!row.startsWith("\\")) line++; // context line ("\ No newline at end of file" doesn't count)
  }
  return [...lines].sort((a, b) => a - b);
}

/** The innermost function containing each line; lines outside any function go to the file's top-level code. */
export function functionsAtLines(graph: CallGraph, file: string, lines: number[]): CallFunction[] {
  const inFile = graph.functions.filter((f) => f.file === file);
  const real = inFile.filter((f) => f.kind !== "top-level");
  const topLevel = inFile.find((f) => f.kind === "top-level");
  const found = new Map<string, CallFunction>();
  for (const line of lines) {
    const containing = real.filter((f) => f.line <= line && line <= f.endLine);
    const inner = containing.sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0] ?? topLevel;
    if (inner) found.set(inner.id, inner);
  }
  return [...found.values()];
}

/** The risk score: each rule adds points with a reason, so the number can always be explained. */
export function scoreRisk(input: {
  lines: number;
  affected: number;
  untested: CallFunction[];
  codeChanged: boolean;
  testsChanged: boolean;
  hotspots: Array<{ file: string; heat: number }>;
  missingPartners: number;
  knowledgeRisk: string[];
  moreComplex?: Array<{ name: string; before: number | null; after: number }>; // biggest increase first
}): PrBriefing["risk"] {
  const reasons: RiskReason[] = [];
  const add = (points: number, text: string) => points > 0 && reasons.push({ points, text });
  const names = (fns: CallFunction[]) => fns.slice(0, 3).map((f) => `${f.qualified}()`).join(", ") + (fns.length > 3 ? "…" : "");

  if (input.lines > 500) add(2, `Large change: ${input.lines} lines`);
  else if (input.lines > 200) add(1, `Medium-size change: ${input.lines} lines`);
  if (input.affected >= 25) add(2, `Spreads widely: ${input.affected} other functions depend on the changed code`);
  else if (input.affected >= 8) add(1, `Spreads: ${input.affected} other functions depend on the changed code`);
  if (input.untested.length) add(2, `${input.untested.length} changed function${input.untested.length === 1 ? " isn't" : "s aren't"} reached by any test: ${names(input.untested)}`);
  if (input.codeChanged && !input.testsChanged) add(1, "Changes code but no test files");
  const hottest = Math.max(0, ...input.hotspots.map((h) => h.heat));
  if (hottest) add(hottest === 3 ? 2 : 1, `Changes ${input.hotspots.length} hotspot file${input.hotspots.length === 1 ? "" : "s"}: ${input.hotspots.slice(0, 3).map((h) => h.file).join(", ")}`);
  if (input.missingPartners) add(1, `${input.missingPartners} file${input.missingPartners === 1 ? "" : "s"} that usually change${input.missingPartners === 1 ? "s" : ""} with the changed ones ${input.missingPartners === 1 ? "isn't" : "aren't"} in the PR`);
  if (input.knowledgeRisk.length) add(1, `Touches code only one person has worked on: ${input.knowledgeRisk.join(", ")}`);
  const complex = input.moreComplex ?? [];
  if (complex.length) {
    const top = complex[0];
    const change = top.before === null ? `new, complexity ${top.after}` : `complexity ${top.before} → ${top.after}`;
    const others = complex.length > 1 ? ` and ${complex.length - 1} more` : "";
    add(complex.some((c) => c.after >= VERY_COMPLEX) ? 2 : 1, `Makes code harder to follow: ${top.name} ${change}${others}`);
  }

  const score = reasons.reduce((sum, r) => sum + r.points, 0);
  return { score, level: score >= 6 ? "high" : score >= 3 ? "medium" : "low", reasons };
}

/** Complexity this high (or higher) is hard to follow. */
const VERY_COMPLEX = 25;
/** A rise this big (or a new function this complex) counts as "harder to follow". */
const COMPLEXITY_RISE = 5;
const NEW_FUNCTION_COMPLEX = 10;

/** Finds a function's score: by its first line in the new code, by name in the old code. */
export function scoreFor(fn: CallFunction, scores: FunctionScore[], byLine: boolean): number | null {
  const match = byLine
    ? scores.find((s) => s.line === fn.line)
    : (scores.find((s) => s.name === fn.qualified) ?? scores.find((s) => s.name === fn.name || s.name.endsWith(`.${fn.name}`)));
  return match ? match.complexity : null;
}

/** Did the PR make this function noticeably harder to follow? */
function isMoreComplex(c: Complexity): boolean {
  return c.before === null ? c.after >= NEW_FUNCTION_COMPLEX : c.after - c.before >= COMPLEXITY_RISE;
}

/** Builds the briefing from data already fetched. No network or disk, so it's easy to test. */
export function buildBriefing(input: {
  pr: PullRequestInfo;
  prFiles: PullRequestFile[];
  graph: CallGraph;
  graphFrom: "pr" | "indexed";
  history: HistoryReport | null;
  reviewers?: PrBriefing["reviewers"];
  complexity?: Map<string, Complexity>; // function id → before/after
  notes?: string[];
  now?: Date; // for the "history out of date" note (tests)
}): PrBriefing {
  const { pr, prFiles, graph, history } = input;
  const notes = [...(input.notes ?? [])];
  const scores = new Map((history?.files ?? []).map((f) => [f.path, f.score]));
  const changedPaths = new Set(prFiles.map((f) => f.path));

  // Files and the functions changed in each.
  const changed = new Map<string, CallFunction>();
  const files: PrFile[] = prFiles.map((f) => {
    const fns = f.patch && f.status !== "removed" ? functionsAtLines(graph, f.path, changedLines(f.patch)) : [];
    for (const fn of fns) changed.set(fn.id, fn);
    return {
      path: f.path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      isTest: isTestFile(f.path),
      isCode: CODE_FILE.test(f.path),
      hotspot: heatLevel(scores.get(f.path)),
      functions: fns.map((fn) => fn.id),
      noDiff: !f.patch && f.status !== "removed",
    };
  });
  if (files.some((f) => f.noDiff && f.isCode)) notes.push("Some files had no diff from GitHub (binary or very large), so their functions weren't checked.");

  // Impact of each changed (non-test) function, and all of them together.
  const affectedIds = new Set<string>();
  const reaching = new Map<string, CallFunction>();
  const entryPoints = new Map<string, CallFunction>();
  const untested: CallFunction[] = [];
  const changedFunctions: PrFunction[] = [];
  for (const fn of changed.values()) {
    if (fn.isTest) continue;
    const impact = changeImpact(graph, fn.id, history);
    for (const i of impact.affected) if (!changed.has(i.fn.id)) affectedIds.add(i.fn.id);
    for (const i of impact.tests) reaching.set(i.fn.id, i.fn);
    for (const i of impact.entryPoints) entryPoints.set(i.fn.id, i.fn);
    if (impact.totals.tests === 0 && fn.kind !== "top-level") untested.push(fn);
    changedFunctions.push({ fn, affected: impact.totals.affected, tests: impact.totals.tests, maxDistance: impact.totals.maxDistance, complexity: input.complexity?.get(fn.id) });
  }
  changedFunctions.sort((a, b) => b.affected - a.affected || a.fn.id.localeCompare(b.fn.id));
  const fnById = new Map(graph.functions.map((f) => [f.id, f]));
  const affectedFiles = new Set([...affectedIds].map((id) => fnById.get(id)!.file));
  const hotspotFiles = [...affectedFiles].filter((f) => isHotspot(heatLevel(scores.get(f))) && !changedPaths.has(f));

  // Files that usually change with a changed file but aren't in the PR.
  const pairs = history?.coChangeAll ?? history?.coChange ?? [];
  const missingPartners = pairs
    .filter((p) => p.percent >= PARTNER_MIN_PERCENT && changedPaths.has(p.a) !== changedPaths.has(p.b))
    .map((p) => (changedPaths.has(p.a) ? { changed: p.a, partner: p.b, count: p.count, percent: p.percent } : { changed: p.b, partner: p.a, count: p.count, percent: p.percent }))
    .slice(0, 10);

  // Touched folders only one person has changed.
  const touched = new Set(prFiles.map((f) => areaOf(f.path)));
  const knowledgeRisk = (history?.areas ?? []).filter((a) => a.singleContributor && touched.has(a.area)).map((a) => a.area);
  if (!history) notes.push("Git history hasn't been analysed, so hotspots, files that change together and knowledge risk weren't checked. Run Analyse history in the Hotspots tab.");
  else {
    const days = Math.floor(((input.now ?? new Date()).getTime() - new Date(history.generatedAt).getTime()) / 86_400_000);
    if (days > STALE_HISTORY_DAYS) notes.push(`Git history was analysed ${days} days ago, so hotspots and files that change together may be out of date. Refresh it in the Hotspots tab.`);
  }

  // Functions the PR made noticeably harder to follow, biggest rise first.
  const moreComplex = changedFunctions
    .filter((c) => c.complexity && isMoreComplex(c.complexity))
    .map((c) => ({ name: `${c.fn.qualified}()`, before: c.complexity!.before, after: c.complexity!.after }))
    .sort((a, b) => b.after - (b.before ?? 0) - (a.after - (a.before ?? 0)));

  const changedTestFiles = files.filter((f) => f.isTest && f.status !== "removed").map((f) => f.path);
  const risk = scoreRisk({
    lines: pr.additions + pr.deletions,
    affected: affectedIds.size,
    untested,
    codeChanged: files.some((f) => f.isCode && !f.isTest),
    testsChanged: changedTestFiles.length > 0,
    hotspots: files.filter((f) => isHotspot(f.hotspot)).sort((a, b) => b.hotspot - a.hotspot).map((f) => ({ file: f.path, heat: f.hotspot })),
    missingPartners: missingPartners.length,
    knowledgeRisk,
    moreComplex,
  });

  return {
    pr,
    graphFrom: input.graphFrom,
    files,
    changedFunctions,
    affected: { functions: affectedIds.size, files: affectedFiles.size, hotspotFiles, entryPoints: [...entryPoints.values()] },
    tests: { changedTestFiles, reaching: [...reaching.values()], untested },
    missingPartners,
    knowledgeRisk,
    risk,
    reviewers: input.reviewers ?? [],
    historyDate: history?.generatedAt ?? null,
    notes,
  };
}

/** Suggests reviewers: people who changed the most of the PR's busiest code files recently (not the author). */
export function pickReviewers(authorsPerFile: string[][], prAuthor: string): PrBriefing["reviewers"] {
  const counts = new Map<string, number>();
  for (const authors of authorsPerFile) for (const login of new Set(authors)) if (login !== prAuthor) counts.set(login, (counts.get(login) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_REVIEWERS)
    .map(([login, files]) => ({ login, files }));
}

// ---------- Fetching everything ----------

// Call graphs (and code) of PR head commits, newest last. Why: opening the same PR twice shouldn't download it twice.
const prGraphs = new Map<string, Promise<{ graph: CallGraph; files: Map<string, SourceFile> }>>();
const MAX_CACHED_GRAPHS = 5;

/** The call graph of the PR's own code; falls back to the indexed code if that can't be downloaded. */
async function graphForPr(
  owner: string,
  repo: string,
  headSha: string,
): Promise<{ graph: CallGraph; from: "pr" | "indexed"; files: Map<string, SourceFile> }> {
  const repoId = toRepoId(owner, repo);
  let job = prGraphs.get(headSha);
  if (!job) {
    job = (async () => {
      const files = extractSourceFiles(await downloadZipball(owner, repo, headSha));
      return { graph: await buildCallGraph(files, { repoId, commitSha: headSha }), files: new Map(files.map((f) => [f.path, f])) };
    })();
    prGraphs.set(headSha, job);
    job.catch(() => prGraphs.delete(headSha));
    if (prGraphs.size > MAX_CACHED_GRAPHS) prGraphs.delete(prGraphs.keys().next().value!);
  }
  try {
    return { ...(await job), from: "pr" };
  } catch {
    return { graph: await getCallGraph(owner, repo, repoId), from: "indexed", files: new Map() };
  }
}

/** Complexity before and after for the changed functions: new code from the PR, old code fetched from GitHub. */
async function measureChanges(
  owner: string,
  repo: string,
  pr: PullRequestInfo,
  prFiles: PullRequestFile[],
  graph: CallGraph,
  headFiles: Map<string, SourceFile>,
): Promise<Map<string, Complexity>> {
  const result = new Map<string, Complexity>();
  const candidates = prFiles.filter((f) => f.patch && f.status !== "removed" && headFiles.has(f.path) && !isTestFile(f.path)).slice(0, MAX_COMPLEXITY_FILES);
  await Promise.all(
    candidates.map(async (f) => {
      const fns = functionsAtLines(graph, f.path, changedLines(f.patch!)).filter((fn) => fn.kind !== "top-level");
      if (!fns.length) return;
      const after = await measureFunctions(headFiles.get(f.path)!);
      if (!after) return;
      const oldPath = f.previousPath ?? f.path;
      const oldText = f.status === "added" ? null : await getFileAtRef(owner, repo, oldPath, pr.baseSha);
      const before = oldText === null ? [] : await measureFunctions({ path: oldPath, text: oldText, language: detectLanguage(oldPath) });
      if (before === null) return; // old version couldn't be parsed
      for (const fn of fns) {
        const now = scoreFor(fn, after, true);
        if (now !== null) result.set(fn.id, { before: scoreFor(fn, before, false), after: now });
      }
    }),
  );
  return result;
}

/** The full briefing for one pull request. */
export async function analyzePullRequest(owner: string, repo: string, number: number): Promise<PrBriefing> {
  if (!Number.isInteger(number) || number < 1) throw new AppError("That isn't a pull request number.", 400);
  const [pr, prFiles] = await Promise.all([getPullRequest(owner, repo, number), getPullRequestFiles(owner, repo, number)]).catch((err) => {
    if (err instanceof AppError && err.status === 404) throw new AppError(`Pull request #${number} wasn't found in ${owner}/${repo}, or your token can't access it.`, 404);
    throw err;
  });
  const notes: string[] = [];
  if (pr.changedFiles > prFiles.length) notes.push(`Only the first ${prFiles.length} of ${pr.changedFiles} changed files were checked.`);

  const { graph, from, files: headFiles } = await graphForPr(owner, repo, pr.headSha);
  if (from === "indexed") notes.push("The PR's code couldn't be downloaded (it may come from a fork), so the indexed code was used; line matches may be off.");
  const history = (await loadHistory(toRepoId(owner, repo)))?.report ?? null;

  // Reviewers: authors of the busiest changed code files. Optional: GitHub errors here don't stop the briefing.
  const busiest = prFiles
    .filter((f) => CODE_FILE.test(f.path) && f.status !== "added" && f.status !== "removed")
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
    .slice(0, MAX_REVIEWER_FILES);
  const authors = await Promise.all(busiest.map((f) => recentFileAuthors(owner, repo, f.previousPath ?? f.path).catch(() => [] as string[])));
  const reviewers = pickReviewers(authors, pr.author);
  const complexity = await measureChanges(owner, repo, pr, prFiles, graph, headFiles);

  return buildBriefing({ pr, prFiles, graph, graphFrom: from, history, reviewers, complexity, notes });
}
