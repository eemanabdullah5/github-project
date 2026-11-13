// Usage and cost display: turns token counts into short text for the UI.
import type { Usage } from "./api";

/** 1234 → "1,234", 12345 → "12.3k". */
export function formatTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString("en-US");
}

/** "$0.0012", or "<$0.0001" for tiny amounts. */
export function formatCost(cost: number): string {
  if (cost > 0 && cost < 0.0001) return "<$0.0001";
  return `$${cost < 1 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

/** Total tokens of all kinds. */
export function totalTokens(u: Usage): number {
  return u.inputTokens + u.outputTokens + u.embedTokens;
}

/** Short line, e.g. "5,210 tokens · $0.0012" ("~" in front if a chat count was estimated). */
export function usageSummary(u: Usage): string {
  const tokens = `${u.estimated ? "~" : ""}${formatTokens(totalTokens(u))} tokens`;
  return u.cost === null ? tokens : `${tokens} · ${formatCost(u.cost)}`;
}
