// Change impact: if this function changes, what else is affected and which tests reach it.
// Follows callers backwards through the call graph, all the way up. No AI.
import { heatLevel } from "./architecture.js";
import { AppError } from "./errors.js";
import type { CallEdge, CallFunction, CallGraph } from "./callGraph.js";
import type { HistoryReport } from "./types.js";

/** Max functions returned per list; the rest are counted. */
const MAX_LISTED = 200;

/** One affected function. */
export interface ImpactItem {
  fn: CallFunction;
  distance: number; // 1 = calls the target directly, 2 = calls a direct caller…
  via: string; // the function it calls on the way to the target
  line: number; // where it makes that call
  certain: boolean; // false = the only path uses a "possible" (name-matched) call
}

/** A file the change reaches. */
export interface ImpactFile {
  file: string;
  functions: number; // affected functions in it
  hotspot: 0 | 1 | 2 | 3; // heat from the Hotspots tab, 0 = not a hotspot
}

export interface ChangeImpact {
  target: CallFunction;
  affected: ImpactItem[]; // real code, nearest first
  tests: ImpactItem[]; // test functions that reach the target, nearest first
  entryPoints: ImpactItem[]; // affected functions nothing calls (routes, scripts, main)
  files: ImpactFile[]; // hotspots first, then most affected
  totals: { affected: number; certain: number; tests: number; files: number; hotspotFiles: number; maxDistance: number };
  more: { affected: number; tests: number };
}

/** Shortest caller paths to `targetId`, using only certain calls or all calls. */
function walkCallers(into: Map<string, CallEdge[]>, targetId: string, certainOnly: boolean): Map<string, { distance: number; edge: CallEdge }> {
  const reached = new Map<string, { distance: number; edge: CallEdge }>();
  let frontier = [targetId];
  for (let distance = 1; frontier.length; distance++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of into.get(id) ?? []) {
        if (certainOnly && !e.certain) continue;
        if (e.from === targetId || reached.has(e.from)) continue;
        reached.set(e.from, { distance, edge: e });
        next.push(e.from);
      }
    }
    frontier = next;
  }
  return reached;
}

/** Everything affected by a change to one function. */
export function changeImpact(graph: CallGraph, id: string, history: HistoryReport | null = null): ChangeImpact {
  const fnById = new Map(graph.functions.map((f) => [f.id, f]));
  const target = fnById.get(id);
  if (!target) throw new AppError("That function isn't in the call graph (the code may have changed since indexing).", 404);

  const into = new Map<string, CallEdge[]>(); // function → calls into it
  const hasCallers = new Set<string>();
  for (const e of graph.edges) {
    into.set(e.to, [...(into.get(e.to) ?? []), e]);
    if (e.from !== e.to) hasCallers.add(e.to);
  }

  // Certain paths win; possible-only paths fill in the rest.
  const certain = walkCallers(into, id, true);
  const all = walkCallers(into, id, false);
  const items: ImpactItem[] = [...all].map(([fnId, path]) => {
    const best = certain.get(fnId) ?? path;
    return { fn: fnById.get(fnId)!, distance: best.distance, via: best.edge.to, line: best.edge.line, certain: certain.has(fnId) };
  });
  items.sort((a, b) => a.distance - b.distance || Number(b.certain) - Number(a.certain) || a.fn.id.localeCompare(b.fn.id));

  const affected = items.filter((i) => !i.fn.isTest);
  const tests = items.filter((i) => i.fn.isTest);
  const entryPoints = affected.filter((i) => !hasCallers.has(i.fn.id));

  // Files: the target's own file counts too.
  const scores = new Map((history?.files ?? []).map((f) => [f.path, f.score]));
  const perFile = new Map<string, number>([[target.file, 0]]);
  for (const i of affected) perFile.set(i.fn.file, (perFile.get(i.fn.file) ?? 0) + 1);
  const files: ImpactFile[] = [...perFile]
    .map(([file, functions]) => ({ file, functions, hotspot: heatLevel(scores.get(file)) }))
    .sort((a, b) => b.hotspot - a.hotspot || b.functions - a.functions || a.file.localeCompare(b.file));

  return {
    target,
    affected: affected.slice(0, MAX_LISTED),
    tests: tests.slice(0, MAX_LISTED),
    entryPoints: entryPoints.slice(0, MAX_LISTED),
    files,
    totals: {
      affected: affected.length,
      certain: affected.filter((i) => i.certain).length,
      tests: tests.length,
      files: files.length,
      hotspotFiles: files.filter((f) => f.hotspot > 0).length,
      maxDistance: items.reduce((max, i) => Math.max(max, i.distance), 0),
    },
    more: { affected: Math.max(0, affected.length - MAX_LISTED), tests: Math.max(0, tests.length - MAX_LISTED) },
  };
}
