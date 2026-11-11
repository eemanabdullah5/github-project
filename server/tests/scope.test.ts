// Tests for "Ask about one folder" (Phase 2): tidying, checking and filtering the scope. No network.
import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { listFolders, normalizeScope, resolveScope, scopeFilter } from "../src/scope.js";

const fileTree = ["README.md", "server/src/app.ts", "server/src/chunking/index.ts", "server/tests/app.test.ts", "web/src/api.ts", "it's/odd.py"].join("\n");

describe("normalizeScope", () => {
  it("tidies slashes, dots and spaces into a plain repo path", () => {
    expect(normalizeScope("  ./server/src/ ")).toBe("server/src");
    expect(normalizeScope("/server//src")).toBe("server/src");
    expect(normalizeScope("server\\src")).toBe("server/src");
  });

  it("treats empty or non-text values as the whole repo", () => {
    expect(normalizeScope("")).toBe("");
    expect(normalizeScope("/")).toBe("");
    expect(normalizeScope(undefined)).toBe("");
    expect(normalizeScope({ path: "server" })).toBe("");
  });
});

describe("listFolders", () => {
  it("lists every folder that holds an indexed file, including parent folders", () => {
    expect(listFolders(fileTree)).toEqual(["it's", "server", "server/src", "server/src/chunking", "server/tests", "web", "web/src"]);
  });
});

describe("resolveScope", () => {
  it("recognises folders and files from the index", () => {
    expect(resolveScope("server/src", fileTree)).toEqual({ kind: "folder", path: "server/src" });
    expect(resolveScope("./web/src/api.ts", fileTree)).toEqual({ kind: "file", path: "web/src/api.ts" });
    expect(resolveScope("", fileTree)).toBeNull();
  });

  it("only matches whole folder names, not the start of one", () => {
    // "server/sr" is the start of "server/src", but isn't a folder.
    expect(() => resolveScope("server/sr", fileTree)).toThrow(AppError);
  });

  it("rejects paths that aren't in the index with a 400 and a clear message", () => {
    try {
      resolveScope("../../etc", fileTree);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(400);
      expect((err as AppError).message).toContain("isn't a folder or file in this repo's index");
    }
    expect(() => resolveScope("x".repeat(600), fileTree)).toThrow("too long");
  });
});

describe("scopeFilter", () => {
  it("matches a folder by exact prefix and a file exactly", () => {
    expect(scopeFilter({ kind: "folder", path: "server/src" })).toBe("starts_with(path, 'server/src/')");
    expect(scopeFilter({ kind: "file", path: "web/src/api.ts" })).toBe("path = 'web/src/api.ts'");
  });

  it("escapes quotes, so a path can't break out of the filter", () => {
    expect(scopeFilter({ kind: "folder", path: "it's" })).toBe("starts_with(path, 'it''s/')");
  });
});
