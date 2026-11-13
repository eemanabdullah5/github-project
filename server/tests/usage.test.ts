// Tests for usage and cost display: the meter, cost, and the chat/embedding counts from llm.ts.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/config.js")>();
  return { ...real, config: { ...real.config, llmProvider: "gemini", chatModel: "chat-a", embedModel: "embed-a", prices: { input: 0, output: 0, embed: 0 } } };
});
// A fake Gemini provider: reports real counts unless the reply is "no-usage".
vi.mock("../src/llmGemini.js", () => ({
  geminiProvider: {
    embed: vi.fn(async (_m: string, texts: string[]) => texts.map(() => [1])),
    async *chatStream(_m: string, messages: Array<{ content: string }>, onUsage?: (u: { input: number; output: number }) => void) {
      yield "Hello";
      if (messages.at(-1)!.content !== "no-usage") onUsage?.({ input: 100, output: 20 });
    },
  },
}));

const { chat, embedDocuments, embedQuery } = await import("../src/llm.js");
const { costOf, emptyUsage, trackUsage } = await import("../src/usage.js");
const { toTokenCounts } = await vi.importActual<typeof import("../src/llmGemini.js")>("../src/llmGemini.js");

describe("trackUsage", () => {
  it("counts every chat and embedding call made inside it, even after awaits", async () => {
    const usage = emptyUsage();
    await trackUsage(usage, async () => {
      await chat([{ role: "user", content: "hi" }]);
      await embedQuery("a".repeat(40)); // 10 tokens estimated
      await embedDocuments(["b".repeat(80)]); // 20 tokens estimated
    });
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 20, embedTokens: 30, calls: 3, estimated: false, cost: null });
  });

  it("estimates from text length when the service gives no counts", async () => {
    const usage = emptyUsage();
    await trackUsage(usage, () => chat([{ role: "user", content: "no-usage" }]));
    expect(usage).toMatchObject({ inputTokens: 2, outputTokens: 2, calls: 1, estimated: true });
  });

  it("keeps two meters apart", async () => {
    const a = emptyUsage();
    const b = emptyUsage();
    await Promise.all([trackUsage(a, () => chat([{ role: "user", content: "x" }])), trackUsage(b, () => embedQuery("yyyy"))]);
    expect([a.calls, a.embedTokens, b.calls, b.inputTokens]).toEqual([1, 0, 1, 0]);
  });

  it("does nothing outside a meter", async () => {
    await expect(chat([{ role: "user", content: "hi" }])).resolves.toBe("Hello");
  });
});

describe("costOf", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 500_000, embedTokens: 2_000_000 };

  it("is null when no prices are set", () => {
    expect(costOf(usage, { input: 0, output: 0, embed: 0 })).toBeNull();
  });

  it("adds up each kind at its price per million tokens", () => {
    expect(costOf(usage, { input: 0.5, output: 3, embed: 0.15 })).toBeCloseTo(0.5 + 1.5 + 0.3);
  });
});

describe("toTokenCounts", () => {
  it("counts the model's thinking as output", () => {
    expect(toTokenCounts({ promptTokenCount: 900, candidatesTokenCount: 100, thoughtsTokenCount: 50 })).toEqual({ input: 900, output: 150 });
  });
});
