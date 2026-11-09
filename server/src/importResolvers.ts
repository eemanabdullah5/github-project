// Import graph (Phase 4): the per-language rules that turn an import into a file in the repo.
// Example: in tests/test_agents.py, `from agents import X` → agents.py
//          in server/src/app.ts,   `import … from "./rag.js"` → server/src/rag.ts
// If the import isn't a file in the repo, it's a package from outside (external) or part of the
// language itself (builtin, e.g. Python's `os` or Node's `fs`). If it looks like a repo file but no
// file matches, it's "unresolved", and we count it so the graph is honest about what it missed.
// Pure path logic: no parsing, network or disk (importGraph.ts reads the imports from the code).
import path from "node:path";

/** Where one import points. */
export type Resolution =
  | { kind: "internal"; to: string } // a file in this repo
  | { kind: "external"; name: string } // a package from outside, e.g. "react", "pytest"
  | { kind: "builtin"; name: string } // part of the language, e.g. "os", "fs"
  | { kind: "unresolved" }; // looks like a repo file, but no file matches

/** A Python import, as read from the code. */
export interface PythonImport {
  module: string; // "app.auth" in `from app.auth import x`; "" in `from . import x`
  level: number; // number of leading dots: 0 = absolute, 1 = `from .x`, 2 = `from ..x`
  names: string[]; // ["x"] in `from app.auth import x`; [] for `import app.auth` and `import *`
}

const posix = path.posix;

// ---------- Python ----------

/** Python's standard library (the common modules), so `import os` isn't listed as an outside package. */
const PYTHON_STDLIB = new Set(
  (
    "__future__ abc argparse array ast asyncio atexit base64 binascii bisect builtins bz2 calendar cmath cmd code codecs " +
    "collections colorsys concurrent configparser contextlib contextvars copy cProfile csv ctypes curses dataclasses datetime " +
    "dbm decimal difflib dis doctest email encodings enum errno faulthandler filecmp fileinput fnmatch fractions ftplib " +
    "functools gc getopt getpass gettext glob graphlib gzip hashlib heapq hmac html http imaplib importlib inspect io " +
    "ipaddress itertools json keyword linecache locale logging lzma mailbox math mimetypes mmap multiprocessing netrc " +
    "numbers operator optparse os pathlib pdb pickle pkgutil platform plistlib poplib posixpath pprint profile pstats " +
    "pty pwd py_compile queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors " +
    "shelve shlex shutil signal site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep struct " +
    "subprocess symtable sys sysconfig tabnanny tarfile tempfile termios textwrap threading time timeit tkinter token " +
    "tokenize tomllib trace traceback tracemalloc tty turtle types typing unicodedata unittest urllib uuid venv warnings " +
    "wave weakref webbrowser winreg winsound wsgiref xml xmlrpc zipapp zipfile zipimport zlib zoneinfo"
  ).split(" "),
);

/** The two files a Python module can be: `a/b.py` or the package `a/b/__init__.py`. */
function pythonModuleFile(base: string, dotted: string, files: Set<string>): string | null {
  const stem = posix.join(base, ...dotted.split("."));
  for (const candidate of [`${stem}.py`, `${stem}/__init__.py`]) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Folders an absolute Python import is looked up from, best first:
 * the importing file's own folder and each folder above it (how scripts and tests usually run),
 * then the repo root, then `src/` (a common layout).
 */
function pythonSearchRoots(from: string): string[] {
  const roots: string[] = [];
  let dir = posix.dirname(from);
  while (dir !== "." && dir !== "/") {
    roots.push(dir);
    dir = posix.dirname(dir);
  }
  roots.push("", "src");
  return roots;
}

/**
 * For `from a.b import c`, c can be a module (a/b/c.py) or a name inside a/b.py.
 * Tries each name as a module first, then the module itself. Returns the files found.
 */
function findFromImport(base: string, module: string, names: string[], files: Set<string>): string[] {
  const found = new Set<string>();
  for (const name of names) {
    const sub = pythonModuleFile(base, module ? `${module}.${name}` : name, files);
    if (sub) found.add(sub);
  }
  if (found.size === 0 && module) {
    const file = pythonModuleFile(base, module, files);
    if (file) found.add(file);
  }
  return [...found];
}

/** Resolves one Python import statement. Can point to several files (`from . import a, b`). */
export function resolvePython(imp: PythonImport, from: string, files: Set<string>): Resolution[] {
  const internal = (paths: string[]): Resolution[] => paths.map((to) => ({ kind: "internal", to }));

  // Relative: `from .x import y` starts in the importing file's folder; each extra dot goes up one folder.
  if (imp.level > 0) {
    let base = posix.dirname(from);
    for (let i = 1; i < imp.level; i++) base = posix.dirname(base);
    if (base.startsWith("..")) return [{ kind: "unresolved" }];
    base = base === "." ? "" : base;
    let found = findFromImport(base, imp.module, imp.names, files);
    // `from . import x` where x is a name in the folder's __init__.py
    if (found.length === 0 && !imp.module && files.has(posix.join(base, "__init__.py"))) found = [posix.join(base, "__init__.py")];
    return found.length ? internal(found) : [{ kind: "unresolved" }];
  }

  // Absolute: try each search root until one has the module.
  for (const root of pythonSearchRoots(from)) {
    const found = imp.names.length
      ? findFromImport(root, imp.module, imp.names, files)
      : [pythonModuleFile(root, imp.module, files)].filter((f): f is string => f !== null);
    if (found.length) return internal(found);
  }

  const top = imp.module.split(".")[0];
  if (PYTHON_STDLIB.has(top)) return [{ kind: "builtin", name: top }];
  // A folder or file with that name exists in the repo, so it's probably ours but we couldn't match it.
  const looksLocal = [...files].some((f) => f === `${top}.py` || f.startsWith(`${top}/`) || f.includes(`/${top}/`) || f.endsWith(`/${top}.py`));
  return [looksLocal ? { kind: "unresolved" } : { kind: "external", name: top }];
}

// ---------- JavaScript / TypeScript ----------

/** Node's built-in modules, so `import fs from "fs"` isn't listed as an outside package. */
const NODE_BUILTINS = new Set(
  (
    "assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events " +
    "fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream " +
    "string_decoder sys test timers tls trace_events tty url util v8 vm wasi worker_threads zlib"
  ).split(" "),
);

/** Extensions tried when an import leaves them out (`./rag` → `./rag.ts`, `./rag.js`…). */
const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".d.ts"];

/** In TypeScript, `./rag.js` usually means the file `./rag.ts` (it becomes .js after compiling). */
const COMPILED_TO_SOURCE: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

/** Finds the repo file a path points to: exact, TS source of a .js path, added extension, or a folder's index file. */
function findJsFile(target: string, files: Set<string>): string | null {
  const candidates = [target];
  const ext = posix.extname(target);
  for (const sourceExt of COMPILED_TO_SOURCE[ext] ?? []) candidates.push(target.slice(0, -ext.length) + sourceExt);
  for (const e of JS_EXTENSIONS) candidates.push(target + e);
  for (const e of JS_EXTENSIONS) candidates.push(`${target}/index${e}`);
  return candidates.find((c) => files.has(c)) ?? null;
}

/** The package name of a bare import: "react-dom/client" → "react-dom", "@scope/pkg/x" → "@scope/pkg". */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Resolves one JS/TS import, e.g. "./rag.js", "../api", "react", "node:fs", "@/utils". */
export function resolveJs(specifier: string, from: string, files: Set<string>): Resolution {
  if (specifier.startsWith("node:")) return { kind: "builtin", name: specifier.slice(5).split("/")[0] };

  // Relative to the importing file, or (with a leading /) to the repo root.
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const target = specifier.startsWith("/") ? posix.normalize(specifier.slice(1)) : posix.join(posix.dirname(from), specifier);
    if (target.startsWith("..")) return { kind: "unresolved" };
    const to = findJsFile(target, files);
    return to ? { kind: "internal", to } : { kind: "unresolved" };
  }

  // Common path aliases: "@/x" and "~/x" usually mean src/x (set in tsconfig or the bundler).
  // We don't read those settings yet, so we try src/ and the root, and count a miss as unresolved.
  if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
    const rest = specifier.slice(2);
    const to = findJsFile(`src/${rest}`, files) ?? findJsFile(rest, files);
    return to ? { kind: "internal", to } : { kind: "unresolved" };
  }

  const name = packageName(specifier);
  return NODE_BUILTINS.has(name) ? { kind: "builtin", name } : { kind: "external", name };
}
