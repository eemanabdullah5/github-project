// Tests for Phase 3 folder summaries. The AI is replaced with fakes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceFile } from "../src/types.js";

vi.mock("../src/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/config.js")>();
  return { ...real, config: { ...real.config, chatModel: "chat-a", embedModel: "embed-a" } };
});
vi.mock("../src/llm.js", () => ({
  chat: vi.fn(),
  embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
}));

const { buildFolderSummaries, folderInput, parseSummaries, pickFolders, relevantSummaries } = await import("../src/folderSummaries.js");
const { chat, embedDocuments } = await import("../src/llm.js");

const file = (p: string, text = `code in ${p}`): SourceFile => ({ path: p, text, language: "typescript" });
const files = [
  file("README.md"),
  file("package.json"),
  file("src/auth/login.ts"),
  file("src/auth/session.ts"),
  file("src/db/client.ts"), // only 1 file: skipped
  file("web/a.tsx"),
  file("web/b.tsx"),
  file("web/c.tsx"),
];

/** A fake AI reply with one block per folder named in the request. */
function fakeReply(messages: Array<{ content: string }>): string {
  const folders = [...messages[1].content.matchAll(/<<<REPO FOLDER (.+?)>>>/g)].map((m) => m[1]);
  return folders.map((f) => `### ${f}\nSummary of ${f}.`).join("\n\n");
}

beforeEach(() => {
  vi.mocked(chat).mockReset().mockImplementation(async (m) => fakeReply(m));
  vi.mocked(embedDocuments).mockClear();
});

describe("pickFolders", () => {
  it("keeps folders with at least 2 files directly inside, skips the root", () => {
    expect(pickFolders(files).map((f) => f.path)).toEqual(["src/auth", "web"]);
  });
});

describe("folderInput", () => {
  it("lists the file names and stays within the size limit", () => {
    const big = { path: "web", files: [file("web/a.tsx", "x".repeat(10_000)), file("web/b.tsx")] };
    const text = folderInput(big);
    expect(text.startsWith("Files: a.tsx, b.tsx")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(3000);
  });
});

describe("parseSummaries", () => {
  it("reads each block and ignores folders that weren't asked for", () => {
    const reply = "### `src/auth/`\nHandles login.\n\n### other\nNope.\n\n## web\nThe UI.";
    const parsed = parseSummaries(reply, ["src/auth", "web"]);
    expect(Object.fromEntries(parsed)).toEqual({ "src/auth": "Handles login.", web: "The UI." });
  });

  it("drops <summary> tags if the AI adds them", () => {
    expect(parseSummaries("### web\n<summary>The UI.</summary>", ["web"]).get("web")).toBe("The UI.");
  });
});

describe("buildFolderSummaries", () => {
  const ctx = { repoId: "octo/hello", commitSha: "sha1" };

  it("summarizes and embeds each folder", async () => {
    const result = await buildFolderSummaries(files, ctx, null);
    expect(result.folders.map((f) => [f.path, f.summary])).toEqual([
      ["src/auth", "Summary of src/auth."],
      ["web", "Summary of web."],
    ]);
    expect(result.folders.every((f) => f.vector.length === 2)).toBe(true);
    expect(chat).toHaveBeenCalledTimes(1); // both folders in one AI call
  });

  it("re-index reuses unchanged folders and only summarizes changed ones", async () => {
    const first = await buildFolderSummaries(files, ctx, null);
    vi.mocked(chat).mockClear();
    vi.mocked(embedDocuments).mockClear();

    const changed = files.map((f) => (f.path === "web/a.tsx" ? file("web/a.tsx", "new code") : f));
    const second = await buildFolderSummaries(changed, ctx, first);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chat).mock.calls[0][0][1].content).not.toContain("src/auth");
    expect(vi.mocked(embedDocuments).mock.calls[0][0]).toHaveLength(1); // only web gets a new vector
    expect(second.folders).toHaveLength(2);
  });

  it("keeps what it has when an AI call fails", async () => {
    vi.mocked(chat).mockRejectedValue(new Error("rate limit"));
    const result = await buildFolderSummaries(files, ctx, null);
    expect(result.folders).toEqual([]);
  });
});

describe("relevantSummaries", () => {
  const summaryFile = {
    repoId: "octo/hello", commitSha: "sha1", chatModel: "chat-a", embedModel: "embed-a",
    folders: [
      { path: "src/auth", fileCount: 2, summary: "Login.", fingerprint: "a", vector: [1, 0] },
      { path: "web", fileCount: 3, summary: "The UI.", fingerprint: "b", vector: [0, 1] },
    ],
  };

  it("puts the closest folder first", () => {
    const text = relevantSummaries(summaryFile, [0.1, 1], null)!;
    expect(text.indexOf("web/")).toBeLessThan(text.indexOf("src/auth/"));
    expect(text).toContain("web/ (3 files): The UI.");
  });

  it("only uses folders inside, or containing, the chosen scope", () => {
    const text = relevantSummaries(summaryFile, [1, 1], { kind: "file", path: "src/auth/login.ts" })!;
    expect(text).toContain("src/auth/");
    expect(text).not.toContain("web/");
  });
});
