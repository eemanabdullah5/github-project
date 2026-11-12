// Call graph phase 4: answers "who calls X?" in chat from the call graph, not just from search.
// Search only sees 8 chunks and can miss callers; the graph read every file, so its list is complete.
import { focusGraph, listFunctions, type CallFunction, type CallGraph, type FocusItem } from "./callGraph.js";
import { codeNames } from "./hybridSearch.js";
import type { Scope } from "./scope.js";
import type { Source } from "./types.js";

/** Max functions per question (keeps the prompt small). */
const MAX_FUNCTIONS = 2;
/** Max callers and callees listed per function; the rest are counted. */
const MAX_PER_SIDE = 8;

/** English words that are never function names. */
const NOT_NAMES = new Set("the a an this that it its function method functions methods code from by in on to and or".split(" "));

/** Function names in a question: code-like names, answer(), or the word after "calls"/"called". */
export function functionNamesIn(text: string): string[] {
  const names = codeNames(text).filter((n) => !/\.(?:[jt]sx?|py|md|json)$/i.test(n)); // file names aren't functions
  const add = (name: string | undefined) => {
    const clean = name?.replace(/^[.]+|[.]+$/g, "");
    if (clean && clean.length >= 2 && !NOT_NAMES.has(clean.toLowerCase()) && !names.includes(clean)) names.push(clean);
  };
  for (const m of text.matchAll(/([A-Za-z_$][\w$.]*)\s*\(\)/g)) add(m[1]); // answer()
  const patterns = [
    /\b(?:calls?|calling|callers?\s+of|uses?|using|invokes?)\s+(?:the\s+)?(?:function\s+|method\s+)?([A-Za-z_$][\w$.]*)/gi, // who calls answer
    /\b(?:is|are|does|do)\s+([A-Za-z_$][\w$.]*)\s+(?:get\s+)?(?:called|used|call|invoked)\b/gi, // where is answer called / what does answer call
  ];
  for (const pattern of patterns) for (const m of text.matchAll(pattern)) add(m[1]);
  return names;
}

/** Picks one graph function per name (in scope, not a test, most-called first) and counts the rest. */
export function matchFunctions(
  graph: CallGraph,
  names: string[],
  scope: Scope | null = null,
): { functions: CallFunction[]; skipped: Map<string, number> } {
  const ranked = listFunctions(graph).filter((f) => f.kind !== "top-level"); // most-called first
  const inScope = (f: CallFunction) =>
    !scope || (scope.kind === "file" ? f.file === scope.path : f.file.startsWith(`${scope.path}/`));
  const functions: CallFunction[] = [];
  const skipped = new Map<string, number>();
  for (const name of names) {
    const matches = ranked
      .filter((f) => f.name === name || f.qualified === name)
      .sort((a, b) => Number(inScope(b)) - Number(inScope(a)) || Number(a.isTest) - Number(b.isTest)); // stable: keeps most-called order
    const fresh = matches.filter((f) => !functions.some((g) => g.id === f.id));
    const room = MAX_FUNCTIONS - functions.length;
    // One per name, so a question with two names covers both.
    const take = fresh.slice(0, room > 0 ? 1 : 0);
    functions.push(...take);
    if (fresh.length > take.length) skipped.set(name, fresh.length - take.length);
  }
  return { functions, skipped };
}

/** "Agent.remember()" or "(top level)". */
const title = (fn: CallFunction) => (fn.kind === "top-level" ? "(top level)" : `${fn.qualified}()`);
/** A citation: [path:L12] or [path:L12-L40]. */
const cite = (file: string, start: number, end = start) => `[${file}:L${start}${end > start ? `-L${end}` : ""}]`;

/** The CALL GRAPH prompt block and its cited lines as sources; null if no function matches. */
export function callGraphContext(
  graph: CallGraph,
  question: string,
  scope: Scope | null = null,
): { text: string; sources: Source[]; functions: CallFunction[] } | null {
  const { functions, skipped } = matchFunctions(graph, functionNamesIn(question), scope);
  if (functions.length === 0) return null;

  const sources: Source[] = [];
  const addSource = (path: string, startLine: number, endLine: number, symbol: string) => {
    if (!sources.some((s) => s.path === path && s.startLine === startLine && s.endLine === endLine)) {
      sources.push({ path, startLine, endLine, symbol });
    }
  };

  const sections = functions.map((fn) => {
    const view = focusGraph(graph, fn.id, 1);
    addSource(fn.file, fn.line, fn.endLine, fn.qualified);
    const lines = [`Function: ${title(fn)} in ${fn.file}, defined at ${cite(fn.file, fn.line, fn.endLine)}${fn.isTest ? " (test code)" : ""}`];

    /** Writes the callers or the callees list. */
    const side = (heading: string, items: FocusItem[], more: number, describe: (i: FocusItem) => string) => {
      const shown = items.slice(0, MAX_PER_SIDE);
      const hidden = more + items.length - shown.length;
      const total = items.length + more;
      lines.push(`${heading} (${total}):`);
      if (total === 0) lines.push("- none found");
      for (const item of shown) {
        const notes = [item.fn.isTest ? "test code" : "", item.certain ? "" : "possible: matched by method name only"].filter(Boolean);
        lines.push(`- ${describe(item)}${notes.length ? ` (${notes.join("; ")})` : ""}`);
      }
      if (hidden > 0) lines.push(`- …and ${hidden} more not listed`);
    };

    side("Called by", view.callers, view.more.callers, (i) => {
      addSource(i.site, i.line, i.line, `${title(i.fn)} calls ${fn.name}()`);
      return `${title(i.fn)} in ${i.fn.file}, call at ${cite(i.site, i.line)}`;
    });
    side("Calls", view.callees, view.more.callees, (i) => {
      addSource(i.fn.file, i.fn.line, i.fn.line, i.fn.qualified);
      return `${title(i.fn)} in ${i.fn.file} (defined at ${cite(i.fn.file, i.fn.line)}), called at ${cite(i.site, i.line)}`;
    });
    return lines.join("\n");
  });

  const notes = [...skipped].map(([name, n]) => `Note: ${n} other function${n === 1 ? "" : "s"} named "${name}" not shown.`);
  return { text: [...sections, ...notes].join("\n\n"), sources, functions };
}
