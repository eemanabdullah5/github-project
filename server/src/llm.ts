// LLM (ARCHITECTURE §8.1): the ONLY file that talks to Ollama, which runs the Qwen models locally.
// It turns text into vectors (embeddings) and streams chat answers.
// If the provider ever changes (e.g. Ollama → vLLM), only this file changes.
import { Ollama, type Message } from "ollama";
import { config, NUM_CTX } from "./config.js";
import { AppError } from "./errors.js";

const ollama = new Ollama({ host: config.ollamaHost });

/** How many texts are sent to the embedding model in one request. */
const EMBED_BATCH_SIZE = 32;

/**
 * Qwen3-Embedding works best when search queries carry a one-line instruction.
 * Documents (code chunks) are embedded as they are, with no instruction.
 */
const QUERY_INSTRUCTION = "Instruct: Given a question about a code repository, retrieve the code or docs that answer it\nQuery: ";

/** Throws a clear error if a model name hasn't been set in .env. */
function requireModel(name: "CHAT_MODEL" | "EMBED_MODEL", value: string): string {
  if (!value) throw new AppError(`${name} is not set. Add it to your .env file (see .env.example).`, 503);
  return value;
}

/**
 * Runs an Ollama call and turns its failures into errors the user can act on:
 * "start Ollama" if it isn't running, or "ollama pull <model>" if the model is missing.
 */
async function callOllama<T>(model: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toAppError(err, model);
  }
}

function toAppError(err: unknown, model: string): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status_code?: number }).status_code;
  if (status === 404 || /not found/i.test(message)) {
    return new AppError(`Model "${model}" is not installed. Run: ollama pull ${model}`, 503);
  }
  if (/fetch failed|ECONNREFUSED|connect/i.test(message)) {
    return new AppError("Model server not running — start Ollama.", 503);
  }
  return new AppError(`The model server returned an error: ${message}`, 502);
}

/** Ollama adds ":latest" to names without a tag, so "qwen3" and "qwen3:latest" are the same model. */
function sameModel(a: string, b: string): boolean {
  const withTag = (n: string) => (n.includes(":") ? n : `${n}:latest`);
  return withTag(a) === withTag(b);
}

/**
 * Health check: confirms Ollama is reachable and both models are pulled.
 * Called before indexing and before answering, so the user gets a clear message early.
 */
export async function checkModels(): Promise<void> {
  const chatModel = requireModel("CHAT_MODEL", config.chatModel);
  const embedModel = requireModel("EMBED_MODEL", config.embedModel);
  const { models } = await callOllama(chatModel, () => ollama.list());
  for (const wanted of [chatModel, embedModel]) {
    if (!models.some((m) => sameModel(m.name, wanted))) {
      throw new AppError(`Model "${wanted}" is not installed. Run: ollama pull ${wanted}`, 503);
    }
  }
}

/**
 * Turns many texts (code chunks) into vectors, 32 at a time.
 * onProgress is called after each batch with how many are done, for the progress bar.
 */
export async function embedDocuments(texts: string[], onProgress?: (done: number) => void): Promise<number[][]> {
  const model = requireModel("EMBED_MODEL", config.embedModel);
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const res = await callOllama(model, () =>
      ollama.embed({ model, input: batch, options: { num_ctx: NUM_CTX } }),
    );
    vectors.push(...res.embeddings);
    onProgress?.(vectors.length);
  }
  return vectors;
}

/** Turns one search question into a vector, using the query instruction. */
export async function embedQuery(text: string): Promise<number[]> {
  const model = requireModel("EMBED_MODEL", config.embedModel);
  const res = await callOllama(model, () =>
    ollama.embed({ model, input: QUERY_INSTRUCTION + text, options: { num_ctx: NUM_CTX } }),
  );
  return res.embeddings[0];
}

/**
 * Sends a conversation to the chat model and yields the answer piece by piece as it is written.
 * num_ctx is always set: Ollama's default context is small and would silently cut long prompts.
 */
export async function* chatStream(messages: Message[]): AsyncIterable<string> {
  const model = requireModel("CHAT_MODEL", config.chatModel);
  const stream = await callOllama(model, () =>
    ollama.chat({ model, messages, stream: true, options: { num_ctx: NUM_CTX } }),
  );
  try {
    for await (const part of stream) {
      if (part.message.content) yield part.message.content;
    }
  } catch (err) {
    throw toAppError(err, model);
  }
}

/** Sends a conversation and returns the whole answer at once (used for short helper calls). */
export async function chat(messages: Message[]): Promise<string> {
  let text = "";
  for await (const piece of chatStream(messages)) text += piece;
  return text;
}
