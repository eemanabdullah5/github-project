// Tests for checkIndexStatus. GitHub and the vector store are replaced with fakes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Manifest } from "../src/types.js";

vi.mock("../src/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/config.js")>();
  return { ...real, config: { ...real.config, embedModel: "embed-a" } };
});
vi.mock("../src/githubClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/githubClient.js")>()),
  getRepo: vi.fn(async () => ({ defaultBranch: "main" })),
  getLatestCommitSha: vi.fn(async () => "sha-new"),
}));
vi.mock("../src/vectorStore.js", () => ({
  loadManifest: vi.fn(),
  saveIndex: vi.fn(),
}));

const { checkIndexStatus } = await import("../src/indexer.js");
const { loadManifest } = await import("../src/vectorStore.js");

const manifest = (overrides: Partial<Manifest>): Manifest => ({
  repoId: "octo/hello",
  commitSha: "sha-new",
  branch: "main",
  indexedAt: "2026-01-01T00:00:00Z",
  embedModel: "embed-a",
  fileCount: 1,
  chunkCount: 1,
  fileTree: "",
  readme: "",
  ...overrides,
});

beforeEach(() => vi.mocked(loadManifest).mockReset());

describe("checkIndexStatus", () => {
  it("is missing when there is no manifest", async () => {
    vi.mocked(loadManifest).mockResolvedValue(null);
    expect((await checkIndexStatus("Octo", "hello")).status).toBe("missing");
    expect(loadManifest).toHaveBeenCalledWith("octo/hello");
  });

  it("is fresh when the commit and model match", async () => {
    vi.mocked(loadManifest).mockResolvedValue(manifest({}));
    expect((await checkIndexStatus("octo", "hello")).status).toBe("fresh");
  });

  it("is stale when there are new commits", async () => {
    vi.mocked(loadManifest).mockResolvedValue(manifest({ commitSha: "sha-old" }));
    expect((await checkIndexStatus("octo", "hello")).status).toBe("stale");
  });

  it("is stale when the embedding model changed", async () => {
    vi.mocked(loadManifest).mockResolvedValue(manifest({ embedModel: "embed-b" }));
    expect((await checkIndexStatus("octo", "hello")).status).toBe("stale");
  });
});
