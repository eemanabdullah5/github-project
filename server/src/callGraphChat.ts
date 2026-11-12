// Call graph phase 4: answers "who calls X?" in chat from the call graph, not just from search.
// Search only sees 8 chunks and can miss callers; the graph read every file, so its list is complete.
// For "what breaks if I change X?" or "is X tested?", it also adds X's change impact (impact.ts).
import { focusGraph, listFunctions, type CallFunction, type CallGraph, type FocusItem } from "./callGraph.js";
import { codeNames } from "./hybridSearch.js";
import { changeImpact, isHotspot, type ImpactItem } from "./impact.js";
import type { Scope } from "./scope.js";
import type { HistoryReport, Source } from "./types.js";

/** Max functions per question (keeps the prompt small). */
const MAX_FUNCTIONS = 2;
/** Max callers and callees listed per function; the rest are counted. */
const MAX_PER_SIDE = 8;
/** Max further callers and tests listed in the impact part. */
const MAX_IMPACT_LISTED = 10;
const MAX_TESTS_LISTED = 5;

/** English words that are never function names. */
const NOT_NAMES = new Set("the a an this that it its my our function method functions methods code file from by in on to and or".split(" "));

/** Questions about changing, risk or tests get the change impact too. */
const IMPACT_WORDS = /\b(?:break|breaks|broke|broken|impact|affect(?:s|ed)?|chang(?:e|es|ed|ing)|modify(?:ing)?|refactor(?:ing)?|renam(?:e|ing)|remov(?:e|ing)|delet(?:e|ing)|risk|risky|safe|tested|tests?|testing|coverage|covered|depend(?:s|ent|ents|encies)?)\b/i;

/** Does the question ask what a change would affect, or about tests? */
export function wantsImpact(question: string): boolean {
  return IMPACT_WORDS.test(question);
}

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
    /\b(?:is|are|does|do)\s+([A-Za-z_$][\w$.]*)\s+(?:get\s+)?(?:called|used|call|invoked|tested|covered|safe)\b/gi, // where is answer called / is answer tested
    /\b(?:change|changing|modify|modifying|refactor|refactoring|rename|renaming|remove|removing|delete|deleting|test|testing)\s+(?:the\s+)?(?:function\s+|method\s+)?([A-Za-z_$][\w$.]*)/gi, // if I change answer
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
    // "vectorStore.query" (module.function): query() in a file named vectorStore.*
    const dot = name.lastIndexOf(".");
    const inModule = (f: CallFunction) =>
      dot > 0 && f.name === name.slice(dot + 1) && f.file.split("/").pop()!.replace(/\.\w+$/, "") === name.slice(0, dot);
    const matches = ranked
      .filter((f) => f.name === name || f.qualified === name || inModule(f))
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

/** "2 steps: answer(), generateReport() · 3 steps: createApp()" */
function byDistance(items: ImpactItem[]): string {
  const groups = new Map<number, string[]>();
  for (const i of items) {
    const name = i.fn.kind === "top-level" ? `(top level of ${i.fn.file})` : title(i.fn);
    groups.set(i.distance, [...(groups.get(i.distance) ?? []), `${name}${i.certain ? "" : " (possible)"}`]);
  }
  return [...groups].map(([d, names]) => `${d} steps: ${names.join(", ")}`).join(" · ");
}

/** The CALL GRAPH prompt block and its cited lines as sources; null if no function matches. */
export function callGraphContext(
  graph: CallGraph,
  question: string,
  scope: Scope | null = null,
  history: HistoryReport | null = null, // for hotspot files in the impact part
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
    if (wantsImpact(question)) lines.push(...impactLines(graph, fn, history, addSource));
    return lines.join("\n");
  });

  const notes = [...skipped].map(([name, n]) => `Note: ${n} other function${n === 1 ? "" : "s"} named "${name}" not shown.`);
  return { text: [...sections, ...notes].join("\n\n"), sources, functions };
}

/** The "If it changes" part: everything that calls it, all the way up, and the tests that reach it. */
function impactLines(
  graph: CallGraph,
  fn: CallFunction,
  history: HistoryReport | null,
  addSource: (path: string, startLine: number, endLine: number, symbol: string) => void,
): string[] {
  const impact = changeImpact(graph, fn.id, history);
  const t = impact.totals;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const lines = ["If it changes (callers followed all the way up):"];

  if (t.affected === 0) lines.push("- Nothing in the repo calls it, so a change only affects its own file.");
  else {
    const hot = t.hotspotFiles ? ` (${t.hotspotFiles} of them hotspots)` : "";
    const possible = t.certain < t.affected ? `; ${t.affected - t.certain} only through possible calls` : "";
    lines.push(`- Affects ${plural(t.affected, "function")}, up to ${plural(t.maxDistance, "step")} away, in ${plural(t.files, "file")}${hot}${possible}.`);
  }

  const further = impact.affected.filter((i) => i.distance > 1);
  if (further.length) {
    const shown = further.slice(0, MAX_IMPACT_LISTED);
    lines.push(`- Further callers: ${byDistance(shown)}${further.length > shown.length ? ` …and ${further.length - shown.length} more` : ""}`);
  }
  const hotFiles = impact.files.filter((f) => isHotspot(f.hotspot)).map((f) => f.file);
  if (hotFiles.length) lines.push(`- Hotspot files reached: ${hotFiles.join(", ")}`);
  if (impact.entryPoints.length) {
    const entries = impact.entryPoints.slice(0, MAX_IMPACT_LISTED).map((i) => `${title(i.fn)} in ${i.fn.file}`);
    lines.push(`- Entry points reached (code nothing else calls): ${entries.join(", ")}`);
  }

  if (t.tests === 0) {
    lines.push("- Tests: NO test reaches it. A mistake here would not be caught by the test suite.");
  } else {
    lines.push(`- Tests that reach it (${t.tests}):`);
    for (const i of impact.tests.slice(0, MAX_TESTS_LISTED)) {
      addSource(i.fn.file, i.line, i.line, `test reaches ${fn.name}()`);
      const how = i.distance === 1 ? "calls it directly" : `${i.distance} steps away`;
      lines.push(`  - ${title(i.fn)} in ${i.fn.file}, ${how}, at ${cite(i.fn.file, i.line)}`);
    }
    if (t.tests > MAX_TESTS_LISTED) lines.push(`  - …and ${t.tests - MAX_TESTS_LISTED} more`);
  }
  return lines;
}
