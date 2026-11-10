// Architecture map (Phase 4): a diagram of a repo's modules and how they depend on each other.
// Built from the import graph (importGraph.ts), with no AI:
//  1. Files are grouped into modules by folder. The folder depth is picked automatically so the
//     diagram has at most MAX_MODULES boxes (e.g. "server/src/chunking", not just "server").
//  2. Imports between files are added up into arrows between modules ("server/src → 12 → server/src/chunking").
//  3. Cycles are found: modules (or files) that depend on each other in a loop, a common design problem.
//  4. If the git history was analysed (F4), each module is coloured by its top hotspot's score.
//  5. The result is also written as a Mermaid diagram, which the web app draws and GitHub shows in Markdown.
import path from "node:path";
import type { HistoryReport, ImportEdge, ImportGraph } from "./types.js";

/** Most boxes the diagram shows. More than this gets hard to read, so folders are grouped less deeply. */
export const MAX_MODULES = 20;
/** How many example imports are kept for each arrow, to show why two modules are linked. */
const EXAMPLES_PER_LINK = 3;
/** Most file-level cycles listed. */
const MAX_FILE_CYCLES = 10;

export interface ArchModule {
  id: string; // short id used in the diagram, e.g. "m3"
  name: string; // the folder, e.g. "server/src/chunking", or "(root)" for files at the top of the repo
  files: string[];
  uses: number; // how many other modules it imports from
  usedBy: number; // how many other modules import from it
  hotspot: { score: number; file: string } | null; // its top hotspot file from F4, if the history was analysed
  inCycle: boolean;
}

export interface ArchLink {
  from: string; // module name
  to: string;
  count: number; // how many file-to-file imports this arrow stands for
  examples: ImportEdge[]; // a few of them, to show why the modules are linked
  inCycle: boolean; // part of a loop between modules
}

export interface ArchitectureMap {
  repoId: string;
  commitSha: string;
  depth: number; // folder depth used to group files into modules
  modules: ArchModule[];
  links: ArchLink[];
  cycles: string[][]; // groups of modules that depend on each other in a loop
  fileCycles: string[][]; // groups of files that import each other in a loop (circular imports)
  coverage: number | null; // from the import graph: share of internal-looking imports that were followed
  hotspotsAnalysed: boolean; // false if F4 hasn't been run, so modules aren't coloured
  mermaid: string; // the diagram as Mermaid text
}

/** The folder a file is in, cut to `depth` levels. Files at the top of the repo are in "(root)". */
export function moduleOf(file: string, depth: number): string {
  const dir = path.posix.dirname(file);
  if (dir === ".") return "(root)";
  return dir.split("/").slice(0, depth).join("/");
}

/** Picks the deepest folder level that still gives at most `max` modules (at least level 1). */
export function chooseDepth(files: string[], max = MAX_MODULES): number {
  const deepest = Math.max(1, ...files.map((f) => path.posix.dirname(f).split("/").length));
  for (let depth = deepest; depth > 1; depth--) {
    if (new Set(files.map((f) => moduleOf(f, depth))).size <= max) return depth;
  }
  return 1;
}

/**
 * Finds loops in a directed graph: groups of nodes where each can reach every other by following arrows
 * (Tarjan's algorithm for strongly connected components). Only groups of 2 or more are returned.
 */
export function findCycles(nodes: string[], edges: Array<{ from: string; to: string }>): string[][] {
  const next = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const e of edges) if (e.from !== e.to) next.get(e.from)?.push(e.to);

  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];

  // Written without recursion, so a long chain of imports can't overflow the call stack.
  for (const start of nodes) {
    if (index.has(start)) continue;
    const work: Array<{ node: string; i: number }> = [{ node: start, i: 0 }];
    index.set(start, counter);
    low.set(start, counter++);
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1];
      const targets = next.get(frame.node) ?? [];
      if (frame.i < targets.length) {
        const to = targets[frame.i++];
        if (!index.has(to)) {
          index.set(to, counter);
          low.set(to, counter++);
          stack.push(to);
          onStack.add(to);
          work.push({ node: to, i: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(to)!));
        }
        continue;
      }
      // All arrows from this node are done: if it's the root of a group, pop the group off the stack.
      if (low.get(frame.node) === index.get(frame.node)) {
        const group: string[] = [];
        let n: string;
        do {
          n = stack.pop()!;
          onStack.delete(n);
          group.push(n);
        } while (n !== frame.node);
        if (group.length > 1) groups.push(group.sort());
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
    }
  }
  return groups.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

/** Makes text safe inside a quoted Mermaid label. */
function mermaidText(text: string): string {
  return text.replace(/"/g, "#quot;").replace(/[<>]/g, "");
}

/** Hotspot colour band for a score: 3 = top hotspots (score 67+), 2 = 34+, 1 = above 0, 0 = none. */
export function heatLevel(score: number | undefined): 0 | 1 | 2 | 3 {
  if (!score) return 0;
  return score >= 67 ? 3 : score >= 34 ? 2 : 1;
}

/** Writes the map as a Mermaid flowchart. Coloured boxes are hotspots; red arrows are part of a cycle. */
export function toMermaid(modules: ArchModule[], links: ArchLink[]): string {
  const id = new Map(modules.map((m) => [m.name, m.id]));
  const lines = ["flowchart LR"];
  for (const m of modules) {
    const fileCount = `${m.files.length} file${m.files.length === 1 ? "" : "s"}`;
    lines.push(`  ${m.id}["${mermaidText(m.name)}<br/>${fileCount}"]`);
  }
  links.forEach((l) => lines.push(`  ${id.get(l.from)} -->|${l.count}| ${id.get(l.to)}`));

  // Colours: oranges for hotspots (darker = higher hotspot score), dark text so they read in light and dark themes.
  lines.push("  classDef heat1 fill:#f5e6d6,stroke:#b4501c,color:#1c1915");
  lines.push("  classDef heat2 fill:#f0a274,stroke:#9e4617,color:#1c1915");
  lines.push("  classDef heat3 fill:#e07a3f,stroke:#7a3410,color:#1c1915,font-weight:bold");
  for (const level of [1, 2, 3] as const) {
    const ids = modules.filter((m) => heatLevel(m.hotspot?.score) === level).map((m) => m.id);
    if (ids.length) lines.push(`  class ${ids.join(",")} heat${level}`);
  }
  const cycleLinks = links.flatMap((l, i) => (l.inCycle ? [i] : []));
  if (cycleLinks.length) lines.push(`  linkStyle ${cycleLinks.join(",")} stroke:#c0392b,stroke-width:2px`);
  return lines.join("\n");
}

/** Builds the architecture map from the import graph, and the F4 hotspots if the history was analysed. */
export function buildArchitecture(graph: ImportGraph, history: HistoryReport | null): ArchitectureMap {
  const depth = chooseDepth(graph.files);
  const moduleNames = [...new Set(graph.files.map((f) => moduleOf(f, depth)))].sort();

  // Add up file imports into module arrows, keeping a few examples of each.
  const linkMap = new Map<string, ArchLink>();
  for (const e of graph.edges) {
    const from = moduleOf(e.from, depth);
    const to = moduleOf(e.to, depth);
    if (from === to) continue;
    const key = `${from}\n${to}`;
    const link = linkMap.get(key) ?? { from, to, count: 0, examples: [], inCycle: false };
    link.count++;
    if (link.examples.length < EXAMPLES_PER_LINK) link.examples.push(e);
    linkMap.set(key, link);
  }
  const links = [...linkMap.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  // Loops between modules. An arrow is part of a loop if both ends are in the same group.
  const cycles = findCycles(moduleNames, links);
  const groupOf = new Map<string, number>();
  cycles.forEach((group, i) => group.forEach((m) => groupOf.set(m, i)));
  for (const l of links) l.inCycle = groupOf.has(l.from) && groupOf.get(l.from) === groupOf.get(l.to);

  // The top hotspot file in each module, from F4.
  const scores = new Map((history?.files ?? []).map((f) => [f.path, f.score]));

  const modules: ArchModule[] = moduleNames.map((name, i) => {
    const files = graph.files.filter((f) => moduleOf(f, depth) === name);
    let hotspot: ArchModule["hotspot"] = null;
    for (const file of files) {
      const score = scores.get(file);
      if (score && (!hotspot || score > hotspot.score)) hotspot = { score, file };
    }
    return {
      id: `m${i}`,
      name,
      files,
      uses: links.filter((l) => l.from === name).length,
      usedBy: links.filter((l) => l.to === name).length,
      hotspot,
      inCycle: groupOf.has(name),
    };
  });

  const internal = graph.stats.internal + graph.stats.unresolved;
  return {
    repoId: graph.repoId,
    commitSha: graph.commitSha,
    depth,
    modules,
    links,
    cycles,
    fileCycles: findCycles(graph.files, graph.edges).slice(0, MAX_FILE_CYCLES),
    coverage: internal === 0 ? null : graph.stats.internal / internal,
    hotspotsAnalysed: history !== null,
    mermaid: toMermaid(modules, links),
  };
}
