// Phase 4 — Hidden coupling: code files that keep changing in the same commit but don't import each other.
// Two files that change together usually do so because one uses the other. When there's no import between
// them, something else ties them together that the code doesn't show: copied logic, a shared data format,
// an API and its client, a config key used in two places. These are easy to break by changing only one side.
//
// Built from two things the app already has, with no AI:
//  - "files that change together" from the git history (F4, gitHistory.ts)
//  - the import graph (importGraph.ts)
// Only code files in the import graph are compared (Python, JavaScript, TypeScript): a README or a JSON file
// "not importing" anything means nothing.
import type { CoChangePair, HiddenCoupling, HiddenCouplingPair, HistoryReport, ImportGraph } from "./types.js";

/** Most pairs listed. */
export const MAX_HIDDEN_PAIRS = 10;

/**
 * The shortest import chain from `from` to `to`, following import arrows (breadth-first search),
 * or null if there's none. Both ends are included: ["a.ts", "b.ts", "c.ts"] means a imports b, b imports c.
 */
export function importPath(next: Map<string, string[]>, from: string, to: string): string[] | null {
  const cameFrom = new Map<string, string>([[from, ""]]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    if (node === to) {
      const chain = [to];
      while (chain[0] !== from) chain.unshift(cameFrom.get(chain[0])!);
      return chain;
    }
    for (const n of next.get(node) ?? []) {
      if (!cameFrom.has(n)) {
        cameFrom.set(n, node);
        queue.push(n);
      }
    }
  }
  return null;
}

/** Finds pairs of code files that change together but have no direct import between them. */
export function findHiddenCoupling(graph: ImportGraph, history: HistoryReport): HiddenCoupling {
  const codeFiles = new Set(graph.files);
  const candidates: CoChangePair[] = (history.coChangeAll ?? history.coChange ?? []).filter((p) => codeFiles.has(p.a) && codeFiles.has(p.b));

  const next = new Map<string, string[]>();
  const direct = new Set<string>(); // "a\nb", in both directions
  for (const e of graph.edges) {
    next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
    direct.add(`${e.from}\n${e.to}`);
    direct.add(`${e.to}\n${e.from}`);
  }

  const pairs: HiddenCouplingPair[] = [];
  for (const p of candidates) {
    if (direct.has(`${p.a}\n${p.b}`)) continue; // one imports the other: nothing hidden
    // Either direction counts. Of the two chains, keep the shorter.
    const chains = [importPath(next, p.a, p.b), importPath(next, p.b, p.a)].filter((c): c is string[] => c !== null);
    const via = chains.sort((x, y) => x.length - y.length)[0] ?? [];
    pairs.push({ ...p, link: via.length ? "indirect" : "none", via });
  }

  // Fully hidden pairs first, then the ones that change together most.
  pairs.sort((x, y) => Number(x.link === "indirect") - Number(y.link === "indirect") || y.count - x.count || y.percent - x.percent);
  return {
    pairsChecked: candidates.length,
    pairs: pairs.slice(0, MAX_HIDDEN_PAIRS),
    partial: history.coChangeAll === undefined,
  };
}
