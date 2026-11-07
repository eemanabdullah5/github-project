// Tests for the Gemini provider's message conversion and error messages (no network).
import { ApiError } from "@google/genai";
import { describe, expect, it } from "vitest";
import { toAppError, toGeminiRequest } from "../src/llmGemini.js";

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

describe("toAppError", () => {
  const apiError = (status: number, message = "error") => new ApiError({ status, message });

  it.each([
    [apiError(400, "API key not valid. Please pass a valid API key."), 401, /API key is missing or invalid/],
    [apiError(403), 401, /API key is missing or invalid/],
    [apiError(404), 503, /model "m" was not found/],
    [apiError(429), 429, /rate limit or quota/],
    [new TypeError("fetch failed"), 502, /Couldn't reach the Gemini API/],
    [apiError(500), 502, /Gemini returned an error \(500\)/],
  ])("maps %s", (err, status, message) => {
    const result = toAppError(err, "m");
    expect(result.status).toBe(status);
    expect(result.message).toMatch(message);
  });
});
