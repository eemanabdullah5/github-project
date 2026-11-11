// Tests for saved chat history, using a temporary folder instead of data/.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const tempDir = mkdtempSync(path.join(tmpdir(), "chats-test-"));
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  DATA_DIR: tempDir,
}));
const { MAX_CONVERSATIONS, appendExchange, deleteConversation, deleteConversations, getConversation, isConversationId, listConversations, titleFrom } =
  await import("../src/chatHistory.js");

afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

const reply = { content: "An answer", sources: [{ path: "a.ts", startLine: 1, endLine: 2, symbol: "" }], followUps: ["Next?"] };

describe("titleFrom / isConversationId", () => {
  it("makes a one-line title from the first question, cut to 60 characters", () => {
    expect(titleFrom("  What does\n this   repo do? ")).toBe("What does this repo do?");
    const long = titleFrom("x".repeat(100));
    expect(long).toHaveLength(60);
    expect(long.endsWith("…")).toBe(true);
  });

  it("only accepts simple ids, so nothing odd from the browser is trusted", () => {
    expect(isConversationId("3f2c9a7e-1b2d-4c5e-8f90-123456789abc")).toBe(true);
    expect(isConversationId("../../etc")).toBe(false);
    expect(isConversationId("")).toBe(false);
    expect(isConversationId(42)).toBe(false);
  });
});

describe("saving and loading chats", () => {
  it("creates a chat on its first answer, adds to it after, and keeps sources, follow-ups and folder", async () => {
    await appendExchange("o/r", "c1", { content: "First question?", scope: "src" }, reply);
    await appendExchange("o/r", "c1", { content: "Second?" }, { content: "Second answer" });
    const chat = (await getConversation("o/r", "c1"))!;
    expect(chat.title).toBe("First question?");
    expect(chat.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(chat.messages[0]).toMatchObject({ content: "First question?", scope: "src" });
    expect(chat.messages[1]).toMatchObject({ content: "An answer", followUps: ["Next?"], sources: [{ path: "a.ts" }] });
    expect(await getConversation("o/r", "missing")).toBeNull();
  });

  it("lists chats most recent first, without their messages", async () => {
    await appendExchange("o/list", "old", { content: "Old?" }, reply);
    await appendExchange("o/list", "new", { content: "New?" }, reply);
    const list = await listConversations("o/list");
    expect(list.map((c) => c.id)).toEqual(["new", "old"]);
    expect(list[0]).toEqual({ id: "new", title: "New?", updatedAt: expect.any(String), messageCount: 2 });
  });

  it("saves answers that finish at the same time without losing either", async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => appendExchange("o/race", "c", { content: `Q${i}` }, reply)));
    expect((await getConversation("o/race", "c"))!.messages).toHaveLength(20);
  });

  it(`keeps at most ${MAX_CONVERSATIONS} chats per repo, dropping the least recently used`, async () => {
    for (let i = 0; i <= MAX_CONVERSATIONS; i++) await appendExchange("o/many", `c${i}`, { content: `Q${i}` }, reply);
    const list = await listConversations("o/many");
    expect(list).toHaveLength(MAX_CONVERSATIONS);
    expect(list.some((c) => c.id === "c0")).toBe(false); // the oldest went
  });

  it("deletes a chat, and says when there was nothing to delete", async () => {
    await appendExchange("o/del", "c1", { content: "Q?" }, reply);
    expect(await deleteConversation("o/del", "c1")).toBe(true);
    expect(await deleteConversation("o/del", "c1")).toBe(false);
    expect(await listConversations("o/del")).toEqual([]);
  });

  it("deletes several chats at once, ignoring ids that don't exist", async () => {
    for (const id of ["a", "b", "c"]) await appendExchange("o/multi", id, { content: `${id}?` }, reply);
    expect(await deleteConversations("o/multi", ["a", "c", "nope"])).toBe(2);
    expect((await listConversations("o/multi")).map((c) => c.id)).toEqual(["b"]);
    expect(await deleteConversations("o/multi", ["nope"])).toBe(0);
  });

  it("saves one JSON file per repo in data/chats/", async () => {
    await appendExchange("octo/hello", "c1", { content: "Q?" }, reply);
    const saved = JSON.parse(readFileSync(path.join(tempDir, "chats", "octo__hello.json"), "utf8"));
    expect(saved.repoId).toBe("octo/hello");
    expect(saved.conversations[0].id).toBe("c1");
  });
});
