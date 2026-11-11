// F4 — Git history hotspots.
// Reads the last 12 months of commits from the GitHub API (no git clone needed) and works out:
//  - Hotspots: files that change often AND are complex (most complex function, see complexity.ts).
//    A ranking of where to look first, not a measured bug risk.
//  - Co-change: pairs of files that keep being changed in the same commit (a hidden dependency).
//  - Knowledge risk: top-level folders that only one person has changed.
// People are stored only as scrambled codes (hashes), used to count them. No names or emails are saved.
// Results are saved in data/history/. The commits are saved too, so next time we only ask GitHub about new ones.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DATA_DIR,
  HISTORY_CONCURRENCY,
  HISTORY_MONTHS,
  MAX_COMMITS,
  MAX_FILES_PER_COMMIT,
  MIN_CO_CHANGES,
} from "./config.js";
import { estimateComplexity, measureComplexity } from "./complexity.js";
import { AppError } from "./errors.js";
import { downloadZipball, getCommitFiles, getLatestCommitSha, getRepo, listCommits, toRepoId } from "./githubClient.js";
import { checkRepoSize, extractSourceFiles } from "./ingestion.js";
import type { AreaStats, CoChangePair, CommitRecord, FileComplexity, HistoryReport, HotspotFile, SourceFile } from "./types.js";

const HISTORY_DIR = path.join(DATA_DIR, "history");

// How many files and file pairs the report lists at most.
const MAX_REPORT_FILES = 100;
const MAX_CO_CHANGE_PAIRS = 10;
// How many pairs are kept for hidden coupling (coupling.ts). More than the 10 shown, because the pairs that
// change together most often usually import each other, so the hidden ones can be further down the list.
const MAX_COUPLING_CANDIDATES = 200;

// What we save on disk for each repo: the commits (reused next time) and the latest report.
interface HistoryFile {
  commits: CommitRecord[];
  report: HistoryReport;
}

// Repos being analysed right now, so the same repo isn't analysed twice at the same time.
const running = new Set<string>();

// Where a repo's history is saved, e.g. data/history/octo__hello.json
function historyPath(repoId: string): string {
  return path.join(HISTORY_DIR, `${repoId.replace("/", "__")}.json`);
}

// Reads a repo's saved history, or returns null if it has never been analysed.
export async function loadHistory(repoId: string): Promise<HistoryFile | null> {
  try {
    return JSON.parse(await readFile(historyPath(repoId), "utf8")) as HistoryFile;
  } catch {
    return null;
  }
}

// Saves a repo's history to disk.
async function saveHistory(repoId: string, data: HistoryFile): Promise<void> {
  await mkdir(HISTORY_DIR, { recursive: true });
  await writeFile(historyPath(repoId), JSON.stringify(data));
}

// Turns a username or email into a short scrambled code. The same person always gets the same code,
// so we can count people, but the code can't be turned back into a name.
function hashAuthor(id: string): string {
  return createHash("sha1").update(id.toLowerCase()).digest("hex").slice(0, 12);
}

/** The name on a commit, tidied for comparing: "  Eeman  Abdullah " → "eeman abdullah". */
function normalName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Decides which commits were made by the same person, and returns an id per commit (sha → id).
 * One person often commits under several emails: a laptop where git was never told the email
 * makes one up from the computer's network address (e.g. "eeman@192.168.1.9"), and that address changes.
 * GitHub can't link those emails to an account, so counting by email would turn one person into several.
 * Rules, in order:
 *  1. Linked to a GitHub account → that account.
 *  2. Not linked, but the name matches exactly one linked account in this repo → that account.
 *  3. Not linked → the name, so one person on several computers still counts once.
 *  4. No name → the email.
 * Two different accounts with the same name stay separate (that's two real people), and their name isn't
 * used for rule 2 because it would be a guess. The ids are only ever stored scrambled (hashAuthor).
 */
export function personIds(commits: Array<{ sha: string; login: string; name: string; email: string }>): Map<string, string> {
  const accountsByName = new Map<string, Set<string>>();
  for (const c of commits) {
    if (!c.login || !normalName(c.name)) continue;
    const accounts = accountsByName.get(normalName(c.name)) ?? new Set<string>();
    accounts.add(c.login.toLowerCase());
    accountsByName.set(normalName(c.name), accounts);
  }
  const ids = new Map<string, string>();
  for (const c of commits) {
    const name = normalName(c.name);
    const accounts = accountsByName.get(name);
    let id: string;
    if (c.login) id = `account:${c.login.toLowerCase()}`;
    else if (name && accounts?.size === 1) id = `account:${[...accounts][0]}`;
    else if (name) id = `name:${name}`;
    else id = `email:${c.email.toLowerCase() || "unknown"}`;
    ids.set(c.sha, id);
  }
  return ids;
}

// Works out the whole report from the commits and the current files.
// It doesn't use the network or the disk, so it's easy to test.
//  - Only files that still exist are scored (deleted files can't be hotspots).
//  - Every commit counts for hotspots and people. Commits over MAX_FILES_PER_COMMIT files are
//    left out of "files that change together" only, because one big commit creates hundreds of fake pairs.
//  - complexity = the most complex function in the file (complexity.ts). `complexities` holds the parsed
//    results from analyzeHistory; files missing from it (e.g. in tests) use the old decision-word estimate.
//  - hotspot score = changes × complexity, scaled so the top hotspot is 100. It ranks where to look first;
//    it isn't a measured bug risk (that would need bug-fix history, which isn't used yet).
export function computeReport(
  commits: CommitRecord[],
  files: SourceFile[],
  meta: Pick<HistoryReport, "repoId" | "commitSha" | "since" | "skipped" | "reachedLimit">,
  complexities: Map<string, FileComplexity> = new Map(),
): HistoryReport {
  const current = new Map(files.map((f) => [f.path, f])); // path → file, for quick lookups
  // Commits small enough to use for "files that change together" (step 3).
  const smallCommits = commits.filter((c) => c.fileCount <= MAX_FILES_PER_COMMIT);

  // 1. For each file: how many commits changed it, lines added/deleted, who changed it, and when.
  const perFile = new Map<string, { changes: number; added: number; deleted: number; authors: Set<string>; last: string }>();
  for (const commit of commits) {
    for (const f of commit.files) {
      if (!current.has(f.path)) continue; // file was deleted since
      const entry = perFile.get(f.path) ?? { changes: 0, added: 0, deleted: 0, authors: new Set<string>(), last: "" };
      entry.changes++;
      entry.added += f.added;
      entry.deleted += f.deleted;
      entry.authors.add(commit.author);
      if (commit.date > entry.last) entry.last = commit.date;
      perFile.set(f.path, entry);
    }
  }

  // 2. Add size and complexity, then the score.
  const rows: HotspotFile[] = [...perFile].map(([filePath, e]) => {
    const file = current.get(filePath)!;
    const measured = complexities.get(filePath) ?? estimateComplexity(file);
    return {
      path: filePath,
      changes: e.changes,
      linesAdded: e.added,
      linesDeleted: e.deleted,
      authors: e.authors.size,
      lastChanged: e.last,
      lines: file.text.split("\n").length,
      complexity: measured.complexity,
      complexityMethod: measured.method,
      topFunction: measured.topFunction,
      score: 0,
    };
  });
  // Scale so the top file is 100. (Math.max(1, …) avoids dividing by zero when every score is 0.)
  const maxRaw = Math.max(1, ...rows.map((r) => r.changes * r.complexity));
  for (const r of rows) r.score = Math.round((100 * r.changes * r.complexity) / maxRaw);
  // Top hotspots first. Ties: more changes first, then by name.
  rows.sort((x, y) => y.score - x.score || y.changes - x.changes || x.path.localeCompare(y.path));

  // 3. Co-change: for every small commit, count each pair of files it changed together.
  const pairCounts = new Map<string, number>(); // "fileA\nfileB" → count
  for (const commit of smallCommits) {
    const paths = [...new Set(commit.files.map((f) => f.path).filter((p) => current.has(p)))].sort();
    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        const key = `${paths[i]}\n${paths[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const coChangeAll: CoChangePair[] = [...pairCounts]
    .filter(([, count]) => count >= MIN_CO_CHANGES) // only pairs that changed together often enough
    .map(([key, count]) => {
      const [a, b] = key.split("\n");
      // e.g. 7 joint changes when the less-changed file changed 10 times → 70%
      const fewer = Math.min(perFile.get(a)!.changes, perFile.get(b)!.changes);
      return { a, b, count, percent: Math.round((100 * count) / fewer) };
    })
    // Ties: by file names, so the list is the same every time.
    .sort((x, y) => y.count - x.count || y.percent - x.percent || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
    .slice(0, MAX_COUPLING_CANDIDATES);
  const coChange = coChangeAll.slice(0, MAX_CO_CHANGE_PAIRS);

  // 4. Knowledge risk: group files by their top-level folder and count the people per folder.
  const perArea = new Map<string, { commits: Set<string>; authors: Set<string>; files: Set<string> }>();
  for (const commit of commits) {
    for (const f of commit.files) {
      if (!current.has(f.path)) continue;
      // "src/auth/login.ts" → "src". Files at the top level are grouped as "(root files)".
      const area = f.path.includes("/") ? f.path.split("/")[0] : "(root files)";
      const entry = perArea.get(area) ?? { commits: new Set(), authors: new Set(), files: new Set() };
      entry.commits.add(commit.sha);
      entry.authors.add(commit.author);
      entry.files.add(f.path);
      perArea.set(area, entry);
    }
  }
  const areas: AreaStats[] = [...perArea]
    .map(([area, e]) => ({
      area,
      commits: e.commits.size,
      authors: e.authors.size,
      files: e.files.size,
      // Only flagged with at least 3 commits, so a folder touched once isn't called a "risk".
      singleContributor: e.authors.size === 1 && e.commits.size >= 3,
    }))
    .sort((x, y) => y.commits - x.commits);

  return {
    ...meta,
    generatedAt: new Date().toISOString(),
    commitsAnalyzed: commits.length,
    skipped: { ...meta.skipped, large: commits.length - smallCommits.length }, // left out of co-change only
    filesChanged: rows.length, // the real total, before cutting the list to the top 100
    files: rows.slice(0, MAX_REPORT_FILES),
    coChange,
    coChangeAll,
    areas,
  };
}

// Runs the whole analysis for a repo and saves it. Called when the user clicks "Analyse history".
// Steps: download the current code (for complexity) → list commits → fetch each new commit's files
// → measure complexity of the changed files → work out the report → save. Throws an AppError the user can read if GitHub fails (e.g. rate limit).
export async function analyzeHistory(owner: string, repo: string): Promise<HistoryReport> {
  const repoId = toRepoId(owner, repo);
  if (running.has(repoId)) throw new AppError("This repo's history is already being analysed. Please wait.", 409);
  running.add(repoId);
  try {
    // 1. The current code, to measure complexity. Same download and filters as indexing,
    //    so secret files are skipped and keys are masked here too.
    const info = await getRepo(owner, repo);
    if (info.sizeKb === 0) throw new AppError("This repo is empty, so it has no history to analyse.", 400);
    checkRepoSize(info);
    const commitSha = await getLatestCommitSha(owner, repo, info.defaultBranch);
    const files = extractSourceFiles(await downloadZipball(owner, repo, commitSha));

    // 2. List the last 12 months of commits. We ask for 1 more than the limit, to know if there were more.
    const sinceDate = new Date();
    sinceDate.setMonth(sinceDate.getMonth() - HISTORY_MONTHS);
    const since = sinceDate.toISOString();
    const summaries = await listCommits(owner, repo, info.defaultBranch, since, MAX_COMMITS + 1);
    const reachedLimit = summaries.length > MAX_COMMITS;
    const listed = summaries.slice(0, MAX_COMMITS);

    // 3. Skip merge commits and bots.
    const merges = listed.filter((c) => c.isMerge).length;
    const bots = listed.filter((c) => !c.isMerge && c.isBot).length;
    const wanted = listed.filter((c) => !c.isMerge && !c.isBot);

    // 4. Reuse commits saved last time. Only ask GitHub about new ones, 5 at a time.
    const saved = await loadHistory(repoId);
    const known = new Map((saved?.commits ?? []).map((c) => [c.sha, c]));
    const missing = wanted.filter((c) => !known.has(c.sha));
    for (let i = 0; i < missing.length; i += HISTORY_CONCURRENCY) {
      const batch = missing.slice(i, i + HISTORY_CONCURRENCY);
      const records = await Promise.all(
        batch.map(async (c): Promise<CommitRecord> => {
          const changed = await getCommitFiles(owner, repo, c.sha);
          return {
            sha: c.sha,
            author: "", // set below, once we know which commits belong to the same person
            date: c.date,
            fileCount: changed.length,
            // Files that were only renamed or moved (no lines changed) don't count as work on that file.
            files: changed
              .filter((f) => !(f.status === "renamed" && f.added === 0 && f.deleted === 0))
              .map(({ path: filePath, added, deleted }) => ({ path: filePath, added, deleted })),
          };
        }),
      );
      for (const r of records) known.set(r.sha, r);
    }

    // 5. Work out who is the same person (see personIds), for new and saved commits alike, so commits
    //    saved by an older version are counted the same way. Stored scrambled, never the real name.
    const people = personIds(wanted);
    const commits = wanted.map((c) => ({ ...known.get(c.sha)!, author: hashAuthor(people.get(c.sha)!) }));

    // 6. Measure complexity (most complex function) for the files that changed. Parsing is done here,
    //    not in computeReport, so computeReport stays simple and doesn't need tree-sitter.
    const changedPaths = new Set(commits.flatMap((c) => c.files.map((f) => f.path)));
    const complexities = new Map<string, FileComplexity>();
    for (const file of files) {
      if (changedPaths.has(file.path)) complexities.set(file.path, await measureComplexity(file));
    }

    // 7. Work out the report and save it with the commits.
    const report = computeReport(
      commits,
      files,
      { repoId, commitSha, since, skipped: { merges, bots, large: 0 }, reachedLimit },
      complexities,
    );
    await saveHistory(repoId, { commits, report });
    return report;
  } finally {
    running.delete(repoId); // always unlock, even if something failed
  }
}
