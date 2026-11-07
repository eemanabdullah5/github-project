// Tests for ingestion. Small zips are built inside the test with fflate.
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MAX_FILE_BYTES, MAX_FILES } from "../src/config.js";
import { checkRepoSize, detectLanguage, extractSourceFiles, isSkippedPath, redactSecrets } from "../src/ingestion.js";
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

  it.each([".env", "api/.env", ".env.local", ".env.production", "certs/server.pem", "tls.key", "keys/id_rsa", ".npmrc", "store.p12"])(
    "skips secret file %s",
    (path) => {
      expect(isSkippedPath(path)).toBe(true);
    },
  );

  it.each(["src/index.ts", "README.md", "Dockerfile", "config/app.yaml", "src/build.ts", "docs/env.md", ".env.example", ".env.sample", "src/env.ts", "keyboard.ts"])("keeps %s", (path) => {
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

describe("redactSecrets", () => {
  // Fake keys are assembled from pieces so this test file doesn't look like it holds real secrets.
  const fakes: Array<[string, string]> = [
    ["ghp_" + "a".repeat(36), "GITHUB TOKEN"],
    ["github_pat_" + "B".repeat(60), "GITHUB TOKEN"],
    ["AIza" + "c".repeat(35), "GOOGLE API KEY"],
    ["AKIA" + "D".repeat(16), "AWS KEY"],
    ["xoxb-" + "1".repeat(20), "SLACK TOKEN"],
    ["sk_live_" + "e".repeat(24), "STRIPE KEY"],
    ["sk-proj-" + "f".repeat(40), "API KEY"],
  ];

  it.each(fakes)("masks %s", (secret, label) => {
    expect(redactSecrets(`const key = "${secret}";`)).toBe(`const key = "[REDACTED ${label}]";`);
  });

  it("masks a private key block but keeps its line breaks", () => {
    const begin = "-----BEGIN RSA " + "PRIVATE KEY-----";
    const end = "-----END RSA " + "PRIVATE KEY-----";
    const text = ["line 1", begin, "abc", "def", end, "line 6"].join("\n");
    const result = redactSecrets(text);
    expect(result.split("\n")).toHaveLength(6);
    expect(result.split("\n")[5]).toBe("line 6");
    expect(result).toContain("[REDACTED PRIVATE KEY]");
    expect(result).not.toContain("abc");
  });

  it("leaves normal code alone", () => {
    const code = 'const sky = "blue"; // ask-me-anything\nfunction getKey(id) { return keys[id]; }';
    expect(redactSecrets(code)).toBe(code);
  });

  it("is applied when files are extracted, and .env is skipped", () => {
    const files = extractSourceFiles(
      githubZip({ ".env": "SECRET=1", "src/config.ts": `export const KEY = "${"AIza" + "x".repeat(35)}";` }),
    );
    expect(files.map((f) => f.path)).toEqual(["src/config.ts"]);
    expect(files[0].text).toBe('export const KEY = "[REDACTED GOOGLE API KEY]";');
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
