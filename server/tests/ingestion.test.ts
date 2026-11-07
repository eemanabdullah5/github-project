// Tests for ingestion. Small zips are built inside the test with fflate.
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MAX_FILE_BYTES, MAX_FILES } from "../src/config.js";
import { checkRepoSize, detectLanguage, extractSourceFiles, isSkippedPath } from "../src/ingestion.js";
import type { Repo } from "../src/types.js";

/** Builds a zip that looks like GitHub's: everything inside one top folder. */
function githubZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    entries[`octo-hello-abc1234/${path}`] = typeof content === "string" ? strToU8(content) : content;
  }
  return zipSync(entries);
}

describe("isSkippedPath", () => {
  it.each([
    "node_modules/lodash/index.js",
    "src/node_modules/x.js",
    ".venv/lib/site.py",
    "dist/app.js",
    "build/out.txt",
    ".git/config",
    "pkg/__pycache__/a.pyc",
    "vendor/lib.go",
    "target/classes/A.class",
    ".next/server.js",
    "coverage/lcov.info",
    "package-lock.json",
    "web/yarn.lock",
    "pnpm-lock.yaml",
    "poetry.lock",
    "static/app.min.js",
    "static/site.min.css",
    "logo.PNG",
    "fonts/a.woff2",
    "release.zip",
    "tool.exe",
    "video.mp4",
  ])("skips %s", (path) => {
    expect(isSkippedPath(path)).toBe(true);
  });

  it.each(["src/index.ts", "README.md", "Dockerfile", "config/app.yaml", "src/build.ts", "docs/env.md"])("keeps %s", (path) => {
    expect(isSkippedPath(path)).toBe(false);
  });
});

describe("detectLanguage", () => {
  it("maps extensions", () => {
    expect(detectLanguage("a/b.py")).toBe("python");
    expect(detectLanguage("a/b.tsx")).toBe("tsx");
    expect(detectLanguage("Main.java")).toBe("java");
    expect(detectLanguage("Dockerfile")).toBe("text");
  });
});

describe("extractSourceFiles", () => {
  it("strips the top folder and keeps only useful text files", () => {
    const files = extractSourceFiles(
      githubZip({
        "README.md": "# Hello",
        "src/app.py": "print('hi')",
        "node_modules/x/index.js": "skip me",
        "package-lock.json": "{}",
        "image.png": "fake",
        "binary.dat": new Uint8Array([1, 0, 2]),
        "latin1.txt": new Uint8Array([0xff, 0xfe, 0x41]),
        "big.txt": "x".repeat(MAX_FILE_BYTES + 1),
      }),
    );
    expect(files.map((f) => f.path)).toEqual(["README.md", "src/app.py"]);
    expect(files[1]).toEqual({ path: "src/app.py", text: "print('hi')", language: "python" });
  });

  it("rejects too many files", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= MAX_FILES; i++) many[`f${i}.txt`] = "x";
    expect(() => extractSourceFiles(githubZip(many))).toThrow(/too many files/);
  });

  it("rejects too much text", () => {
    const big: Record<string, string> = {};
    const content = "x".repeat(MAX_FILE_BYTES - 10);
    for (let i = 0; i < 42; i++) big[`f${i}.txt`] = content; // ≈ 21 MB
    expect(() => extractSourceFiles(githubZip(big))).toThrow(/too much code/);
  });
});

describe("checkRepoSize", () => {
  const repo = { sizeKb: 0 } as Repo;
  it("allows small repos", () => {
    expect(() => checkRepoSize({ ...repo, sizeKb: 1000 })).not.toThrow();
  });
  it("rejects repos over 20 MB before downloading", () => {
    expect(() => checkRepoSize({ ...repo, sizeKb: 50_000 })).toThrow(/too large/);
  });
});
