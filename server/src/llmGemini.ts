// Gemini provider: uses Google's Gemini API through the official @google/genai SDK.
// Used when LLM_PROVIDER=gemini. Fast, but repo code and questions are sent to Google.
// This is the only file that talks to Gemini.
import { ApiError, GoogleGenAI, type Content } from "@google/genai";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import type { ChatTurn, LlmProvider } from "./llm.js";

/** The SDK client, created on first use so a missing key gives a clear message instead of a crash. */
let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!config.geminiApiKey) {
    throw new AppError("GEMINI_API_KEY is not set. Add your Gemini API key to the .env file (see .env.example).", 503);
  }
  client ??= new GoogleGenAI({ apiKey: config.geminiApiKey });
  return client;
}

/** How many times to try again when Gemini says "too many requests" (common on the free tier). */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_WAIT_MS = 20_000;

/** Turns Gemini failures into messages the user can act on. Never includes the API key. */
export function toAppError(err: unknown, model: string): AppError {
  if (err instanceof AppError) return err;
  const status = err instanceof ApiError ? err.status : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID/i.test(message)) {
    return new AppError("Gemini API key is missing or invalid. Check GEMINI_API_KEY in your .env file.", 401);
  }
  if (status === 404) {
    return new AppError(`Gemini model "${model}" was not found. Check CHAT_MODEL and EMBED_MODEL in your .env file.`, 503);
  }
  if (status === 429) {
    return new AppError("Gemini rate limit or quota reached. Wait a minute and try again.", 429);
  }
  if (status === undefined && /fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(message)) {
    return new AppError("Couldn't reach the Gemini API. Check your internet connection and try again.", 502);
  }
  return new AppError(`Gemini returned an error${status ? ` (${status})` : ""}. Please try again.`, 502);
}

/**
 * Runs one Gemini call. If Gemini says "too many requests", waits and tries again
 * a few times. Any other failure is converted with toAppError.
 */
async function call<T>(model: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const rateLimited = err instanceof ApiError && err.status === 429;
      if (!rateLimited || attempt >= RATE_LIMIT_RETRIES) throw toAppError(err, model);
      await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT_MS));
    }
  }
}

/**
 * Converts our messages into Gemini's format. Gemini takes the system message
 * separately ("systemInstruction") and calls the assistant role "model".
 */
export function toGeminiRequest(messages: ChatTurn[]): { systemInstruction: string; contents: Content[] } {
  const systemInstruction = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  return { systemInstruction, contents };
}

export const geminiProvider: LlmProvider = {
  /** Checks the API key works and both models exist (one small lookup per model). */
  async checkModels(chatModel, embedModel) {
    const ai = getClient();
    for (const model of [chatModel, embedModel]) {
      await call(model, () => ai.models.get({ model }));
    }
  },

  /**
   * Embeds texts in one request. Gemini makes better search vectors when told whether
   * a text is a document being stored or a query being searched for.
   */
  async embed(model, texts, kind) {
    const ai = getClient();
    const res = await call(model, () =>
      ai.models.embedContent({
        model,
        contents: texts,
        config: { taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" },
      }),
    );
    return (res.embeddings ?? []).map((e) => e.values ?? []);
  },

  /** Streams the answer piece by piece. */
  async *chatStream(model: string, messages: ChatTurn[]) {
    const ai = getClient();
    const { systemInstruction, contents } = toGeminiRequest(messages);
    const stream = await call(model, () =>
      ai.models.generateContentStream({ model, contents, config: { systemInstruction } }),
    );
    try {
      for await (const part of stream) {
        if (part.text) yield part.text;
      }
    } catch (err) {
      throw toAppError(err, model);
    }
  },
};
