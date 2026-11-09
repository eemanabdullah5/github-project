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

/** "Too many requests" (common on the free tier): wait 20 s, up to 3 times. */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_WAIT_MS = 20_000;

/** Temporary problems on Google's side (503 = overloaded). Usually gone within seconds: wait 1 s, 2 s, then 4 s. */
const BUSY_STATUSES = new Set([500, 503, 504]);
const BUSY_WAITS_MS = [1_000, 2_000, 4_000];

/** How we wait between tries. A separate object so tests can skip the real waiting. */
export const retryTiming = {
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

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
  if (status === 503) {
    return new AppError("Gemini is busy right now (Google's servers are overloaded). Please try again in a minute.", 503);
  }
  if (status !== undefined && BUSY_STATUSES.has(status)) {
    return new AppError(`Gemini had a temporary problem (${status}). Please try again in a minute.`, 502);
  }
  if (status === undefined && /fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(message)) {
    return new AppError("Couldn't reach the Gemini API. Check your internet connection and try again.", 502);
  }
  return new AppError(`Gemini returned an error${status ? ` (${status})` : ""}. Please try again.`, 502);
}

/**
 * Decides whether a failed Gemini call is worth trying again, and how long to wait first.
 * Returns the wait in milliseconds, or null to give up. `attempt` counts retries already made (0 = none yet).
 * Errors that won't fix themselves (bad key, wrong model, bad request) are never retried.
 */
export function retryDelay(err: unknown, attempt: number): number | null {
  const status = err instanceof ApiError ? err.status : undefined;
  if (status === 429) return attempt < RATE_LIMIT_RETRIES ? RATE_LIMIT_WAIT_MS : null;
  if (status !== undefined && BUSY_STATUSES.has(status)) return BUSY_WAITS_MS[attempt] ?? null;
  return null;
}

/** Waits before the next try, with a note in the server terminal (the user doesn't see it). */
async function waitBeforeRetry(err: unknown, wait: number, attempt: number): Promise<void> {
  const status = err instanceof ApiError ? err.status : "?";
  const reason = status === 429 ? "rate limit" : "busy";
  const tries = status === 429 ? RATE_LIMIT_RETRIES : BUSY_WAITS_MS.length;
  console.warn(`Gemini ${reason} (${status}), retrying in ${wait / 1000}s (${attempt + 1}/${tries})`);
  await retryTiming.sleep(wait);
}

/**
 * Runs one Gemini call. If it fails with a temporary error (rate limit or busy servers),
 * waits and tries again (see retryDelay). Any other failure is converted with toAppError.
 */
export async function call<T>(model: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const wait = retryDelay(err, attempt);
      if (wait === null) throw toAppError(err, model);
      await waitBeforeRetry(err, wait, attempt);
    }
  }
}

/**
 * Streams the text of an answer, with the same retries as call(), but only until the first piece
 * of text has been sent. After that a retry would repeat the start of the answer on screen,
 * so a failure is reported as an error instead.
 */
export async function* streamText(model: string, open: () => Promise<AsyncIterable<{ text?: string }>>): AsyncGenerator<string> {
  for (let attempt = 0; ; attempt++) {
    let sentText = false;
    try {
      const stream = await open();
      for await (const part of stream) {
        if (part.text) {
          sentText = true;
          yield part.text;
        }
      }
      return;
    } catch (err) {
      const wait = sentText ? null : retryDelay(err, attempt);
      if (wait === null) throw toAppError(err, model);
      await waitBeforeRetry(err, wait, attempt);
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

  /** Streams the answer piece by piece. Retries temporary errors until the first piece arrives (see streamText). */
  async *chatStream(model: string, messages: ChatTurn[]) {
    const ai = getClient();
    const { systemInstruction, contents } = toGeminiRequest(messages);
    yield* streamText(model, () => ai.models.generateContentStream({ model, contents, config: { systemInstruction } }));
  },
};
