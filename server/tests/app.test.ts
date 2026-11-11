// Tests for the HTTP API. The GitHub client, indexer and RAG modules are replaced with fakes.
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors.js";

// Saved chats go to a temporary folder. Why: the tests must never write into the real data/ folder.
const tempDir = mkdtempSync(path.join(tmpdir(), "app-test-"));
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  DATA_DIR: tempDir,
}));

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
  rmSync(tempDir, { recursive: true, force: true });
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
    expect(events).toEqual(["event: conversation", "event: sources", "event: token", "event: token", "event: followups", "event: done"]);
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

  // Saved chat history: a finished answer is saved, listed, can be reopened and deleted.
  it("saves each finished question and answer, and lists, opens and deletes chats", async () => {
    const chatUrl = `${baseUrl}/api/repos/octo/saved/chat`;
    const ask = (body: object) =>
      fetch(chatUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.text());
    const idOf = (stream: string) => JSON.parse(stream.match(/event: conversation\ndata: (.*)/)![1]).id as string;

    // First question: a new chat is made. Second question with its id: added to the same chat.
    const id = idOf(await ask({ question: "What is this repo?" }));
    expect(idOf(await ask({ question: "And the tests?", conversationId: id, scope: "server/src" }))).toBe(id);

    const list = await (await fetch(`${baseUrl}/api/repos/octo/saved/chats`)).json();
    expect(list).toEqual([expect.objectContaining({ id, title: "What is this repo?", messageCount: 4 })]);

    const chat = await (await fetch(`${baseUrl}/api/repos/octo/saved/chats/${id}`)).json();
    expect(chat.messages.map((m: { role: string; content: string }) => `${m.role}: ${m.content}`)).toEqual([
      "user: What is this repo?",
      "assistant: Hello world",
      "user: And the tests?",
      "assistant: Hello world",
    ]);
    expect(chat.messages[1]).toMatchObject({ sources: [{ path: "a.ts" }], followUps: ["What next?"] });
    expect(chat.messages[2].scope).toBe("server/src"); // the "Search in" folder is remembered

    expect((await fetch(`${baseUrl}/api/repos/octo/saved/chats/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/repos/octo/saved/chats/${id}`)).status).toBe(404);
    expect(await (await fetch(`${baseUrl}/api/repos/octo/saved/chats`)).json()).toEqual([]);
  });

  it("deletes several chats at once, and rejects an empty or bad list", async () => {
    const json = { "Content-Type": "application/json" };
    const post = (body: object) =>
      fetch(`${baseUrl}/api/repos/octo/many/chat`, { method: "POST", headers: json, body: JSON.stringify(body) }).then((r) => r.text());
    const ids: string[] = [];
    for (const q of ["One?", "Two?", "Three?"]) ids.push(JSON.parse((await post({ question: q })).match(/event: conversation\ndata: (.*)/)![1]).id);
    const del = (body: object) => fetch(`${baseUrl}/api/repos/octo/many/chats/delete`, { method: "POST", headers: json, body: JSON.stringify(body) });

    const res = await del({ ids: [ids[0], ids[2]] });
    expect(await res.json()).toEqual({ deleted: 2 });
    const left = await (await fetch(`${baseUrl}/api/repos/octo/many/chats`)).json();
    expect(left.map((c: { title: string }) => c.title)).toEqual(["Two?"]);

    expect((await del({ ids: [] })).status).toBe(400);
    expect((await del({ ids: ["../x"] })).status).toBe(400);
    expect((await del({})).status).toBe(400);
  });

  it("starts a new chat when the conversation id is missing or not a valid id", async () => {
    const res = await fetch(`${baseUrl}/api/repos/octo/other/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "hi", conversationId: "../../etc/passwd" }),
    });
    const id = JSON.parse((await res.text()).match(/event: conversation\ndata: (.*)/)![1]).id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await fetch(`${baseUrl}/api/repos/octo/other/chats/..%2F..%2Fetc`)).status).toBe(404);
  });
});
