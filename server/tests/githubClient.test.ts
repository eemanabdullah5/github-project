// Tests for the GitHub client. fetch is mocked, so no network is used.
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubFetch, listAccessibleRepos, parseRepoUrl } from "../src/githubClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseRepoUrl", () => {
  it.each([
    ["https://github.com/octo/hello", "octo", "hello"],
    ["http://github.com/octo/hello", "octo", "hello"],
    ["github.com/octo/hello", "octo", "hello"],
    ["www.github.com/octo/hello", "octo", "hello"],
    ["octo/hello", "octo", "hello"],
    ["  octo/hello  ", "octo", "hello"],
    ["https://github.com/octo/hello.git", "octo", "hello"],
    ["https://github.com/octo/hello/tree/main/src", "octo", "hello"],
    ["https://github.com/octo/hello?tab=readme", "octo", "hello"],
    ["octo-cat/my.repo_name-1", "octo-cat", "my.repo_name-1"],
  ])("parses %s", (input, owner, repo) => {
    expect(parseRepoUrl(input)).toEqual({ owner, repo });
  });

  it.each(["", "octo", "octo/", "/hello", "-octo/hello", "octo--cat/hello", "oc to/hello", "octo/hel lo", "octo/..", "https://gitlab.com/octo/hello"])(
    "rejects %j",
    (input) => {
      expect(() => parseRepoUrl(input)).toThrow(/doesn't look like a GitHub repo/);
    },
  );
});

/** Builds a fake fetch Response. */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function fakeRepo(i: number) {
  return {
    name: `repo${i}`,
    owner: { login: "Octo" },
    description: null,
    language: "TypeScript",
    stargazers_count: i,
    updated_at: "2026-01-01T00:00:00Z",
    fork: false,
    private: i % 2 === 0,
    size: 10,
    default_branch: "main",
  };
}

describe("githubFetch errors", () => {
  it("401 → invalid token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 401)));
    await expect(githubFetch("/user")).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/token missing or invalid/) });
  });

  it("404 → not found", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 404)));
    await expect(githubFetch("/repos/a/b")).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/not found/) });
  });

  it("403 with no remaining requests → rate limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" })),
    );
    await expect(githubFetch("/user/repos")).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/rate limit/) });
  });

  it("network failure → retry message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(githubFetch("/user")).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/Couldn't reach GitHub/) });
  });

  it("never puts the token in the error message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 500)));
    await expect(githubFetch("/user")).rejects.not.toMatchObject({ message: expect.stringMatching(/Bearer/) });
  });
});

describe("listAccessibleRepos", () => {
  it("follows pages until a short page", async () => {
    const pages = [
      Array.from({ length: 100 }, (_, i) => fakeRepo(i)),
      Array.from({ length: 30 }, (_, i) => fakeRepo(100 + i)),
    ];
    const fetchMock = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return jsonResponse(pages[page - 1] ?? []);
    });
    vi.stubGlobal("fetch", fetchMock);

    const repos = await listAccessibleRepos();
    expect(repos).toHaveLength(130);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(repos[0]).toMatchObject({ repoId: "octo/repo0", owner: "Octo", isPrivate: true, sizeKb: 10 });
  });

  it("stops at the 1,000 repo cap", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(Array.from({ length: 100 }, (_, i) => fakeRepo(i))));
    vi.stubGlobal("fetch", fetchMock);

    const repos = await listAccessibleRepos();
    expect(repos).toHaveLength(1000);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });
});
