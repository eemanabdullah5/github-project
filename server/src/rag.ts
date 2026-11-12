// RAG — "retrieval-augmented generation" (ARCHITECTURE §10). Answers a question about a repo:
//  1. If there is chat history, rewrite a follow-up ("where is that called?") into a full question.
//  2. Turn the question into a vector and fetch the 8 closest code chunks, plus keyword matches for any code
//     names in the question (Phase 2 hybrid search, see hybridSearch.ts). Only from one folder or file
//     if the user picked one (Phase 2 "Ask about one folder", see scope.ts).
//  3. Build a prompt: rules + README/file tree + chunks + recent history + the question.
//  4. Stream the model's answer back, with the list of sources.
//  5. F3: after the answer, suggest 3 follow-up questions the user might ask next.
// Call graph phase 4: if the question names a function (e.g. "who calls searchChunks?"), its callers and
// callees from the call graph are added to the prompt, so the answer lists all of them, not just the ones
// search happened to find (see callGraphChat.ts).
// The text of every prompt sent to the AI lives in prompts.ts.
import { savedCallGraphForChat } from "./callGraph.js";
import { callGraphContext } from "./callGraphChat.js";
import { loadHistory } from "./gitHistory.js";
import { CHARS_PER_TOKEN, HISTORY_TURNS, MAX_README_TOKENS, MAX_TREE_LINES, NUM_CTX, TOP_K } from "./config.js";
import { AppError } from "./errors.js";
import { chat, chatStream, embedQuery, type ChatTurn } from "./llm.js";
import { CALL_GRAPH_RULES, DEPTH_RULES, REWRITE_QUESTION, SYSTEM_RULES, followUpsPrompt, scopeNote, type AnswerDepth } from "./prompts.js";
import { resolveScope, scopeFilter, type Scope } from "./scope.js";
import type { ChatMessage, Chunk, Manifest, Source } from "./types.js";
import { searchChunks } from "./hybridSearch.js";
import { loadManifest } from "./vectorStore.js";

/** Tokens kept free in the context window for the model's answer. */
const ANSWER_RESERVE_TOKENS = 2048;

/** Rough token count: about 4 characters per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Keeps the first maxLines lines of the file tree and notes how many were left out. (Also used by F5.) */
export function truncateTree(tree: string): string {
  const lines = tree.split("\n");
  if (lines.length <= MAX_TREE_LINES) return tree;
  return `${lines.slice(0, MAX_TREE_LINES).join("\n")}\n… (${lines.length - MAX_TREE_LINES} more files)`;
}

/** Keeps the start of the README, up to MAX_README_TOKENS. (Also used by F5.) */
export function truncateReadme(readme: string): string {
  const maxChars = MAX_README_TOKENS * CHARS_PER_TOKEN;
  return readme.length <= maxChars ? readme : `${readme.slice(0, maxChars)}\n… (README truncated)`;
}

/** Wraps one retrieved chunk in clear start/end markers labelled with its location. (Also used by F5.) */
export function formatChunk(chunk: Chunk, n: number): string {
  const symbol = chunk.symbol ? ` | ${chunk.symbol}` : "";
  return `<<<REPO CHUNK ${n}: ${chunk.path}${symbol} | Lines ${chunk.startLine}-${chunk.endLine}>>>\n${chunk.text}\n<<<END CHUNK ${n}>>>`;
}

/** Only the last few exchanges (question + answer pairs) are sent, as plain role/content messages. */
function recentHistory(history: ChatMessage[]): ChatTurn[] {
  return history.slice(-HISTORY_TURNS * 2).map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Builds the messages sent to the chat model. A pure function: no network, easy to test.
 * Order: rules (+ answer style, F2) → repo context (file tree + README) → chunks → history → question.
 * If everything won't fit in the context window, the lowest-ranked chunks are dropped first.
 * Returns the messages and the chunks that made it in (used for the Sources list).
 */
export function buildPrompt(input: {
  question: string;
  history: ChatMessage[];
  chunks: Chunk[]; // best match first
  manifest: Pick<Manifest, "repoId" | "fileTree" | "readme">;
  depth?: AnswerDepth; // F2: answer style. If not given, "technical" is used.
  scope?: Scope | null; // Phase 2: the folder or file the question is limited to, if any
  callGraph?: string | null; // Call graph phase 4: callers and callees of the functions named in the question
}): { messages: ChatTurn[]; usedChunks: Chunk[] } {
  // F2: the main rules, followed by the instructions for the chosen answer style.
  // Call graph phase 4: its rules are added only when there's a CALL GRAPH block, so other answers don't change.
  const rules =
    `${SYSTEM_RULES}\n\n${DEPTH_RULES[input.depth ?? "technical"]}` + (input.callGraph ? `\n\n${CALL_GRAPH_RULES}` : "");
  const repoContext =
    `Repository: ${input.manifest.repoId}\n\n` +
    (input.scope ? `${scopeNote(input.scope.kind, input.scope.path)}\n\n` : "") +
    `<<<REPO FILE TREE>>>\n${truncateTree(input.manifest.fileTree)}\n<<<END FILE TREE>>>\n\n` +
    `<<<REPO README>>>\n${truncateReadme(input.manifest.readme) || "(no README)"}\n<<<END README>>>` +
    (input.callGraph ? `\n\n<<<REPO CALL GRAPH>>>\n${input.callGraph}\n<<<END CALL GRAPH>>>` : "");
  const history = recentHistory(input.history);

  const budget = NUM_CTX - ANSWER_RESERVE_TOKENS;
  const fixedTokens =
    estimateTokens(rules + repoContext + input.question) +
    history.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  // Add chunks in rank order until the next one would go over the budget.
  const usedChunks: Chunk[] = [];
  let used = fixedTokens;
  for (const chunk of input.chunks) {
    const cost = estimateTokens(formatChunk(chunk, usedChunks.length + 1));
    if (used + cost > budget) break;
    usedChunks.push(chunk);
    used += cost;
  }

  const chunkText = usedChunks.length
    ? usedChunks.map((c, i) => formatChunk(c, i + 1)).join("\n\n")
    : "(no matching code was found)";
  const system = `${rules}\n\n${repoContext}\n\nRetrieved code chunks (best match first):\n\n${chunkText}`;

  return {
    messages: [{ role: "system", content: system }, ...history, { role: "user", content: input.question }],
    usedChunks,
  };
}

/**
 * Turns a follow-up into a question that makes sense on its own, so the search finds the
 * right code. Example: "where is that called?" → "where is hashPassword called?".
 * With no history, the question is returned unchanged (no LLM call).
 */
export async function rewriteQuestion(question: string, history: ChatMessage[]): Promise<string> {
  const recent = recentHistory(history);
  if (recent.length === 0) return question;
  const conversation = recent.map((m) => `${m.role}: ${m.content.slice(0, 1000)}`).join("\n");
  const rewritten = await chat([
    { role: "system", content: REWRITE_QUESTION }, // prompt text: prompts.ts
    { role: "user", content: `Conversation:\n${conversation}\n\nLast question: ${question}` },
  ]);
  return rewritten.trim() || question;
}

// F3: the most follow-up questions shown under an answer.
const MAX_FOLLOW_UPS = 3;

// F3: tidies the AI's reply into a clean list of questions.
// Example reply: "1. How is auth handled?\n- Where are the tests?\nHere you go"
// Result:        ["How is auth handled?", "Where are the tests?"]
export function parseFollowUps(text: string): string[] {
  return (
    text
      .split("\n") // one question per line
      // Remove bullets and numbers at the start ("-", "*", "•", "1.", "2)"), then quotes around the line.
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^["']|["']$/g, "").trim())
      // Keep only real questions: ends with "?", and not too short or too long for a button.
      .filter((line) => line.endsWith("?") && line.length >= 8 && line.length <= 150)
      .slice(0, MAX_FOLLOW_UPS) // at most 3
  );
}

// F3: asks the AI for 3 short follow-up questions, based on the last question and its answer.
// In Executive mode it asks for questions a CTO would ask; in Technical mode, questions a developer would ask.
// Suggestions are a nice extra, so if anything goes wrong we just return an empty list.
// Phase 2: if the question was limited to a folder or file (`scope`), the suggestions stay inside it.
export async function suggestFollowUps(
  question: string,
  answerText: string,
  depth: AnswerDepth = "technical",
  scope: Scope | null = null,
): Promise<string[]> {
  const reader = depth === "executive" ? "a CTO or engineering manager" : "a developer";
  try {
    const reply = await chat([
      { role: "system", content: followUpsPrompt(reader, MAX_FOLLOW_UPS, scope) }, // prompt text: prompts.ts
      // Only the first 4,000 characters of the answer are sent, to keep this extra call small and fast.
      { role: "user", content: `Question: ${question}\n\nAnswer:\n${answerText.slice(0, 4000)}` },
    ]);
    return parseFollowUps(reply);
  } catch {
    return []; // no suggestions; the answer itself is not affected
  }
}

/** Turns chunks into the Sources list shown under an answer. (Also used by F5.) */
export function toSources(chunks: Chunk[]): Source[] {
  return chunks.map((c) => ({ path: c.path, startLine: c.startLine, endLine: c.endLine, symbol: c.symbol }));
}

/**
 * Answers a question about an indexed repo.
 * Returns the sources right away and the answer as a stream of text pieces.
 *  function that builds what goes to the chat model. 
 * It vectorises only the question, not the code
 */
export async function answer(
  repoId: string,
  question: string,
  history: ChatMessage[],
  depth: AnswerDepth = "technical", // F2: answer style chosen in the chat
  scopePath = "", // Phase 2: limit the search to this folder or file ("" = the whole repo)
): Promise<{ sources: Source[]; tokens: AsyncIterable<string>; scope: Scope | null }> {
  const manifest = await loadManifest(repoId);
  if (!manifest) throw new AppError("This repo hasn't been indexed yet. Index it first.", 404);
  // Checked against the indexed files before anything else, so a bad path fails fast with a clear message.
  const scope = resolveScope(scopePath, manifest.fileTree);

  const searchQuery = await rewriteQuestion(question, history);
  const vector = await embedQuery(searchQuery);
  // Phase 2 hybrid search: code names in the question (e.g. `formatChunk`) are also searched for by keyword.
  // Names are looked for in both the question and its rewritten version, as the rewrite can drop backticks.
  const { chunks } = await searchChunks(repoId, `${question}\n${searchQuery}`, vector, TOP_K, scope ? scopeFilter(scope) : undefined);
  // A file in the index with no chunks (e.g. an empty file): say so instead of answering from nothing.
  if (scope && chunks.length === 0) throw new AppError(`There's no indexed code in "${scope.path}" to answer from.`, 400);
  // Call graph phase 4: callers and callees of any function the question names. The rewritten question is
  // checked too, so a follow-up like "and who calls it?" still finds the function.
  const graph = await savedCallGraphForChat(repoId, manifest.commitSha);
  const gitReport = graph ? ((await loadHistory(repoId))?.report ?? null) : null; // hotspots, for change impact
  const calls = graph ? callGraphContext(graph, `${question}\n${searchQuery}`, scope, gitReport) : null;
  const { messages, usedChunks } = buildPrompt({ question, history, chunks, manifest, depth, scope, callGraph: calls?.text });

  // The call graph's lines are sources too, so citations to them are verified. Chunks first, then those.
  const sources = toSources(usedChunks);
  for (const s of calls?.sources ?? []) {
    if (!sources.some((t) => t.path === s.path && t.startLine === s.startLine && t.endLine === s.endLine)) sources.push(s);
  }
  // `scope` is returned checked and tidied, so the follow-up suggestions can stay inside the same folder.
  return { sources, tokens: chatStream(messages), scope };
}
