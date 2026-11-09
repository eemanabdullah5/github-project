// F5 — Repo health report.
// Makes a one-page Markdown report about a repo that a CTO could read or forward:
//  - Facts (repo, commit, file count, languages): calculated directly, no AI.
//  - Overview, tech stack, structure, dependencies, risks, onboarding: written by the AI from the indexed code.
//  - Hotspots and knowledge risk: copied word for word from the F4 git history analysis, no AI.
//  - Code structure and architecture map: from the import graph (Phase 4), no AI. The map is a Mermaid
//    diagram, which the app draws and GitHub shows as a picture in the downloaded file.
// The report is saved in data/reports/, so opening it again is instant. "Regenerate" makes a new one.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildArchitecture, type ArchitectureMap } from "./architecture.js";
import { CHARS_PER_TOKEN, DATA_DIR, NUM_CTX } from "./config.js";
import { AppError } from "./errors.js";
import { loadHistory } from "./gitHistory.js";
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
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
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
    lines.push("**Riskiest files** (changes × complexity, top file = 100):", "");
    for (const f of top) lines.push(`- \`${f.path}\`: score ${f.score} (${plural(f.changes, "change")}, complexity ${f.complexity})`);
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
      (map.hotspotsAnalysed ? " Darker orange boxes contain riskier files (from the hotspots)." : "") +
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
  return lines.join("\n");
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
): { messages: ChatTurn[]; usedChunks: Chunk[] } {
  // The report rules, with this report's section headings filled in. Prompt text: prompts.ts
  const rules = reportPrompt(REPORT_SECTIONS.map((s) => s.heading));

  const repoContext =
    `Repository: ${manifest.repoId}\n\n` +
    `<<<REPO FILE TREE>>>\n${truncateTree(manifest.fileTree)}\n<<<END FILE TREE>>>\n\n` +
    `<<<REPO README>>>\n${truncateReadme(manifest.readme) || "(no README)"}\n<<<END README>>>`;

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

    // 2. One AI call writes all the AI sections at once.
    const { messages, usedChunks } = buildReportPrompt(manifest, mergeRoundRobin(lists));
    const aiSections = (await chat(messages)).trim();

    // 3. Put the report together: title, facts, the AI's sections, then the git history section.
    const history = (await loadHistory(repoId))?.report ?? null;
    // Phase 4: the import graph (built during indexing, or now for repos indexed before this feature).
    const [owner, name] = repoId.split("/");
    const graph = await getGraph(owner, name, repoId).catch(() => null);
    const markdown = [
      `# Health report: ${manifest.repoId}`,
      `_Generated ${new Date().toISOString().slice(0, 10)} by the GitHub Repository AI Assistant._`,
      factsSection(manifest),
      aiSections,
      structureSection(graph),
      architectureSection(graph && buildArchitecture(graph, history)),
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
      sources: toSources(usedChunks),
    };
    await mkdir(REPORTS_DIR, { recursive: true });
    await writeFile(reportPath(repoId), JSON.stringify(report, null, 2));
    return report;
  } finally {
    running.delete(repoId); // always unlock, even if something failed
  }
}
