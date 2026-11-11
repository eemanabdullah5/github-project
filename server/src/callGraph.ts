// Call graph (Phase 4): which function calls which, read from the code with tree-sitter. No AI.
// The import graph says "rag.ts imports vectorStore.ts"; this goes one level deeper:
// "answer() calls searchChunks(), which calls query() and keywordQuery()".
//
// How a call is matched to a function, most certain first:
//  - certain:  a function in the same file · an imported function · module.fn() · this./self.method()
//              (also methods inherited from a parent class in the repo) · super.method() · new Class() / Class()
//              · x.method() when the same function made x from a class (bot = ChatbotAgent(...))
//  - possible: obj.method() where the code doesn't say what class obj is. Matched to methods with that name
//              in the same file or files it imports, only if there are a few (e.g. polymorphism: agent.respond()).
//  - dropped:  everything else (library and built-in calls like console.log or list.append).
// Python, JavaScript and TypeScript, like the import graph.
//
// Phase 1 (this file so far): build the graph in memory from a repo's files.
// Later phases: save it at indexing, the Calls tab with its diagram, and the chat and report hooks.
import type { Node } from "web-tree-sitter";
import { LANGUAGES } from "./chunking/languages.js";
import { getParser } from "./chunking/syntaxChunker.js";
import { resolveJs, resolvePython } from "./importResolvers.js";
import type { SourceFile } from "./types.js";
const CODE_LANGUAGES = new Set(["python", "javascript", "typescript", "tsx"]);

/** Most "possible" targets for one obj.method() call. Why: more than this is a guess, not a match. */
const MAX_POSSIBLE = 6;
/** Common method names that are almost always library calls (list.append, map.get…), so never guessed. */
const COMMON_METHODS = new Set(
  ("get set has add delete clear push pop shift unshift map filter reduce forEach find findIndex some every join " +
    "split replace slice splice concat sort reverse keys values entries items append extend insert remove update " +
    "copy then catch finally toString valueOf trim includes indexOf startsWith endsWith write read close open send " +
    "json text log error warn info debug format strip lower upper call apply bind next emit on off").split(" "),
);

/** One function (or method) in the graph. */
export interface CallFunction {
  id: string; // unique: "server/src/rag.ts#answer", "agents.py#Agent.remember", "demo.py#(top level)"
  name: string; // "answer", "remember", "(top level)"
  qualified: string; // with its class or outer function: "Agent.remember"
  file: string;
  line: number;
  endLine: number;
  kind: "function" | "method" | "top-level"; // top-level = code outside any function (scripts, __main__)
  isTest: boolean; // in a test file
}

/** One arrow: `from` calls `to`. */
export interface CallEdge {
  from: string;
  to: string;
  line: number; // the first place `from` calls `to`
  count: number; // how many times `from` calls `to`
  certain: boolean; // false = "possible" (a method guessed by its name)
}

export interface CallGraph {
  repoId: string;
  commitSha: string;
  generatedAt: string;
  functions: CallFunction[];
  edges: CallEdge[];
  stats: { calls: number; certain: number; possible: number; dropped: number };
}

// ---------- Step 1: read each file ----------

/** A call as written, before it's matched to a function. */
interface RawCall {
  from: string; // the function it's written in
  cls?: string; // the class it's written in, if any (for this./self./super calls)
  line: number;
  name: string; // the function or method name
  object?: string; // "foo" in foo.bar(); "this", "self" or "super" for those
  objectClass?: string; // the class of `object`, if the same function made it: bot = ChatbotAgent(...) → "ChatbotAgent"
}

/** A name brought in by an import: a function/class (`imported` = its name) or a whole module (`imported` = null). */
interface Binding {
  file: string;
  imported: string | null; // "default" for a JS default import
}

interface ClassInfo {
  name: string;
  file: string;
  bases: string[]; // parent class names, as written
  methods: Map<string, string>; // method name → function id
}

/** Everything read from one file. */
interface FileFacts {
  file: string;
  functions: CallFunction[];
  topLevel: Map<string, string>; // top-level function name → id
  classes: Map<string, ClassInfo>; // class name → info
  defaultExport?: string; // JS: the name of `export default function name`
  bindings: Map<string, Binding>; // local name → what it was imported from (repo files only)
  calls: RawCall[];
}

/** A test file? (tests/…, __tests__/…, *.test.ts, *.spec.js, test_*.py, *_test.py) */
export function isTestFile(filePath: string): boolean {
  return /(^|\/)(tests?|__tests__)\//.test(filePath) || /\.(test|spec)\.[jt]sx?$/.test(filePath) || /(^|\/)test_[^/]*\.py$|_test\.py$/.test(filePath);
}

/** The name of a function-like node, or null if it isn't one (or is anonymous, like a callback). */
function definitionName(node: Node): string | null {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "function_definition": // Python
    case "method_definition":
      return node.childForFieldName("name")?.text ?? null;
    case "variable_declarator":
    case "public_field_definition": {
      // const f = () => {} · const f = function () {} · class field f = () => {}
      const value = node.childForFieldName("value");
      const isFunction = value && ["arrow_function", "function_expression", "function", "generator_function"].includes(value.type);
      return isFunction ? (node.childForFieldName("name")?.text ?? null) : null;
    }
    default:
      return null;
  }
}

/** Parent class names: `class K extends Base` (JS/TS) or `class K(Base, Mixin)` (Python). */
function baseClasses(node: Node): string[] {
  if (node.type === "class_definition") {
    const args = node.childForFieldName("superclasses");
    return args ? args.namedChildren.flatMap((c) => (c && (c.type === "identifier" || c.type === "attribute") ? [c.text] : [])) : [];
  }
  const heritage = node.namedChildren.find((c) => c?.type === "class_heritage");
  const extendsClause = heritage?.namedChildren.find((c) => c?.type === "extends_clause");
  const value = extendsClause?.childForFieldName("value") ?? extendsClause?.namedChild(0);
  return value ? [value.text] : [];
}

/** Reads the call written by a call node: its name, and its object for obj.name(). Null if it can't be named. */
function readCall(node: Node): { name: string; object?: string } | null {
  if (node.type === "new_expression") {
    const ctor = node.childForFieldName("constructor");
    return ctor?.type === "identifier" ? { name: ctor.text } : null;
  }
  const fn = node.childForFieldName("function");
  if (!fn) return null;
  if (fn.type === "identifier") return { name: fn.text };
  if (fn.type === "member_expression" || fn.type === "attribute") {
    const property = fn.childForFieldName(fn.type === "attribute" ? "attribute" : "property");
    const object = fn.childForFieldName("object");
    if (!property || !object) return null;
    // Python super().m(): the object is the call super()
    const isPythonSuper = object.type === "call" && object.childForFieldName("function")?.text === "super";
    return { name: property.text, object: isPythonSuper ? "super" : object.text };
  }
  return null;
}

/**
 * `x = ClassName(...)` (Python) or `const x = new ClassName(...)` (JS/TS): returns ["x", "ClassName"], else null.
 * Why: then a later x.method() in the same function is a certain call to that class, not a guess.
 */
function createdObject(node: Node): [string, string] | null {
  if (node.type === "assignment") {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    const fn = right?.type === "call" ? right.childForFieldName("function") : null;
    // Only names that look like classes (start with a capital), so x = make_thing() isn't mistaken for one.
    if (left?.type === "identifier" && fn?.type === "identifier" && /^[A-Z]/.test(fn.text)) return [left.text, fn.text];
  }
  if (node.type === "variable_declarator") {
    const name = node.childForFieldName("name");
    const value = node.childForFieldName("value");
    const ctor = value?.type === "new_expression" ? value.childForFieldName("constructor") : null;
    if (name?.type === "identifier" && ctor?.type === "identifier") return [name.text, ctor.text];
  }
  return null;
}

/** Reads the imports of a file and records which local names come from which repo file. */
function readBindings(root: Node, file: SourceFile, allPaths: Set<string>): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  for (const node of walk(root)) {
    if (file.language === "python") {
      if (node.type === "import_from_statement") {
        const moduleNode = node.childForFieldName("module_name");
        if (!moduleNode) continue;
        let module = moduleNode.text;
        let level = 0;
        if (moduleNode.type === "relative_import") {
          level = (moduleNode.namedChildren.find((c) => c?.type === "import_prefix")?.text ?? "").length;
          module = moduleNode.namedChildren.find((c) => c?.type === "dotted_name")?.text ?? "";
        }
        for (const child of node.childrenForFieldName("name")) {
          if (!child) continue;
          const name = child.type === "aliased_import" ? (child.childForFieldName("name")?.text ?? "") : child.text;
          const local = child.type === "aliased_import" ? (child.childForFieldName("alias")?.text ?? name) : name;
          const [r] = resolvePython({ module, level, names: [name] }, file.path, allPaths);
          if (r?.kind !== "internal") continue;
          // `from pkg import mod` brings in a module; `from mod import fn` brings in a name.
          const isModule = r.to.endsWith(`/${name}.py`) || r.to === `${name}.py` || r.to.endsWith(`${name}/__init__.py`);
          bindings.set(local, { file: r.to, imported: isModule ? null : name });
        }
      } else if (node.type === "import_statement") {
        for (const child of node.childrenForFieldName("name")) {
          if (!child) continue;
          const module = child.type === "aliased_import" ? (child.childForFieldName("name")?.text ?? "") : child.text;
          const local = child.type === "aliased_import" ? (child.childForFieldName("alias")?.text ?? module) : module;
          const [r] = resolvePython({ module, level: 0, names: [] }, file.path, allPaths);
          if (r?.kind === "internal") bindings.set(local, { file: r.to, imported: null });
        }
      }
    } else if (node.type === "import_statement") {
      const source = node.childForFieldName("source");
      if (source?.type !== "string") continue;
      const r = resolveJs(source.text.slice(1, -1), file.path, allPaths);
      if (r.kind !== "internal") continue;
      const clause = node.namedChildren.find((c) => c?.type === "import_clause");
      for (const part of clause?.namedChildren ?? []) {
        if (!part) continue;
        if (part.type === "identifier") bindings.set(part.text, { file: r.to, imported: "default" });
        if (part.type === "namespace_import") {
          const local = part.namedChildren.find((c) => c?.type === "identifier")?.text;
          if (local) bindings.set(local, { file: r.to, imported: null });
        }
        if (part.type === "named_imports") {
          for (const spec of part.namedChildren) {
            if (spec?.type !== "import_specifier") continue;
            const name = spec.childForFieldName("name")?.text ?? "";
            bindings.set(spec.childForFieldName("alias")?.text ?? name, { file: r.to, imported: name });
          }
        }
      }
    }
  }
  return bindings;
}

/** Visits every node (without recursion, so deep code can't overflow the stack). */
function* walk(root: Node): Generator<Node> {
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    yield node;
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
}

/** Reads one file: its functions, classes, imports and the calls inside each function. */
export async function readCodeFile(file: SourceFile, allPaths: Set<string>): Promise<FileFacts | null> {
  const spec = LANGUAGES[file.language];
  if (!spec || !CODE_LANGUAGES.has(file.language)) return null;
  const parser = await getParser(file.language, spec);
  const tree = parser.parse(file.text);
  if (!tree) return null;
  try {
    const facts: FileFacts = { file: file.path, functions: [], topLevel: new Map(), classes: new Map(), bindings: new Map(), calls: [] };
    facts.bindings = readBindings(tree.rootNode, file, allPaths);
    const isTest = isTestFile(file.path);
    const usedIds = new Set<string>();
    const topLevelId = `${file.path}#(top level)`;
    let topLevelUsed = false;
    const objectsMade = new Map<string, Map<string, string>>(); // function → (variable → class it was made from)

    // Walk with context: the function we're inside (calls belong to it), the class we're inside
    // (for this./self. calls), whether we're directly in a class body (a function there is a method),
    // and the qualified-name prefix ("Agent" → "Agent.remember").
    type Frame = { node: Node; fn: string | null; cls: ClassInfo | null; inClassBody: boolean; prefix: string };
    const stack: Frame[] = [{ node: tree.rootNode, fn: null, cls: null, inClassBody: false, prefix: "" }];
    while (stack.length) {
      const { node, fn, cls, inClassBody, prefix } = stack.pop()!;
      let child: Omit<Frame, "node"> = { fn, cls, inClassBody: false, prefix };

      if (node.type === "class_declaration" || node.type === "class_definition") {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          const info: ClassInfo = { name, file: file.path, bases: baseClasses(node), methods: new Map() };
          facts.classes.set(name, info);
          child = { fn, cls: info, inClassBody: true, prefix: prefix ? `${prefix}.${name}` : name };
        }
      } else if (inClassBody && ["class_body", "block", "decorated_definition"].includes(node.type)) {
        child = { fn, cls, inClassBody: true, prefix }; // the body (or a @decorator wrapper): still directly in the class
      }

      const defName = definitionName(node);
      if (defName) {
        const qualified = prefix ? `${prefix}.${defName}` : defName;
        let id = `${file.path}#${qualified}`;
        if (usedIds.has(id)) id += `:${node.startPosition.row + 1}`; // two functions with the same name
        usedIds.add(id);
        const kind = inClassBody && cls ? "method" : "function";
        facts.functions.push({
          id, name: defName, qualified, file: file.path,
          line: node.startPosition.row + 1, endLine: node.endPosition.row + 1, kind, isTest,
        });
        if (kind === "method") cls!.methods.set(defName, id);
        else if (fn === null) facts.topLevel.set(defName, id); // not inside another function
        if (node.parent?.type === "export_statement" && node.parent.text.startsWith("export default")) facts.defaultExport = defName;
        child = { fn: id, cls, inClassBody: false, prefix: qualified }; // its body: calls belong to it
      }

      const made = createdObject(node);
      if (made) {
        const scope = fn ?? topLevelId;
        if (!objectsMade.has(scope)) objectsMade.set(scope, new Map());
        objectsMade.get(scope)!.set(made[0], made[1]);
      }

      if (node.type === "call_expression" || node.type === "call" || node.type === "new_expression") {
        const call = readCall(node);
        if (call) {
          const from = fn ?? topLevelId;
          if (from === topLevelId) topLevelUsed = true;
          const objectClass = call.object ? objectsMade.get(from)?.get(call.object) : undefined;
          facts.calls.push({ from, cls: cls?.name, line: node.startPosition.row + 1, ...call, objectClass });
        }
      }

      for (let i = node.namedChildCount - 1; i >= 0; i--) {
        const c = node.namedChild(i);
        if (c) stack.push({ node: c, ...child });
      }
    }

    if (topLevelUsed) {
      facts.functions.push({
        id: topLevelId, name: "(top level)", qualified: "(top level)", file: file.path,
        line: 1, endLine: file.text.split("\n").length, kind: "top-level", isTest,
      });
    }
    return facts;
  } finally {
    tree.delete(); // free the tree's memory inside the WASM module
  }
}

// ---------- Step 2: match calls to functions ----------

/** Builds the call graph from a repo's files. No network or disk, so it's easy to test. */
export async function buildCallGraph(files: SourceFile[], meta: { repoId: string; commitSha: string }): Promise<CallGraph> {
  const allPaths = new Set(files.map((f) => f.path));
  const byFile = new Map<string, FileFacts>();
  for (const file of files) {
    const facts = await readCodeFile(file, allPaths);
    if (facts) byFile.set(file.path, facts);
  }
  const functions = [...byFile.values()].flatMap((f) => f.functions);
  const fnById = new Map(functions.map((f) => [f.id, f]));
  // Methods by name, for "possible" matches: method name → ids
  const methodsByName = new Map<string, string[]>();
  for (const facts of byFile.values()) {
    for (const cls of facts.classes.values()) {
      for (const [name, id] of cls.methods) methodsByName.set(name, [...(methodsByName.get(name) ?? []), id]);
    }
  }

  /** A class by name, as seen from a file: defined there, or imported into it. */
  const classFrom = (file: string, name: string): ClassInfo | null => {
    const facts = byFile.get(file);
    if (!facts) return null;
    const local = facts.classes.get(name);
    if (local) return local;
    const b = facts.bindings.get(name);
    if (b?.imported) return byFile.get(b.file)?.classes.get(b.imported === "default" ? (byFile.get(b.file)?.defaultExport ?? "") : b.imported) ?? null;
    return null;
  };

  /** A method in a class or, if it's not there, in its parent classes (up to 5 levels). */
  const methodOf = (cls: ClassInfo | null, method: string, depth = 0): string | null => {
    if (!cls || depth > 5) return null;
    const own = cls.methods.get(method);
    if (own) return own;
    for (const base of cls.bases) {
      const found = methodOf(classFrom(cls.file, base), method, depth + 1);
      if (found) return found;
    }
    return null;
  };

  /** A function or class constructor called by plain name, as defined in (or exported from) a file. */
  const namedIn = (file: string, name: string): string | null => {
    const facts = byFile.get(file);
    if (!facts) return null;
    const target = name === "default" ? facts.defaultExport : name;
    if (!target) return null;
    const fn = facts.topLevel.get(target);
    if (fn) return fn;
    const cls = facts.classes.get(target);
    return cls ? (methodOf(cls, "constructor") ?? methodOf(cls, "__init__")) : null;
  };

  const edges = new Map<string, CallEdge>();
  const stats = { calls: 0, certain: 0, possible: 0, dropped: 0 };
  const addEdge = (from: string, to: string, line: number, certain: boolean) => {
    if (from === to && !certain) return; // a guessed call to itself is almost always wrong
    const key = `${from}\n${to}`;
    const edge = edges.get(key);
    if (edge) {
      edge.count++;
      edge.certain ||= certain;
      edge.line = Math.min(edge.line, line);
    } else edges.set(key, { from, to, line, count: 1, certain });
  };

  for (const facts of byFile.values()) {
    for (const call of facts.calls) {
      stats.calls++;
      const callerClass = call.cls ? (facts.classes.get(call.cls) ?? null) : null;
      let target: string | null = null;

      if (!call.object) {
        // foo(): same file, else imported
        target = namedIn(facts.file, call.name);
        const b = facts.bindings.get(call.name);
        if (!target && b?.imported) target = namedIn(b.file, b.imported);
      } else if (call.object === "this" || call.object === "self" || call.object === "cls") {
        target = methodOf(callerClass, call.name);
      } else if (call.object === "super") {
        for (const base of callerClass?.bases ?? []) target ??= methodOf(classFrom(facts.file, base), call.name);
      } else {
        const b = facts.bindings.get(call.object);
        if (call.objectClass) target = methodOf(classFrom(facts.file, call.objectClass), call.name); // bot = ChatbotAgent(); bot.respond()
        else if (b && b.imported === null) target = namedIn(b.file, call.name); // module.fn()
        else target = methodOf(classFrom(facts.file, call.object), call.name); // Class.staticMethod()
      }

      if (target) {
        addEdge(call.from, target, call.line, true);
        stats.certain++;
        continue;
      }

      // obj.method() with an unknown obj: a "possible" match, only among nearby methods with that name.
      if (call.object && call.object !== "super" && !COMMON_METHODS.has(call.name)) {
        const nearby = new Set([facts.file, ...[...facts.bindings.values()].map((b) => b.file)]);
        const candidates = (methodsByName.get(call.name) ?? []).filter((id) => nearby.has(fnById.get(id)!.file));
        if (candidates.length > 0 && candidates.length <= MAX_POSSIBLE) {
          for (const id of candidates) addEdge(call.from, id, call.line, false);
          stats.possible++;
          continue;
        }
      }
      stats.dropped++;
    }
  }

  return {
    repoId: meta.repoId,
    commitSha: meta.commitSha,
    generatedAt: new Date().toISOString(),
    functions,
    edges: [...edges.values()],
    stats,
  };
}
