// Tests for the Gemini provider's message conversion, error messages and retries (no network).
import { ApiError } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, retryDelay, retryTiming, streamText, toAppError, toGeminiRequest } from "../src/llmGemini.js";

describe("toGeminiRequest", () => {
  it("moves system messages out and renames assistant to model", () => {
    const { systemInstruction, contents } = toGeminiRequest([
      { role: "system", content: "rules" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);
    expect(systemInstruction).toBe("rules");
    expect(contents).toEqual([
      { role: "user", parts: [{ text: "q1" }] },
      { role: "model", parts: [{ text: "a1" }] },
      { role: "user", parts: [{ text: "q2" }] },
    ]);
  });
});

const apiError = (status: number, message = "error") => new ApiError({ status, message });

describe("toAppError", () => {
  it.each([
    [apiError(400, "API key not valid. Please pass a valid API key."), 401, /API key is missing or invalid/],
    [apiError(403), 401, /API key is missing or invalid/],
    [apiError(404), 503, /model "m" was not found/],
    [apiError(429), 429, /rate limit or quota/],
    [new TypeError("fetch failed"), 502, /Couldn't reach the Gemini API/],
    [apiError(503), 503, /Gemini is busy right now/],
    [apiError(500), 502, /temporary problem \(500\)/],
    [apiError(400), 502, /Gemini returned an error \(400\)/],
  ])("maps %s", (err, status, message) => {
    const result = toAppError(err, "m");
    expect(result.status).toBe(status);
    expect(result.message).toMatch(message);
  });
});

describe("retryDelay", () => {
  it("retries busy servers after 1 s, 2 s and 4 s, then gives up", () => {
    expect([0, 1, 2, 3].map((n) => retryDelay(apiError(503), n))).toEqual([1000, 2000, 4000, null]);
    expect(retryDelay(apiError(500), 0)).toBe(1000);
    expect(retryDelay(apiError(504), 0)).toBe(1000);
  });

  it("keeps the 20 s wait for rate limits, 3 times", () => {
    expect([0, 2, 3].map((n) => retryDelay(apiError(429), n))).toEqual([20000, 20000, null]);
  });

  it("never retries errors that won't fix themselves", () => {
    for (const err of [apiError(400), apiError(401), apiError(403), apiError(404), new TypeError("fetch failed")]) {
      expect(retryDelay(err, 0)).toBeNull();
    }
  });
});

describe("retries", () => {
  let sleep: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    sleep = vi.spyOn(retryTiming, "sleep").mockResolvedValue(); // don't really wait
    vi.spyOn(console, "warn").mockImplementation(() => {}); // keep test output quiet
  });
  afterEach(() => vi.restoreAllMocks());

  // A fake Gemini call that fails with the given errors first, then succeeds.
  const failThen = <T>(errors: unknown[], value: T) => {
    let calls = 0;
    const fn = vi.fn(async () => {
      if (calls < errors.length) throw errors[calls++];
      return value;
    });
    return fn;
  };

  it("call: a 503 followed by success returns the result", async () => {
    const fn = failThen([apiError(503)], "ok");
    await expect(call("m", fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("call: still busy after 3 retries gives the friendly busy message", async () => {
    const fn = failThen([apiError(503), apiError(503), apiError(503), apiError(503)], "ok");
    await expect(call("m", fn)).rejects.toThrow(/Gemini is busy right now/);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("call: a bad API key fails at once, without retrying", async () => {
    const fn = failThen([apiError(401)], "ok");
    await expect(call("m", fn)).rejects.toThrow(/API key is missing or invalid/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  // A fake Gemini stream: yields the pieces, then fails with `failWith` if given.
  async function* fakeStream(pieces: string[], failWith?: unknown) {
    for (const text of pieces) yield { text };
    if (failWith) throw failWith;
  }
  const collect = async (stream: AsyncIterable<string>) => {
    let text = "";
    for await (const piece of stream) text += piece;
    return text;
  };

  it("streamText: a 503 before the first word is retried", async () => {
    const open = vi
      .fn<() => Promise<AsyncIterable<{ text?: string }>>>()
      .mockRejectedValueOnce(apiError(503)) // the request itself fails
      .mockResolvedValueOnce(fakeStream([], apiError(503))) // the stream fails before any text
      .mockResolvedValueOnce(fakeStream(["Hello ", "world"]));
    await expect(collect(streamText("m", open))).resolves.toBe("Hello world");
    expect(open).toHaveBeenCalledTimes(3);
  });

  it("streamText: a failure after words were sent is not retried (it would repeat them)", async () => {
    const open = vi.fn(async () => fakeStream(["Hello "], apiError(503)));
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const piece of streamText("m", open)) seen.push(piece);
      })(),
    ).rejects.toThrow(/Gemini is busy right now/);
    expect(seen).toEqual(["Hello "]);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
