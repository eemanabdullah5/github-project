// Ollama provider: runs Qwen models locally, so repo code never leaves this machine.
// Used when LLM_PROVIDER=ollama. This is the only file that talks to Ollama.
import { Ollama } from "ollama";
import { config, NUM_CTX } from "./config.js";
import { AppError } from "./errors.js";
import type { ChatTurn, LlmProvider } from "./llm.js";

const ollama = new Ollama({ host: config.ollamaHost });

/**
 * Qwen3-Embedding works best when search queries carry a one-line instruction.
 * Documents (code chunks) are embedded as they are, with no instruction.
 */
const QUERY_INSTRUCTION = "Instruct: Given a question about a code repository, retrieve the code or docs that answer it\nQuery: ";

/** Turns Ollama failures into messages the user can act on ("start Ollama", "ollama pull …"). */
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

/** Runs one Ollama call and converts any failure with toAppError. */
async function call<T>(model: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toAppError(err, model);
  }
}

/** Ollama adds ":latest" to names without a tag, so "qwen3" and "qwen3:latest" are the same model. */
function sameModel(a: string, b: string): boolean {
  const withTag = (n: string) => (n.includes(":") ? n : `${n}:latest`);
  return withTag(a) === withTag(b);
}

export const ollamaProvider: LlmProvider = {
  /** Checks Ollama is running and both models have been pulled. */
  async checkModels(chatModel, embedModel) {
    const { models } = await call(chatModel, () => ollama.list());
    for (const wanted of [chatModel, embedModel]) {
      if (!models.some((m) => sameModel(m.name, wanted))) {
        throw new AppError(`Model "${wanted}" is not installed. Run: ollama pull ${wanted}`, 503);
      }
    }
  },

  /** Embeds texts in one request. Queries get the instruction prefix; documents don't. */
  async embed(model, texts, kind) {
    const input = kind === "query" ? texts.map((t) => QUERY_INSTRUCTION + t) : texts;
    const res = await call(model, () => ollama.embed({ model, input, options: { num_ctx: NUM_CTX } }));
    return res.embeddings;
  },

  /**
   * Streams the answer. num_ctx is always set: Ollama's default context is small
   * and would silently cut long prompts.
   */
  async *chatStream(model: string, messages: ChatTurn[]) {
    const stream = await call(model, () => ollama.chat({ model, messages, stream: true, options: { num_ctx: NUM_CTX } }));
    try {
      for await (const part of stream) {
        if (part.message.content) yield part.message.content;
      }
    } catch (err) {
      throw toAppError(err, model);
    }
  },
};
