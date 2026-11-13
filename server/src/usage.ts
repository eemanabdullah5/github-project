// Usage and cost display (Phase 3): counts the AI tokens used by one answer or one index.
// llm.ts records every AI call into the meter of the work that's running (trackUsage), so callers
// don't have to pass a meter around. Cost is shown only if prices are set in .env (PRICE_*).
import { AsyncLocalStorage } from "node:async_hooks";
import { CHARS_PER_TOKEN, config } from "./config.js";

export interface Usage {
  inputTokens: number; // chat: prompt tokens
  outputTokens: number; // chat: answer tokens (incl. the model's thinking)
  embedTokens: number; // embeddings (always estimated: Gemini doesn't report them)
  calls: number; // AI requests made
  estimated: boolean; // true if a chat count was estimated from text length (embeddings always are)
  cost: number | null; // US dollars, or null if no prices are set
}
/** makes a fresh meter at zero    */
export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, embedTokens: 0, calls: 0, estimated: false, cost: null };
}

const meters = new AsyncLocalStorage<Usage>();

/** Starts a trip. It runs some work (fn) with this meter switched on, so every AI call made during that work is added to it automatically. */
export function trackUsage<T>(usage: Usage, fn: () => T): T {
  return meters.run(usage, fn);
}

/** Rough token count from text length (about 4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Adds one chat call to the current meter (does nothing outside trackUsage). */
export function recordChat(inputTokens: number, outputTokens: number, estimated: boolean): void {
  const usage = meters.getStore();
  if (!usage) return;
  usage.inputTokens += inputTokens;
  usage.outputTokens += outputTokens;
  usage.calls++;
  usage.estimated ||= estimated;
  usage.cost = costOf(usage);
}

/** how many tokens were spent on embedding calls */
export function recordEmbed(tokens: number): void {
  const usage = meters.getStore();
  if (!usage) return;
  usage.embedTokens += tokens;
  usage.calls++;
  usage.cost = costOf(usage);
}

/** Cost in US dollars from the PRICE_* settings (per million tokens), or null if none are set. */
export function costOf(usage: Pick<Usage, "inputTokens" | "outputTokens" | "embedTokens">, prices = config.prices): number | null {
  if (!prices.input && !prices.output && !prices.embed) return null;
  return (usage.inputTokens * prices.input + usage.outputTokens * prices.output + usage.embedTokens * prices.embed) / 1_000_000;
}
