// F5 — Repo health report.
// Makes a one-page Markdown report about a repo that a CTO could read or forward:
//  - Facts (repo, commit, file count, languages): calculated directly, no AI.
//  - Overview, tech stack, structure, dependencies, risks, onboarding: written by the AI from the indexed code.
//    If the git history has been analysed, the AI also gets a short hotspot summary to use in the risks.
//  - Hotspots and knowledge risk: copied word for word from the F4 git history analysis, no AI.
//  - Code structure and architecture map: from the import graph (Phase 4), no AI. The map is a Mermaid
//    diagram, which the app draws and GitHub shows as a picture in the downloaded file.
//  - Most connected code: from the call graph (Phase 4), no AI. The functions a change would spread furthest
//    from, and whether any test reaches them (change impact, impact.ts).
//  - Dependencies: the exact libraries and versions from the dependency files (dependencies.ts), no AI.
//    The AI also gets this list, so its "Tech stack" and "Dependencies" text matches it.
// The report is saved in data/reports/, so opening it again is instant. "Regenerate" makes a new one.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildArchitecture, type ArchitectureMap } from "./architecture.js";
import { getCallGraph, listFunctions, type CallFunction, type CallGraph } from "./callGraph.js";
import { CHARS_PER_TOKEN, DATA_DIR, NUM_CTX } from "./config.js";
import { getDependencies, isUnpinned, type Dependency, type DependencyScan, type Ecosystem } from "./dependencies.js";
import { AppError } from "./errors.js";
import { loadHistory } from "./gitHistory.js";
import { changeImpact, type ChangeImpact } from "./impact.js";
import { getGraph, summarizeGraph } from "./importGraph.js";
import { detectLanguage } from "./ingestion.js";
import { chat, embedQuery, type ChatTurn } from "./llm.js";
import { reportPrompt } from "./prompts.js";
import { formatChunk, toSources, truncateReadme, truncateTree } from "./rag.js";
import type { Chunk, HistoryReport, ImportGraph, Manifest, Source } from "./types.js";
import { loadManifest, query } from "./vectorStore.js";

const REPORTS_DIR = path.join(DATA_DIR, "reports");

// The sections the AI writes, and the search question used to find the right code for each one.
export const REPORT_SECTIONS: Array<{ heading: string; search: string }> = [
  { heading: "Overview", search: "What is this project and what does it do?" },
  { heading: "Tech stack", search: "Which programming languages, frameworks and libraries does it use?" },
  { heading: "Structure", search: "How is the code organised: main modules, entry points and how they connect?" },
  { heading: "Dependencies and external services", search: "Which external services, APIs, databases and third-party packages does it depend on?" },
  { heading: "Risks and tech debt", search: "Where are error handling, security, missing tests, TODOs or complicated code?" },
  { heading: "Onboarding notes", search: "Where should a new developer start: setup, configuration, entry points and tests?" },
];

// How many chunks we fetch for each section, and how much room we leave for the AI's answer.
const CHUNKS_PER_SECTION = 4;
const ANSWER_RESERVE_TOKENS = 3000;

// What we save for each repo, and what the browser receives.
export interface HealthReport {
  repoId: string;
  commitSha: string; // the indexed commit the report describes (used for GitHub links)
  generatedAt: string;
  markdown: string; // the full report
  sources: Source[]; // the code chunks the AI was given, so citations can become links (F1)
}

// Repos whose report is being generated right now, so the same one isn't started twice.
const running = new Set<string>();

// Where a repo's report is saved, e.g. data/reports/octo__hello.json
function reportPath(repoId: string): string {
  return path.join(REPORTS_DIR, `${repoId.replace("/", "__")}.json`);
}

// Reads a repo's saved report, or returns null if there isn't one yet.
export async function loadReport(repoId: string): Promise<HealthReport | null> {
  try {
    return JSON.parse(await readFile(reportPath(repoId), "utf8")) as HealthReport;
  } catch {
    return null;
  }
}

// Counts files per language from the file list, e.g. [{ language: "python", files: 31, percent: 62 }, …].
// Only code languages are counted (docs, config and plain text are left out). Small ones are grouped as "other".
export function languageBreakdown(fileTree: string): Array<{ language: string; files: number; percent: number }> {
  const skip = new Set(["text", "markdown", "rst", "json", "yaml", "toml", "xml"]);
  const counts = new Map<string, number>();
  for (const filePath of fileTree.split("\n").filter(Boolean)) {
    const language = detectLanguage(filePath);
    if (!skip.has(language)) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return [];

  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 5); // the 5 biggest languages by name…
  const otherFiles = sorted.slice(5).reduce((n, [, files]) => n + files, 0); // …the rest together as "other"
  const rows = top.map(([language, files]) => ({ language, files }));
  if (otherFiles > 0) rows.push({ language: "other", files: otherFiles });
  return rows.map((r) => ({ ...r, percent: Math.round((100 * r.files) / total) }));
}

// The "Facts" section at the top of the report. Calculated directly, so it's always exact.
export function factsSection(manifest: Manifest): string {
  const languages = languageBreakdown(manifest.fileTree);
  const languageText = languages.length
    ? languages.map((l) => `${l.language} ${l.percent}%`).join(", ")
    : "no code files detected";
  return [
    "## Facts",
    "",
    `- **Repository:** ${manifest.repoId}`,
    `- **Version:** commit \`${manifest.commitSha.slice(0, 7)}\` on \`${manifest.branch}\` (indexed ${manifest.indexedAt.slice(0, 10)})`,
    `- **Size:** ${manifest.fileCount} files indexed`,
    `- **Languages (by number of code files):** ${languageText}`,
  ].join("\n");
}

// Writes a number with the right word form: plural(1, "change") → "1 change", plural(3, "change") → "3 changes".
// Irregular words pass their plural: plural(2, "library", "libraries") → "2 libraries".
function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

// The "Hotspots and knowledge risk" section, copied from the F4 analysis (no AI, so the numbers are exact).
// If the history hasn't been analysed yet, it says how to do that.
export function hotspotsSection(history: HistoryReport | null): string {
  const lines = ["## Hotspots and knowledge risk (from git history)", ""];
  if (!history) {
    lines.push("_Not analysed yet. Open the **Hotspots** tab, click **Analyse history**, then regenerate this report._");
    return lines.join("\n");
  }
  lines.push(`Based on ${plural(history.commitsAnalyzed, "commit")} in the last 12 months (analysed ${history.generatedAt.slice(0, 10)}).`, "");

  const top = history.files.filter((f) => f.score > 0).slice(0, 5);
  if (top.length) {
    lines.push("**Top hotspots** (changes × complexity of the most complex function, top file = 100; where to look first, not a measured bug risk):", "");
    for (const f of top) {
      const where = f.topFunction ? `, in \`${f.topFunction.name}\`` : "";
      lines.push(`- \`${f.path}\`: score ${f.score} (${plural(f.changes, "change")}, complexity ${f.complexity}${where})`);
    }
    lines.push("");
  }

  const pair = history.coChange[0];
  if (pair) lines.push(`**Most linked files:** \`${pair.a}\` and \`${pair.b}\` changed together ${plural(pair.count, "time")}.`, "");

  const oneOwner = history.areas.filter((a) => a.singleContributor).map((a) => `\`${a.area}\``);
  lines.push(
    oneOwner.length
      ? `**Knowledge risk:** only one person has changed ${oneOwner.join(", ")}.`
      : "**Knowledge risk:** no area depends on a single person.",
  );
  return lines.join("\n");
}

// A short git history summary for the AI, so "Risks and tech debt" can mention hotspots (a few hundred tokens).
// Empty when the history hasn't been analysed or has no hotspots worth mentioning.
export function historySummaryForAI(history: HistoryReport | null): string {
  if (!history) return "";
  const lines: string[] = [];

  const top = history.files.filter((f) => f.score > 0).slice(0, 5);
  if (top.length) {
    lines.push("Files that change most, weighted by complexity (hotspot score 0-100, top = 100):");
    for (const f of top) {
      const where = f.topFunction ? ` (most complex function: ${f.topFunction.name})` : "";
      lines.push(`- ${f.path}: score ${f.score}, ${plural(f.changes, "change")}, ${plural(f.authors, "author")}, complexity ${f.complexity}${where}`);
    }
  }

  const pairs = history.coChange.slice(0, 3);
  if (pairs.length) {
    lines.push("Files that often change together:");
    for (const p of pairs) lines.push(`- ${p.a} and ${p.b}: ${plural(p.count, "time")} (${p.percent}%)`);
  }

  const oneOwner = history.areas.filter((a) => a.singleContributor).map((a) => a.area);
  if (oneOwner.length) lines.push(`Areas only one person has changed: ${oneOwner.join(", ")}`);

  if (!lines.length) return "";
  return (
    `<<<REPO GIT HISTORY SUMMARY (${plural(history.commitsAnalyzed, "commit")}, last 12 months)>>>\n` +
    `${lines.join("\n")}\n<<<END GIT HISTORY SUMMARY>>>`
  );
}

// The "Code structure" section, from the import graph (no AI, so the numbers are exact).
// If the graph couldn't be built, it says so instead of failing the whole report.
export function structureSection(graph: ImportGraph | null): string {
  const lines = ["## Code structure (from imports)", ""];
  if (!graph) {
    lines.push("_The import graph couldn't be built for this repo, so this section is missing. Try regenerating the report._");
    return lines.join("\n");
  }
  if (graph.files.length === 0) {
    lines.push("_No Python, JavaScript or TypeScript files, so there's no import graph yet (other languages come later)._");
    return lines.join("\n");
  }
  const summary = summarizeGraph(graph, 5);
  const coverage = summary.coverage === null ? "" : ` ${Math.round(summary.coverage * 100)}% of imports between repo files could be followed.`;
  lines.push(`Read ${plural(graph.files.length, "code file")} with ${plural(graph.edges.length, "import link")} between them.${coverage}`, "");

  if (summary.mostImported.length) {
    lines.push("**Most depended-on files** (changing these affects the most other files):", "");
    for (const f of summary.mostImported) lines.push(`- \`${f.path}\`: imported by ${plural(f.importedBy, "file")}`);
    lines.push("");
  }
  if (graph.external.length) {
    const shown = graph.external.slice(0, 10).map((p) => `\`${p.name}\` (${plural(p.files.length, "file")})`);
    const more = graph.external.length > 10 ? `, and ${graph.external.length - 10} more` : "";
    lines.push(`**Outside packages used:** ${shown.join(", ")}${more}.`, "");
  }
  if (summary.notImported.length) {
    const shown = summary.notImported.slice(0, 5).map((f) => `\`${f}\``).join(", ");
    const more = summary.notImported.length > 5 ? `, and ${summary.notImported.length - 5} more` : "";
    lines.push(`**Not imported by any other file** (entry points, scripts, tests or unused code): ${shown}${more}.`);
  }
  return lines.join("\n").trimEnd();
}

// The "Architecture map" section: the module diagram as a Mermaid block, plus any cycles (no AI).
// Empty when there's no graph or no supported code (structureSection already explains why).
export function architectureSection(map: ArchitectureMap | null): string {
  if (!map || map.modules.length === 0) return "";
  const lines = [
    "## Architecture map",
    "",
    "Each box is a folder of code. An arrow points from the folder that imports to the folder it uses; the number is how many imports it stands for." +
      (map.hotspotsAnalysed ? " Darker orange boxes contain files with higher hotspot scores (from the hotspots)." : "") +
      (map.cycles.length ? " Red arrows are part of a cycle." : ""),
    "",
    "```mermaid",
    map.mermaid,
    "```",
  ];
  if (map.cycles.length || map.fileCycles.length) {
    lines.push("", "**Cycles** (code that depends on itself in a loop is harder to change and test):", "");
    for (const group of map.cycles) lines.push(`- Folders: ${group.map((m) => `\`${m}\``).join(" ⇄ ")}`);
    for (const group of map.fileCycles) lines.push(`- Files: ${group.map((f) => `\`${f}\``).join(" ⇄ ")}`);
  } else {
    lines.push("", "No cycles: dependencies between folders all go one way.");
  }
  lines.push(...hiddenCouplingLines(map));
  return lines.join("\n");
}

// The "Hidden coupling" part of the architecture section: files that change together without importing each other.
// Nothing is written if the history wasn't analysed or no code files change together often enough.
export function hiddenCouplingLines(map: ArchitectureMap): string[] {
  const hc = map.hiddenCoupling;
  if (!hc || hc.pairsChecked === 0) return [];
  const lines = ["", "**Hidden coupling** (code files that keep changing together but don't import each other):", ""];
  if (hc.pairs.length === 0) {
    lines.push(`None: all ${plural(hc.pairsChecked, "pair")} of code files that often change together are linked by an import.`);
  }
  for (const p of hc.pairs) {
    const how = p.link === "none" ? "no import link at all" : `linked only through ${p.via.slice(1, -1).map((f) => `\`${f}\``).join(" → ")}`;
    lines.push(`- \`${p.a}\` and \`${p.b}\`: changed together ${plural(p.count, "time")} (${p.percent}%), ${how}`);
  }
  if (hc.partial) lines.push("", "_Only the top pairs were checked. Run Analyse history again to check them all._");
  return lines;
}

// ---------- Most connected code (from the call graph, no AI) ----------

/** Functions checked for reach (the most-called ones), and how many are shown. */
const CALL_CANDIDATES = 30;
const CALL_ROWS = 5;

/** One row of the "Most connected code" section. */
export interface ConnectedFunction {
  fn: CallFunction;
  directCallers: number; // functions that call it directly
  impact: ChangeImpact["totals"];
}

/**
 * The functions whose change would reach the most other code, with the tests that reach them.
 * Only real code (no tests, no top-level script code). Ranked by how many functions a change reaches.
 */
export function mostConnected(graph: CallGraph, history: HistoryReport | null = null): ConnectedFunction[] {
  return listFunctions(graph)
    .filter((f) => !f.isTest && f.kind !== "top-level" && f.callers > 0)
    .slice(0, CALL_CANDIDATES)
    .map((f) => ({ fn: f as CallFunction, directCallers: f.callers, impact: changeImpact(graph, f.id, history).totals }))
    .sort((a, b) => b.impact.affected - a.impact.affected || b.directCallers - a.directCallers || a.fn.id.localeCompare(b.fn.id))
    .slice(0, CALL_ROWS);
}

/**
 * The "Most connected code" section: the functions a change would spread furthest from, and whether tests reach them.
 * Returns the text and the function locations, so their citations become links (and count as verified).
 */
export function callGraphSection(graph: CallGraph | null, history: HistoryReport | null = null): { text: string; sources: Source[] } {
  const lines = ["## Most connected code (from the call graph)", ""];
  const done = (sources: Source[] = []) => ({ text: lines.join("\n").trimEnd(), sources });
  if (!graph) {
    lines.push("_The call graph couldn't be built for this repo, so this section is missing. Try regenerating the report._");
    return done();
  }
  if (graph.functions.length === 0) {
    lines.push("_No Python, JavaScript or TypeScript functions found, so there's no call graph yet (other languages come later)._");
    return done();
  }
  const rows = mostConnected(graph, history);
  lines.push(`Read ${plural(graph.functions.length, "function")} and ${plural(graph.edges.length, "link")} between them (one function calling another).`, "");
  if (rows.length === 0) {
    lines.push("No function is called by other code in the repo, so there's nothing to rank.");
    return done();
  }

  lines.push(
    "**Functions a change would spread furthest from** (\"reaches\" = every function that calls it, directly or through others):",
    "",
  );
  // A numbered list, not a table: it reads well in the app, the downloaded file and on GitHub.
  const sources: Source[] = [];
  rows.forEach(({ fn, directCallers, impact }, i) => {
    sources.push({ path: fn.file, startLine: fn.line, endLine: fn.endLine, symbol: fn.qualified });
    const possible = impact.affected - impact.certain;
    const hotspots = impact.hotspotFiles ? `, ${plural(impact.hotspotFiles, "hotspot")}` : "";
    const tests = impact.tests ? `${plural(impact.tests, "test")} ${impact.tests === 1 ? "reaches" : "reach"} it` : "⚠ **no test reaches it**";
    lines.push(
      `${i + 1}. **\`${fn.qualified}\`** [${fn.file}:L${fn.line}-L${fn.endLine}]  `,
      `   Called directly by ${plural(directCallers, "function")} · a change reaches ${plural(impact.affected, "function")}` +
        `${possible ? ` (${possible} possible)` : ""} in ${plural(impact.files, "file")}${hotspots} · ${tests}`,
    );
  });

  const untested = rows.filter((r) => r.impact.tests === 0);
  lines.push("");
  if (untested.length) {
    const names = untested.map((r) => `\`${r.fn.qualified}\``).join(", ");
    const worst = Math.max(...untested.map((r) => r.impact.affected));
    lines.push(
      `⚠ **${untested.length} of these ${plural(rows.length, "function")} ${untested.length === 1 ? "isn't" : "aren't"} reached by any test:** ${names}. ` +
        `A mistake there could break up to ${plural(worst, "function")} without any test failing. These are good first places to add tests.`,
    );
  } else {
    lines.push("Every function listed is reached by at least one test.");
  }
  lines.push(
    "",
    "_From parsing the code, not running it. \"Possible\" calls were matched by method name only, and calls made in unusual ways can be missed. Open the **Calls** tab for the full picture of any function._",
  );
  return done(sources);
}

// ---------- Dependencies (from dependencies.ts, no AI) ----------

/** Display names for each kind of dependency file. */
const ECOSYSTEM_NAMES: Record<Ecosystem, string> = {
  npm: "JavaScript / TypeScript (npm)",
  pip: "Python (pip)",
  go: "Go",
  maven: "Java (Maven)",
};
/** Most rows shown per language. Why: a huge list buries the important ones; the rest are counted. */
const MAX_DEP_ROWS = 40;

/** One library across all files: e.g. "react" declared in two package.json files counts once. */
export interface LibraryRow {
  name: string;
  ecosystem: Ecosystem;
  versions: string[]; // every version written, e.g. ["^19.0.0"], or two if files disagree
  kind: Dependency["kind"]; // "runtime" if any file needs it to run
  files: string[];
  unpinned: boolean; // no version anywhere, so installs can change
}

/** Groups the scan into one row per library. Runtime libraries first, then by name. */
export function libraryRows(scan: DependencyScan): LibraryRow[] {
  const rank: Record<Dependency["kind"], number> = { runtime: 0, optional: 1, indirect: 2, dev: 3 };
  const rows = new Map<string, LibraryRow>();
  for (const dep of scan.dependencies) {
    const key = `${dep.ecosystem}:${dep.name.toLowerCase()}`;
    const row = rows.get(key) ?? { name: dep.name, ecosystem: dep.ecosystem, versions: [], kind: dep.kind, files: [], unpinned: true };
    if (dep.version && !row.versions.includes(dep.version)) row.versions.push(dep.version);
    if (!row.files.includes(dep.file)) row.files.push(dep.file);
    if (rank[dep.kind] < rank[row.kind]) row.kind = dep.kind;
    row.unpinned &&= isUnpinned(dep);
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
}

/** Text for a Markdown table cell. Why: a "|" would end the cell early, so it's escaped. */
const cell = (text: string) => text.replace(/\|/g, "\\|");

/**
 * The "Dependencies" section: every library with its version, grouped by language, plus a warning
 * for libraries with no version. Says so plainly if there are no dependency files or the scan failed.
 */
export function dependenciesSection(scan: DependencyScan | null): string {
  const lines = ["## Dependencies (from the dependency files)", ""];
  if (!scan) {
    lines.push("_The dependency files couldn't be read for this repo, so this section is missing. Try regenerating the report._");
    return lines.join("\n");
  }
  if (scan.files.length === 0) {
    lines.push("_No dependency files found (package.json, requirements.txt, pyproject.toml, go.mod or pom.xml)._");
    return lines.join("\n");
  }

  const rows = libraryRows(scan);
  const toRun = rows.filter((r) => r.kind !== "dev").length;
  const readFiles = scan.files.filter((f) => !f.error).map((f) => `\`${f.path}\` (${f.count})`);
  if (readFiles.length) lines.push(`Read ${plural(readFiles.length, "dependency file")}: ${readFiles.join(", ")}.`, "");
  lines.push(`**${plural(rows.length, "library", "libraries")}**: ${toRun} needed to run the app, ${rows.length - toRun} only for development and tests.`);

  const unpinned = rows.filter((r) => r.unpinned);
  if (unpinned.length) {
    const names = unpinned.slice(0, 10).map((r) => `\`${r.name}\``).join(", ");
    const more = unpinned.length > 10 ? `, and ${unpinned.length - 10} more` : "";
    const what = unpinned.length === 1 ? "1 library has" : `${unpinned.length} libraries have`;
    lines.push("", `⚠ **${what} no version**, so a fresh install can get a different version and behave differently: ${names}${more}.`);
  }
  for (const f of scan.files.filter((f) => f.error)) lines.push("", `⚠ Couldn't read \`${f.path}\`: ${f.error}`);

  for (const ecosystem of Object.keys(ECOSYSTEM_NAMES) as Ecosystem[]) {
    const group = rows.filter((r) => r.ecosystem === ecosystem);
    if (!group.length) continue;
    lines.push("", `### ${ECOSYSTEM_NAMES[ecosystem]}`, "", "| Library | Version | Type | Declared in |", "|---|---|---|---|");
    for (const r of group.slice(0, MAX_DEP_ROWS)) {
      const version = r.versions.length ? r.versions.map((v) => `\`${cell(v)}\``).join(", ") : "_none_";
      const type = r.kind === "dev" ? "dev only" : r.kind;
      lines.push(`| ${cell(r.name)} | ${version} | ${type} | ${r.files.map((f) => `\`${f}\``).join(", ")} |`);
    }
    if (group.length > MAX_DEP_ROWS) lines.push("", `_…and ${group.length - MAX_DEP_ROWS} more._`);
  }
  return lines.join("\n");
}

/**
 * Removes made-up "Dependency files" citations from the AI's text: "[a.ts:L1-L2, Dependency files]" → "[a.ts:L1-L2]",
 * and "[Dependency files]" disappears. Why: the AI sometimes cites the dependency list even when told not to,
 * and it isn't a file with lines, so it would show as stray text.
 */
export function removeDependencyCitations(text: string): string {
  return text.replace(/\s?\[([^\]]*)\]/g, (whole, inside: string) => {
    const parts = inside.split(",").map((p) => p.trim());
    const kept = parts.filter((p) => !/^dependency files?$/i.test(p));
    if (kept.length === parts.length) return whole; // nothing to remove: leave it exactly as it was
    return kept.length ? `${whole.startsWith(" ") ? " " : ""}[${kept.join(", ")}]` : "";
  });
}

/** Most libraries listed for the AI. Why: keeps the prompt small; the full list is in the report anyway. */
const MAX_DEPS_FOR_AI = 120;

/** A short version of the dependency list for the AI. Empty if there's nothing to tell it. */
export function dependencySummaryForAI(scan: DependencyScan | null): string {
  if (!scan || scan.dependencies.length === 0) return "";
  const rows = libraryRows(scan).slice(0, MAX_DEPS_FOR_AI);
  const lines: string[] = [];
  for (const ecosystem of Object.keys(ECOSYSTEM_NAMES) as Ecosystem[]) {
    const group = rows.filter((r) => r.ecosystem === ecosystem);
    if (!group.length) continue;
    const files = [...new Set(group.flatMap((r) => r.files))].join(", ");
    const list = (dev: boolean) =>
      group
        .filter((r) => (r.kind === "dev") === dev)
        .map((r) => `${r.name} ${r.versions.join(" / ") || "(no version)"}`)
        .join(", ");
    lines.push(`${ECOSYSTEM_NAMES[ecosystem]} (from ${files}):`);
    if (list(false)) lines.push(`  needed to run: ${list(false)}`);
    if (list(true)) lines.push(`  development only: ${list(true)}`);
  }
  return `<<<REPO DEPENDENCY FILES (exact)>>>\n${lines.join("\n")}\n<<<END DEPENDENCY FILES>>>`;
}

// Merges the search results of all sections fairly: first every section's best chunk, then every
// section's second best, and so on. Repeats are skipped. So if the list must be cut, each section keeps its best code.
export function mergeRoundRobin(lists: Chunk[][]): Chunk[] {
  const seen = new Set<string>();
  const merged: Chunk[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let rank = 0; rank < longest; rank++) {
    for (const list of lists) {
      const chunk = list[rank];
      if (chunk && !seen.has(chunk.id)) {
        seen.add(chunk.id);
        merged.push(chunk);
      }
    }
  }
  return merged;
}

// Builds the messages sent to the AI for the report. No network, so it's easy to test.
// Chunks are added in order until the prompt would be too big; the rest are dropped.
export function buildReportPrompt(
  manifest: Pick<Manifest, "repoId" | "fileTree" | "readme">,
  chunks: Chunk[],
  history: HistoryReport | null = null,
  deps: DependencyScan | null = null,
): { messages: ChatTurn[]; usedChunks: Chunk[] } {
  // F4 hotspots, if analysed, and the exact dependency list. Counted in the budget below before the chunks.
  const historyText = historySummaryForAI(history);
  const depsText = dependencySummaryForAI(deps);

  // The report rules, with this report's section headings filled in. Prompt text: prompts.ts
  const rules = reportPrompt(
    REPORT_SECTIONS.map((s) => s.heading),
    Boolean(historyText),
    Boolean(depsText),
  );

  const repoContext =
    `Repository: ${manifest.repoId}\n\n` +
    `<<<REPO FILE TREE>>>\n${truncateTree(manifest.fileTree)}\n<<<END FILE TREE>>>\n\n` +
    `<<<REPO README>>>\n${truncateReadme(manifest.readme) || "(no README)"}\n<<<END README>>>` +
    (historyText ? `\n\nGit history summary:\n${historyText}` : "") +
    (depsText ? `\n\nDependency files:\n${depsText}` : "");

  // Keep adding chunks while they fit in the model's context window.
  const tokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);
  const budget = NUM_CTX - ANSWER_RESERVE_TOKENS;
  let used = tokens(rules + repoContext);
  const usedChunks: Chunk[] = [];
  for (const chunk of chunks) {
    const cost = tokens(formatChunk(chunk, usedChunks.length + 1));
    if (used + cost > budget) break;
    usedChunks.push(chunk);
    used += cost;
  }

  const chunkText = usedChunks.map((c, i) => formatChunk(c, i + 1)).join("\n\n") || "(no code chunks)";
  return {
    messages: [
      { role: "system", content: `${rules}\n\n${repoContext}\n\nCode chunks:\n\n${chunkText}` },
      { role: "user", content: "Write the health report." },
    ],
    usedChunks,
  };
}

// Generates a new report for an indexed repo and saves it. Called by the "Generate" button.
// Steps: search the index once per section → merge the results → one AI call → add the facts
// and the F4 section → save.
export async function generateReport(repoId: string): Promise<HealthReport> {
  const manifest = await loadManifest(repoId);
  if (!manifest) throw new AppError("This repo hasn't been indexed yet. Index it first.", 404);
  if (running.has(repoId)) throw new AppError("A report for this repo is already being generated. Please wait.", 409);
  running.add(repoId);
  try {
    // 1. Find the best code for each section (one small search per section).
    const lists: Chunk[][] = [];
    for (const section of REPORT_SECTIONS) {
      lists.push(await query(repoId, await embedQuery(section.search), CHUNKS_PER_SECTION));
    }

    // 2. One AI call writes all the AI sections at once. It also gets the hotspot summary (if analysed),
    //    so the risks section can mention files that change often.
    const history = (await loadHistory(repoId))?.report ?? null;
    // The exact dependency list (saved at indexing, or scanned now for older repos). Optional: the report works without it.
    const [owner, name] = repoId.split("/");
    const deps = await getDependencies(owner, name, repoId).catch(() => null);
    const { messages, usedChunks } = buildReportPrompt(manifest, mergeRoundRobin(lists), history, deps);
    const aiSections = removeDependencyCitations((await chat(messages)).trim());

    // 3. Put the report together: title, facts, the AI's sections, then the git history section.
    // Phase 4: the import graph (built during indexing, or now for repos indexed before this feature).
    const graph = await getGraph(owner, name, repoId).catch(() => null);
    // Call graph: built during indexing, or now for older repos. Optional: the report works without it.
    const calls = callGraphSection(await getCallGraph(owner, name, repoId).catch(() => null), history);
    const markdown = [
      `# Health report: ${manifest.repoId}`,
      `_Generated ${new Date().toISOString().slice(0, 10)} by the GitHub Repository AI Assistant._`,
      factsSection(manifest),
      aiSections,
      dependenciesSection(deps),
      structureSection(graph),
      architectureSection(graph && buildArchitecture(graph, history)),
      calls.text,
      hotspotsSection(history),
    ]
      .filter(Boolean) // the architecture section is empty when there's nothing to draw
      .join("\n\n");

    // 4. Save it, so it opens instantly next time.
    const report: HealthReport = {
      repoId,
      commitSha: manifest.commitSha,
      generatedAt: new Date().toISOString(),
      markdown,
      sources: [...toSources(usedChunks), ...calls.sources], // function locations too, so their citations are links
    };
    await mkdir(REPORTS_DIR, { recursive: true });
    await writeFile(reportPath(repoId), JSON.stringify(report, null, 2));
    return report;
  } finally {
    running.delete(repoId); // always unlock, even if something failed
  }
}
