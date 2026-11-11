// Tests for the HTTP API. The GitHub client, indexer and RAG modules are replaced with fakes.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors.js";

vi.mock("../src/githubClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/githubClient.js")>()),
  listAccessibleRepos: vi.fn(async () => [{ repoId: "octo/hello" }]),
  getRepo: vi.fn(async () => {
    throw new AppError("Repo not found, or your token can't access it.", 404);
  }),
}));
vi.mock("../src/indexer.js", () => ({
  getJob: vi.fn(() => null),
  checkIndexStatus: vi.fn(),
  startIndexJob: vi.fn()
    .mockImplementationOnce(() => ({ repoId: "octo/hello", step: "downloading" }))
    .mockImplementation(() => {
      throw new AppError("Another repo is being indexed (octo/hello). Please wait for it to finish.", 409);
    }),
}));
vi.mock("../src/rag.js", () => ({
  suggestFollowUps: vi.fn(async () => ["What next?"]), // F3
  answer: vi.fn(async (..._args: unknown[]) => ({
    sources: [{ path: "a.ts", startLine: 1, endLine: 2, symbol: "" }],
    tokens: (async function* () {
      yield "Hello";
      yield " world";
    })(),
    // Phase 2: rag returns the checked scope; here, whatever was asked for, as a folder.
    scope: _args[4] ? { kind: "folder", path: String(_args[4]) } : null,
  })),
}));

const { createApp } = await import("../src/app.js");
const { listAccessibleRepos } = await import("../src/githubClient.js");
const { answer, suggestFollowUps } = await import("../src/rag.js");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe("GET /api/health", () => {
  it("returns ok", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("unknown routes", () => {
  it("return 404", async () => {
    const res = await fetch(`${baseUrl}/api/does-not-exist`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/repos", () => {
  it("caches the list and refetches with ?refresh=1", async () => {
    await fetch(`${baseUrl}/api/repos`);
    await fetch(`${baseUrl}/api/repos`);
    expect(listAccessibleRepos).toHaveBeenCalledTimes(1);
    const res = await fetch(`${baseUrl}/api/repos?refresh=1`);
    expect(await res.json()).toEqual([{ repoId: "octo/hello" }]);
    expect(listAccessibleRepos).toHaveBeenCalledTimes(2);
  });
});

describe("errors", () => {
  it("sends AppErrors as {error} with their status", async () => {
    const res = await fetch(`${baseUrl}/api/repos/octo/missing`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Repo not found, or your token can't access it." });
  });
});

describe("POST /api/repos/:owner/:repo/index", () => {
  it("returns 202, then 409 while a job is running", async () => {
    const first = await fetch(`${baseUrl}/api/repos/octo/hello/index`, { method: "POST" });
    expect(first.status).toBe(202);
    const second = await fetch(`${baseUrl}/api/repos/octo/other/index`, { method: "POST" });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/Another repo is being indexed/);
  });
});

describe("POST /api/repos/:owner/:repo/chat", () => {
  it("streams sources, tokens, follow-ups (F3), then done", async () => {
    const res = await fetch(`${baseUrl}/api/repos/octo/hello/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "hi", history: [] }),
    });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const events = (await res.text()).trim().split("\n\n").map((e) => e.split("\n")[0]);
    expect(events).toEqual(["event: sources", "event: token", "event: token", "event: followups", "event: done"]);
  });

  // F2: the answer style from the browser reaches rag.answer() (4th argument).
  it("passes the answer style to rag, and treats unknown values as technical", async () => {
    const ask = (depth: unknown) =>
      fetch(`${baseUrl}/api/repos/octo/hello/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "hi", depth }),
      }).then((r) => r.text());
    await ask("executive");
    expect(vi.mocked(answer).mock.lastCall?.[3]).toBe("executive");
    await ask("something-else");
    expect(vi.mocked(answer).mock.lastCall?.[3]).toBe("technical");
  });

  // Phase 2: the folder picked in the chat reaches rag.answer() (5th argument). Anything that isn't text is ignored.
  it("passes the scope to rag, and treats a missing or non-text scope as the whole repo", async () => {
    const ask = (body: object) =>
      fetch(`${baseUrl}/api/repos/octo/hello/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "hi", ...body }),
      }).then((r) => r.text());
    await ask({ scope: "server/src" });
    expect(vi.mocked(answer).mock.lastCall?.[4]).toBe("server/src");
    // The follow-up suggestions get the checked scope too (4th argument), so they stay inside the folder.
    expect(vi.mocked(suggestFollowUps).mock.lastCall?.[3]).toEqual({ kind: "folder", path: "server/src" });
    await ask({ scope: { evil: true } });
    expect(vi.mocked(answer).mock.lastCall?.[4]).toBe("");
    await ask({});
    expect(vi.mocked(answer).mock.lastCall?.[4]).toBe("");
  });

  it("rejects an empty question", async () => {
    const res = await fetch(`${baseUrl}/api/repos/octo/hello/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "  " }),
    });
    expect(res.status).toBe(400);
  });
});
