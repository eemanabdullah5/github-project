// F4 — How complex a file is, for the hotspot score.
// A file's complexity = the complexity of its MOST complex function, so a big file full of simple functions
// doesn't beat a small file with one tangled function.
//
// Each function is scored with a simplified "cognitive complexity" (SonarSource's metric, used by SonarQube):
//  - +1 for each if, else if, else, switch, loop, catch, and "? :"
//  - plus 1 extra for every level it is nested inside another of those, because nested code is harder to follow
//  - +1 for each chain of the same logical operator: a && b && c is +1, a && b || c is +2
// Named functions (declarations, methods, `const f = () => …`) are scored on their own. Anonymous callbacks
// count as part of the function they're written in, one level deeper.
// Code outside any function (e.g. a Python script) is scored as "(top-level code)".
//
// Uses tree-sitter (already used for chunking), so comments and strings are ignored automatically.
// Languages without a grammar, and files with syntax errors, fall back to the old count of decision words
// (countDecisionPoints) and are marked "estimate".
import type { Node } from "web-tree-sitter";
import { getParser } from "./chunking/syntaxChunker.js";
import { LANGUAGES } from "./chunking/languages.js";
import type { FileComplexity, SourceFile } from "./types.js";

// Docs and config files: "complexity" doesn't mean anything for them, so it's 0.
export const NON_CODE_LANGUAGES = new Set(["markdown", "rst", "text", "json", "yaml", "toml", "xml", "html", "css", "scss"]);

// The syntax-tree node types that matter, for every supported language together.
// (Each grammar only uses its own names, so one shared list is simpler than one per language.)
const LOOPS = new Set([
  "for_statement", "for_in_statement", "while_statement", "do_statement", // JS/TS, Python, Java, Go
  "enhanced_for_statement", // Java: for (x : list)
]);
const SWITCHES = new Set([
  "switch_statement", // JS/TS
  "switch_expression", // Java
  "expression_switch_statement", "type_switch_statement", "select_statement", // Go
  "match_statement", // Python
]);
const CATCHES = new Set(["catch_clause", "except_clause"]);
const TERNARIES = new Set(["ternary_expression", "conditional_expression"]);
const LOGICAL_NODES = new Set(["binary_expression", "boolean_operator"]);
const LOGICAL_OPERATORS = new Set(["&&", "||", "and", "or"]);

// Functions that always have a name, so they are always scored on their own.
const NAMED_FUNCTIONS = new Set([
  "function_declaration", "generator_function_declaration", "method_definition", // JS/TS
  "function_definition", // Python
  "method_declaration", "constructor_declaration", // Java, Go
]);
// Functions written as values (arrow functions, lambdas…). Named when stored in a variable or property,
// otherwise they're callbacks and count as part of the function around them.
const FUNCTION_VALUES = new Set([
  "arrow_function", "function_expression", "function", "generator_function", // JS/TS
  "lambda", // Python
  "lambda_expression", // Java
  "func_literal", // Go
]);
const CLASSES = new Set(["class_declaration", "class_definition", "class", "interface_declaration"]);

// One function's result while walking the file.
export interface FunctionScore {
  name: string;
  line: number; // 1-based
  endLine: number;
  complexity: number;
}

// The old method, kept as the fallback: counts decision words across the whole file.
// Counted: if, elif, for, foreach, while, case, catch, except, &&, ||, and the "? :" shortcut.
// Not counted: "?." and "??" (safe-access shortcuts) and "x?: number" (optional types).
export function countDecisionPoints(text: string): number {
  const keywords = text.match(/\b(?:if|elif|for|foreach|while|case|catch|except)\b/g)?.length ?? 0;
  const operators = text.match(/&&|\|\||(?<![?.])\?(?![.?:])/g)?.length ?? 0;
  return keywords + operators;
}

// The fallback result for a file we can't parse (or a docs/config file, which is 0).
export function estimateComplexity(file: SourceFile): FileComplexity {
  if (NON_CODE_LANGUAGES.has(file.language)) return { complexity: 0, method: "none", topFunction: null };
  return { complexity: countDecisionPoints(file.text), method: "estimate", topFunction: null };
}

// The name to show for a function value, or null if it's an anonymous callback.
// `const login = () => …` → "login", `{ save: function () {…} }` → "save", `this.x = () => …` → "this.x".
function functionValueName(node: Node): string | null {
  const parent = node.parent;
  if (!parent) return null;
  const field = (name: string) => parent.childForFieldName(name);
  switch (parent.type) {
    case "variable_declarator": // JS/TS, Java
      return field("name")?.text ?? null;
    case "assignment_expression": // JS/TS
    case "assignment": // Python
      return field("left")?.text ?? null;
    case "pair": // JS/TS object property
      return field("key")?.text ?? null;
    case "public_field_definition": // TS class field
    case "field_definition": // JS class field
      return (field("name") ?? field("property"))?.text ?? null;
    default:
      return null;
  }
}

// A label for a top-level callback, e.g. `describe("x", () => …)` → "describe callback".
function callbackLabel(node: Node): string {
  const call = node.parent?.type === "arguments" ? node.parent.parent : null;
  const callee = call?.childForFieldName("function")?.text;
  return callee ? `${callee.length > 40 ? `${callee.slice(0, 39)}…` : callee} callback` : "(anonymous function)";
}

// Puts the class name in front of a method name: "UserService.save".
function withClassName(node: Node, name: string): string {
  for (let p = node.parent; p; p = p.parent) {
    if (CLASSES.has(p.type)) {
      const className = p.childForFieldName("name")?.text;
      return className ? `${className}.${name}` : name;
    }
    if (NAMED_FUNCTIONS.has(p.type) || FUNCTION_VALUES.has(p.type)) break; // a class inside a function: keep it short
  }
  return name;
}

// The operator of a logical expression ("&&", "or"…), or null if it isn't one.
function logicalOperator(node: Node | null): string | null {
  if (!node || !LOGICAL_NODES.has(node.type)) return null;
  const op = node.childForFieldName("operator")?.type ?? node.children.find((c) => c && LOGICAL_OPERATORS.has(c.type))?.type;
  return op && LOGICAL_OPERATORS.has(op) ? op : null;
}

// Scores every function in a parsed file. Exported for tests.
export function scoreFunctions(root: Node): FunctionScore[] {
  const results: FunctionScore[] = [];
  const topLevel: FunctionScore = { name: "(top-level code)", line: 1, endLine: root.endPosition.row + 1, complexity: 0 };

  // Starts a new function, walks its body, and saves its score.
  function scoreFunction(node: Node, name: string) {
    const fn: FunctionScore = { name, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1, complexity: 0 };
    for (const child of node.namedChildren) if (child) walk(child, fn, 0);
    results.push(fn);
  }

  function walkChildren(node: Node, fn: FunctionScore, nesting: number) {
    for (const child of node.namedChildren) if (child) walk(child, fn, nesting);
  }

  // An if statement. `elseIf` is true for the "if" in "else if", which gets +1 but no nesting bonus.
  function walkIf(node: Node, fn: FunctionScore, nesting: number, elseIf: boolean) {
    fn.complexity += elseIf ? 1 : 1 + nesting;
    for (const child of node.namedChildren) {
      if (!child) continue;
      const isAlternative = node.childrenForFieldName("alternative").some((a) => a?.id === child.id);
      if (!isAlternative) {
        walk(child, fn, nesting + 1); // the condition and the "then" part
        continue;
      }
      // The "else" part. JS/TS wrap it in else_clause; Java and Go put the statement there directly.
      const inner = child.type === "else_clause" ? child.namedChildren.find((c) => c && c.type !== "comment") : child;
      if (child.type === "elif_clause") {
        // Python elif: +1, no nesting bonus, and its body is one level in.
        fn.complexity += 1;
        walkChildren(child, fn, nesting + 1);
      } else if (inner?.type === "if_statement") {
        walkIf(inner, fn, nesting, true); // else if
      } else {
        fn.complexity += 1; // plain else
        walkChildren(child, fn, nesting + 1);
      }
    }
  }

  function walk(node: Node, fn: FunctionScore, nesting: number) {
    const type = node.type;

    // Functions: named ones are scored separately; callbacks count here, one level deeper.
    if (NAMED_FUNCTIONS.has(type)) {
      scoreFunction(node, withClassName(node, node.childForFieldName("name")?.text ?? "(anonymous function)"));
      return;
    }
    if (FUNCTION_VALUES.has(type)) {
      const name = functionValueName(node);
      if (name) scoreFunction(node, withClassName(node, name));
      else if (fn === topLevel) scoreFunction(node, callbackLabel(node)); // e.g. describe(() => …) at the top
      else walkChildren(node, fn, nesting + 1);
      return;
    }

    if (type === "if_statement") return walkIf(node, fn, nesting, false);

    if (LOOPS.has(type) || SWITCHES.has(type) || CATCHES.has(type) || TERNARIES.has(type)) {
      fn.complexity += 1 + nesting;
      walkChildren(node, fn, nesting + 1);
      return;
    }

    // Python's "else" after a loop or try ("for … else"): +1, like any else.
    if (type === "else_clause") {
      fn.complexity += 1;
      walkChildren(node, fn, nesting + 1);
      return;
    }

    // A chain of the same logical operator counts once: only add when the parent isn't the same operator.
    const op = logicalOperator(node);
    if (op && logicalOperator(node.parent) !== op) fn.complexity += 1;

    walkChildren(node, fn, nesting);
  }

  walkChildren(root, topLevel, 0);
  if (topLevel.complexity > 0) results.push(topLevel);
  return results;
}

// Measures a file: parses it and returns its most complex function.
// Falls back to estimateComplexity for unsupported languages and files with syntax errors.
export async function measureComplexity(file: SourceFile): Promise<FileComplexity> {
  const spec = LANGUAGES[file.language];
  if (!spec) return estimateComplexity(file);

  const parser = await getParser(file.language, spec);
  const tree = parser.parse(file.text);
  if (!tree) return estimateComplexity(file);
  try {
    if (tree.rootNode.hasError) return estimateComplexity(file);
    const functions = scoreFunctions(tree.rootNode);
    const top = functions.reduce<FunctionScore | null>((best, f) => (!best || f.complexity > best.complexity ? f : best), null);
    if (!top || top.complexity === 0) return { complexity: 0, method: "syntax", topFunction: null };
    return { complexity: top.complexity, method: "syntax", topFunction: top };
  } finally {
    tree.delete(); // tree-sitter trees live in WebAssembly memory, so free them
  }
}

/** Every function's complexity in a file, or null if it can't be parsed (unsupported language or syntax error). */
export async function measureFunctions(file: SourceFile): Promise<FunctionScore[] | null> {
  const spec = LANGUAGES[file.language];
  if (!spec) return null;
  const parser = await getParser(file.language, spec);
  const tree = parser.parse(file.text);
  if (!tree) return null;
  try {
    return tree.rootNode.hasError ? null : scoreFunctions(tree.rootNode);
  } finally {
    tree.delete();
  }
}
