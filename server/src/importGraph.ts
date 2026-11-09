// Import graph (Phase 4, first feature): which file in a repo imports which.
// For each Python, JavaScript and TypeScript file:
//  1. tree-sitter (already used for chunking) finds the import statements
//  2. importResolvers.ts turns each one into a repo file, an outside package, or a language built-in
// The result is a list of arrows (file → file), the outside packages, and the imports we couldn't match.
// It's built at the end of indexing (no AI, a few seconds) and saved in data/graphs/<owner>__<repo>.json.
// For repos indexed before this feature, it's built the first time it's asked for.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Node } from "web-tree-sitter";
import { getParser } from "./chunking/syntaxChunker.js";
import { LANGUAGES } from "./chunking/languages.js";
import { DATA_DIR } from "./config.js";
import { AppError } from "./errors.js";
import { downloadZipball } from "./githubClient.js";
import { resolveJs, resolvePython, type PythonImport, type Resolution } from "./importResolvers.js";
import { extractSourceFiles } from "./ingestion.js";
import type { GraphSummary, ImportEdge, ImportGraph, SourceFile, UnresolvedImport } from "./types.js";
import { loadManifest } from "./vectorStore.js";

const GRAPHS_DIR = path.join(DATA_DIR, "graphs");

/** The languages the graph reads in this first version. */
const GRAPH_LANGUAGES = new Set(["python", "javascript", "typescript", "tsx"]);

/** One import as written in the code, before it is matched to a file. */
interface FoundImport {
  line: number;
  python?: PythonImport; // for Python files
  specifier?: string; // for JS/TS files, e.g. "./rag.js"
}

/** Visits every node in the tree (without recursion, so very deep code can't overflow the stack). */
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

/** The text of a string literal without its quotes: `"./rag.js"` → `./rag.js`. Null for template strings. */
function stringValue(node: Node | null): string | null {
  if (!node || node.type !== "string") return null;
  return node.text.slice(1, -1);
}

/** The module name in `x` or `x as y`. */
function importedName(node: Node): string {
  return node.type === "aliased_import" ? (node.childForFieldName("name")?.text ?? "") : node.text;
}

/** Finds Python imports: `import a.b`, `import a as b`, `from .x import y`, `from a import *`. */
function pythonImports(root: Node): FoundImport[] {
  const found: FoundImport[] = [];
  for (const node of walk(root)) {
    const line = node.startPosition.row + 1;
    if (node.type === "import_statement") {
      for (const child of node.childrenForFieldName("name")) {
        if (child) found.push({ line, python: { module: importedName(child), level: 0, names: [] } });
      }
    } else if (node.type === "import_from_statement") {
      const moduleNode = node.childForFieldName("module_name");
      if (!moduleNode) continue;
      let module = moduleNode.text;
      let level = 0;
      if (moduleNode.type === "relative_import") {
        const prefix = moduleNode.namedChildren.find((c) => c?.type === "import_prefix")?.text ?? "";
        level = prefix.length; // one dot per level
        module = moduleNode.namedChildren.find((c) => c?.type === "dotted_name")?.text ?? "";
      }
      const names = node.childrenForFieldName("name").flatMap((c) => (c ? [importedName(c)] : []));
      found.push({ line, python: { module, level, names } });
    }
  }
  return found;
}

/** Finds JS/TS imports: `import … from "x"`, `export … from "x"`, `require("x")`, `import("x")`, `import x = require("x")`. */
function jsImports(root: Node): FoundImport[] {
  const found: FoundImport[] = [];
  for (const node of walk(root)) {
    let specifier: string | null = null;
    if (node.type === "import_statement" || node.type === "export_statement" || node.type === "import_require_clause") {
      specifier = stringValue(node.childForFieldName("source"));
    } else if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      const isRequire = fn?.type === "identifier" && fn.text === "require";
      if (isRequire || fn?.type === "import") {
        specifier = stringValue(node.childForFieldName("arguments")?.namedChild(0) ?? null);
      }
    }
    if (specifier) found.push({ line: node.startPosition.row + 1, specifier });
  }
  return found;
}

/** Reads the imports of one file. Files in other languages return an empty list. */
export async function findImports(file: SourceFile): Promise<FoundImport[]> {
  const spec = LANGUAGES[file.language];
  if (!spec || !GRAPH_LANGUAGES.has(file.language)) return [];
  const parser = await getParser(file.language, spec);
  const tree = parser.parse(file.text);
  if (!tree) return [];
  try {
    // tree-sitter still gives a usable tree for files with small syntax errors, so we read it anyway.
    return file.language === "python" ? pythonImports(tree.rootNode) : jsImports(tree.rootNode);
  } finally {
    tree.delete(); // free the tree's memory inside the WASM module
  }
}

/** Builds the graph from a repo's files. No network or disk, so it's easy to test. */
export async function buildImportGraph(files: SourceFile[], meta: { repoId: string; commitSha: string }): Promise<ImportGraph> {
  const allPaths = new Set(files.map((f) => f.path));
  const codeFiles = files.filter((f) => GRAPH_LANGUAGES.has(f.language));
  const edges = new Map<string, ImportEdge>(); // "from → to" → the first import seen for that pair
  const external = new Map<string, Set<string>>(); // package → files that use it
  const unresolved: UnresolvedImport[] = [];
  const stats = { imports: 0, internal: 0, external: 0, builtin: 0, unresolved: 0 };

  for (const file of codeFiles) {
    for (const imp of await findImports(file)) {
      const results: Resolution[] = imp.python
        ? resolvePython(imp.python, file.path, allPaths)
        : [resolveJs(imp.specifier!, file.path, allPaths)];
      for (const r of results) {
        stats.imports++;
        stats[r.kind]++;
        if (r.kind === "internal") {
          const key = `${file.path} → ${r.to}`;
          if (r.to !== file.path && !edges.has(key)) edges.set(key, { from: file.path, to: r.to, line: imp.line });
        } else if (r.kind === "external") {
          if (!external.has(r.name)) external.set(r.name, new Set());
          external.get(r.name)!.add(file.path);
        } else if (r.kind === "unresolved") {
          const written = imp.python ? ".".repeat(imp.python.level) + imp.python.module : imp.specifier!;
          unresolved.push({ from: file.path, specifier: written, line: imp.line });
        }
      }
    }
  }

  return {
    repoId: meta.repoId,
    commitSha: meta.commitSha,
    generatedAt: new Date().toISOString(),
    files: codeFiles.map((f) => f.path),
    edges: [...edges.values()],
    external: [...external]
      .map(([name, users]) => ({ name, files: [...users].sort() }))
      .sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name)),
    unresolved,
    stats,
  };
}

/** The top-level folder of a path, or "(root)" for files at the top of the repo. */
function topFolder(filePath: string): string {
  return filePath.includes("/") ? filePath.split("/")[0] : "(root)";
}

/** Short facts from the graph: coverage, most depended-on files, files nothing imports, links between folders. */
export function summarizeGraph(graph: ImportGraph, top = 10): GraphSummary {
  const importedBy = new Map<string, number>();
  for (const e of graph.edges) importedBy.set(e.to, (importedBy.get(e.to) ?? 0) + 1);

  const folders = new Map<string, number>();
  for (const e of graph.edges) {
    const from = topFolder(e.from);
    const to = topFolder(e.to);
    if (from !== to) folders.set(`${from}\n${to}`, (folders.get(`${from}\n${to}`) ?? 0) + 1);
  }

  const lookedInternal = graph.stats.internal + graph.stats.unresolved;
  return {
    coverage: lookedInternal === 0 ? null : graph.stats.internal / lookedInternal,
    mostImported: [...importedBy]
      .map(([p, n]) => ({ path: p, importedBy: n }))
      .sort((a, b) => b.importedBy - a.importedBy || a.path.localeCompare(b.path))
      .slice(0, top),
    notImported: graph.files.filter((f) => !importedBy.has(f)),
    folderLinks: [...folders]
      .map(([key, count]) => {
        const [from, to] = key.split("\n");
        return { from, to, count };
      })
      .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from)),
  };
}

// ---------- Saving and loading ----------

/** Where a repo's graph is saved, e.g. data/graphs/octo__hello.json */
function graphPath(repoId: string): string {
  return path.join(GRAPHS_DIR, `${repoId.replace("/", "__")}.json`);
}

/** Reads a repo's saved graph, or returns null if there isn't one yet. */
export async function loadGraph(repoId: string): Promise<ImportGraph | null> {
  try {
    return JSON.parse(await readFile(graphPath(repoId), "utf8")) as ImportGraph;
  } catch {
    return null;
  }
}

/** Saves a repo's graph to disk. */
export async function saveGraph(graph: ImportGraph): Promise<void> {
  await mkdir(GRAPHS_DIR, { recursive: true });
  await writeFile(graphPath(graph.repoId), JSON.stringify(graph));
}

/** Repos whose graph is being built right now, so the same one isn't built twice at once. */
const building = new Map<string, Promise<ImportGraph>>();

/**
 * Returns the graph for the repo's indexed commit. If there's no saved graph, or it was built
 * from an older commit, downloads the code at the indexed commit and builds it now (a few seconds).
 */
export async function getGraph(owner: string, repo: string, repoId: string): Promise<ImportGraph> {
  const manifest = await loadManifest(repoId);
  if (!manifest) throw new AppError("This repo hasn't been indexed yet. Index it first.", 404);
  const saved = await loadGraph(repoId);
  if (saved && saved.commitSha === manifest.commitSha) return saved;

  let job = building.get(repoId);
  if (!job) {
    job = (async () => {
      const files = extractSourceFiles(await downloadZipball(owner, repo, manifest.commitSha));
      const graph = await buildImportGraph(files, { repoId, commitSha: manifest.commitSha });
      await saveGraph(graph);
      return graph;
    })().finally(() => building.delete(repoId));
    building.set(repoId, job);
  }
  return job;
}
