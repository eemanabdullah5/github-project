// Tests for the import graph (Phase 4): the per-language rules, reading imports with tree-sitter,
// building the graph and summarising it. No network.
import { describe, expect, it } from "vitest";
import { buildImportGraph, findImports, summarizeGraph } from "../src/importGraph.js";
import { resolveJs, resolvePython } from "../src/importResolvers.js";
import type { SourceFile } from "../src/types.js";

const files = (...paths: string[]) => new Set(paths);

describe("resolvePython", () => {
  const repo = files(
    "agents.py",
    "tests/test_agents.py",
    "Final_submission/agents.py",
    "Final_submission/test_agents.py",
    "app/__init__.py",
    "app/auth.py",
    "app/routes/__init__.py",
    "app/routes/users.py",
    "src/pkg/core.py",
  );
  const py = (module: string, level = 0, names: string[] = []) => ({ module, level, names });

  it("finds a module next to the importing file first (how scripts and tests run)", () => {
    expect(resolvePython(py("agents", 0, ["Agent"]), "Final_submission/test_agents.py", repo)).toEqual([{ kind: "internal", to: "Final_submission/agents.py" }]);
  });

  it("falls back to the repo root, then src/", () => {
    expect(resolvePython(py("agents", 0, ["Agent"]), "tests/test_agents.py", repo)).toEqual([{ kind: "internal", to: "agents.py" }]);
    expect(resolvePython(py("app.auth"), "app/routes/users.py", repo)).toEqual([{ kind: "internal", to: "app/auth.py" }]);
    expect(resolvePython(py("pkg.core"), "main.py", repo)).toEqual([{ kind: "internal", to: "src/pkg/core.py" }]);
  });

  it("handles packages (__init__.py) and `from package import module`", () => {
    expect(resolvePython(py("app.routes"), "main.py", repo)).toEqual([{ kind: "internal", to: "app/routes/__init__.py" }]);
    expect(resolvePython(py("app.routes", 0, ["users"]), "main.py", repo)).toEqual([{ kind: "internal", to: "app/routes/users.py" }]);
    expect(resolvePython(py("app", 0, ["login_required"]), "main.py", repo)).toEqual([{ kind: "internal", to: "app/__init__.py" }]);
  });

  it("follows relative imports: one dot is this folder, each extra dot goes up", () => {
    expect(resolvePython(py("auth", 2, ["x"]), "app/routes/users.py", repo)).toEqual([{ kind: "internal", to: "app/auth.py" }]);
    expect(resolvePython(py("", 1, ["users"]), "app/routes/__init__.py", repo)).toEqual([{ kind: "internal", to: "app/routes/users.py" }]);
    expect(resolvePython(py("missing", 1), "app/auth.py", repo)).toEqual([{ kind: "unresolved" }]);
    expect(resolvePython(py("x", 5), "app/auth.py", repo)).toEqual([{ kind: "unresolved" }]); // above the repo root
  });

  it("labels the standard library, outside packages, and unmatched local-looking imports", () => {
    expect(resolvePython(py("os.path"), "agents.py", repo)).toEqual([{ kind: "builtin", name: "os" }]);
    expect(resolvePython(py("pytest"), "agents.py", repo)).toEqual([{ kind: "external", name: "pytest" }]);
    expect(resolvePython(py("app.nothing_here"), "agents.py", repo)).toEqual([{ kind: "unresolved" }]);
  });
});

describe("resolveJs", () => {
  const repo = files("server/src/app.ts", "server/src/rag.ts", "web/src/api.ts", "web/src/views/Chat.tsx", "web/src/components/index.ts", "src/utils/format.js", "lib/old.js");

  it("finds the .ts source of a .js import, added extensions and folder index files", () => {
    expect(resolveJs("./rag.js", "server/src/app.ts", repo)).toEqual({ kind: "internal", to: "server/src/rag.ts" });
    expect(resolveJs("../api", "web/src/views/Chat.tsx", repo)).toEqual({ kind: "internal", to: "web/src/api.ts" });
    expect(resolveJs("./views/Chat", "web/src/api.ts", repo)).toEqual({ kind: "internal", to: "web/src/views/Chat.tsx" });
    expect(resolveJs("../components", "web/src/views/Chat.tsx", repo)).toEqual({ kind: "internal", to: "web/src/components/index.ts" });
    expect(resolveJs("./old.js", "lib/x.js", repo)).toEqual({ kind: "internal", to: "lib/old.js" });
  });

  it("tries src/ for @/ and ~/ aliases, and counts a miss as unresolved", () => {
    expect(resolveJs("@/utils/format", "src/app.js", repo)).toEqual({ kind: "internal", to: "src/utils/format.js" });
    expect(resolveJs("~/nope", "src/app.js", repo)).toEqual({ kind: "unresolved" });
    expect(resolveJs("./missing", "server/src/app.ts", repo)).toEqual({ kind: "unresolved" });
  });

  it("labels Node built-ins and outside packages by package name", () => {
    expect(resolveJs("node:fs/promises", "a.ts", repo)).toEqual({ kind: "builtin", name: "fs" });
    expect(resolveJs("path", "a.ts", repo)).toEqual({ kind: "builtin", name: "path" });
    expect(resolveJs("react-dom/client", "a.ts", repo)).toEqual({ kind: "external", name: "react-dom" });
    expect(resolveJs("@google/genai", "a.ts", repo)).toEqual({ kind: "external", name: "@google/genai" });
  });
});

const file = (path: string, language: string, text: string): SourceFile => ({ path, language, text });

describe("findImports (tree-sitter)", () => {
  it("reads every kind of Python import, with line numbers", async () => {
    const found = await findImports(
      file(
        "app/x.py",
        "python",
        ["import os, app.auth as auth", "from . import users", "from ..core import a, b as c", "from pkg import *", "def f():", "    import json"].join("\n"),
      ),
    );
    expect(found).toEqual([
      { line: 1, python: { module: "os", level: 0, names: [] } },
      { line: 1, python: { module: "app.auth", level: 0, names: [] } },
      { line: 2, python: { module: "", level: 1, names: ["users"] } },
      { line: 3, python: { module: "core", level: 2, names: ["a", "b"] } },
      { line: 4, python: { module: "pkg", level: 0, names: [] } },
      { line: 6, python: { module: "json", level: 0, names: [] } },
    ]);
  });

  it("reads JS/TS imports, re-exports, require() and import(), but not template strings", async () => {
    const code = [
      'import express from "express";',
      'import type { Chunk } from "./types.js";',
      'export { answer } from "./rag.js";',
      'const fs = require("fs");',
      'const lazy = await import("./lazy");',
      "const dynamic = require(`./${name}`);",
      'export const x = 1;',
    ].join("\n");
    const found = await findImports(file("src/a.ts", "typescript", code));
    expect(found.map((f) => [f.line, f.specifier])).toEqual([
      [1, "express"],
      [2, "./types.js"],
      [3, "./rag.js"],
      [4, "fs"],
      [5, "./lazy"],
    ]);
  });

  it("reads TSX files and ignores languages the graph doesn't cover yet", async () => {
    expect((await findImports(file("App.tsx", "tsx", 'import { api } from "./api";\nexport default () => <div />;'))).map((f) => f.specifier)).toEqual(["./api"]);
    expect(await findImports(file("Main.java", "java", "import java.util.List;"))).toEqual([]);
  });
});

describe("buildImportGraph and summarizeGraph", () => {
  const repoFiles = [
    file("agents.py", "python", "from abc import ABC\n"),
    file("demo.py", "python", "from agents import ChatbotAgent\nimport requests\n"),
    file("tests/test_agents.py", "python", "import pytest\nfrom agents import Agent\nfrom agents import ChatbotAgent\n"),
    file("tests/test_extra.py", "python", "import pytest\nfrom .helpers import h\n"),
    file("README.md", "markdown", "# hi"),
  ];

  it("builds one arrow per pair of files, plus packages, unresolved imports and counts", async () => {
    const graph = await buildImportGraph(repoFiles, { repoId: "o/r", commitSha: "abc" });
    expect(graph.files).toEqual(["agents.py", "demo.py", "tests/test_agents.py", "tests/test_extra.py"]);
    expect(graph.edges).toEqual([
      { from: "demo.py", to: "agents.py", line: 1 },
      { from: "tests/test_agents.py", to: "agents.py", line: 2 }, // imported twice, one arrow
    ]);
    expect(graph.external).toEqual([
      { name: "pytest", files: ["tests/test_agents.py", "tests/test_extra.py"] },
      { name: "requests", files: ["demo.py"] },
    ]);
    expect(graph.unresolved).toEqual([{ from: "tests/test_extra.py", specifier: ".helpers", line: 2 }]);
    expect(graph.stats).toEqual({ imports: 8, internal: 3, external: 3, builtin: 1, unresolved: 1 });
  });

  it("summarises coverage, most imported files, files nothing imports, and folder links", async () => {
    const summary = summarizeGraph(await buildImportGraph(repoFiles, { repoId: "o/r", commitSha: "abc" }));
    expect(summary.coverage).toBeCloseTo(3 / 4);
    expect(summary.mostImported).toEqual([{ path: "agents.py", importedBy: 2 }]);
    expect(summary.notImported).toEqual(["demo.py", "tests/test_agents.py", "tests/test_extra.py"]);
    expect(summary.folderLinks).toEqual([{ from: "tests", to: "(root)", count: 1 }]);
  });
});
