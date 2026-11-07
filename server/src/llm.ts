// LLM (ARCHITECTURE §8.1): the one place the rest of the app goes to for AI.
// It turns text into vectors (embeddings) and streams chat answers.
// The real work is done by one of two providers, picked with LLM_PROVIDER in .env:
//  - llmGemini.ts: Google's Gemini API (fast; code is sent to Google)
//  - llmOllama.ts: Qwen running locally in Ollama (code stays on this machine)
// Other modules only import from this file, so they don't care which provider is used.
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { geminiProvider } from "./llmGemini.js";
import { ollamaProvider } from "./llmOllama.js";

/** One message in a conversation sent to the chat model. */
export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

/** What every provider must be able to do. */
export interface LlmProvider {
  /** Confirms the service is reachable and both models exist. Throws an AppError if not. */
  checkModels(chatModel: string, embedModel: string): Promise<void>;
  /** Turns texts into vectors. "document" for code chunks, "query" for a search question. */
  embed(model: string, texts: string[], kind: "document" | "query"): Promise<number[][]>;
  /** Streams the chat answer piece by piece. */
  chatStream(model: string, messages: ChatTurn[]): AsyncIterable<string>;
}

/** How many texts are sent to the embedding model in one request. */
const EMBED_BATCH_SIZE = 32;

/** The provider chosen in .env. */
const provider: LlmProvider = config.llmProvider === "gemini" ? geminiProvider : ollamaProvider;

/** Throws a clear error if a model name hasn't been set in .env. */
function requireModel(name: "CHAT_MODEL" | "EMBED_MODEL", value: string): string {
  if (!value) throw new AppError(`${name} is not set. Add it to your .env file (see .env.example).`, 503);
  return value;
}

/**
 * Health check: confirms the AI service is reachable and both models exist.
 * Called before indexing, so the user gets a clear message before any download.
 */
export async function checkModels(): Promise<void> {
  await provider.checkModels(requireModel("CHAT_MODEL", config.chatModel), requireModel("EMBED_MODEL", config.embedModel));
}

/**
 * Turns many texts (code chunks) into vectors, 32 at a time.
 * onProgress is called after each batch with how many are done, for the progress bar.
 */
export async function embedDocuments(texts: string[], onProgress?: (done: number) => void): Promise<number[][]> {
  const model = requireModel("EMBED_MODEL", config.embedModel);
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    vectors.push(...(await provider.embed(model, texts.slice(i, i + EMBED_BATCH_SIZE), "document")));
    onProgress?.(vectors.length);
  }
  return vectors;
}

/** Turns one search question into a vector. */
export async function embedQuery(text: string): Promise<number[]> {
  const model = requireModel("EMBED_MODEL", config.embedModel);
  const [vector] = await provider.embed(model, [text], "query");
  return vector;
}

/** Sends a conversation to the chat model and yields the answer piece by piece as it is written. */
export function chatStream(messages: ChatTurn[]): AsyncIterable<string> {
  return provider.chatStream(requireModel("CHAT_MODEL", config.chatModel), messages);
}

/** Sends a conversation and returns the whole answer at once (used for short helper calls). */
export async function chat(messages: ChatTurn[]): Promise<string> {
  let text = "";
  for await (const piece of chatStream(messages)) text += piece;
  return text;
}
