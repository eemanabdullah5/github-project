// Phase 2 — Hybrid search: meaning (vector) search plus keyword search, for questions that name something in the code.
//
// Vector search finds code by meaning, which is right for "how does login work?". But it can miss the exact name
// in "where is formatChunk used?": it finds code *about* similar things, not every line that says formatChunk.
// Keyword search finds the exact name. So:
//  1. Look for code names in the question: `backticked`, camelCase, PascalCase with an inner capital,
//     snake_case, or a file name like rag.ts (codeNames).
//  2. No names (a plain-English question)? Vector search only, exactly as before.
//  3. Names found? Run both searches and merge the two ranked lists (mergeRanked: Reciprocal Rank Fusion).
// If keyword search fails for any reason, the vector results are used on their own: it can only add, never break.
//
// Measured on github-project (8 "where is X used?" questions): chunks containing the name went from 22 to 39
// of the 64 retrieved, and files using it from 17 to 28. Plain-English questions are unchanged.
import { HYBRID_SEARCH } from "./config.js";
import type { Chunk } from "./types.js";
import { keywordQuery, query } from "./vectorStore.js";

/** Most names taken from one question, so a pasted stack trace doesn't become a huge keyword search. */
const MAX_NAMES = 5;
/** Reciprocal Rank Fusion constant. 60 is the usual value: it stops the top few results of one list from dominating. */
const RRF_K = 60;
/** File extensions that make a word count as a file name ("rag.ts", "package.json"). */
const FILE_EXT = /^[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|java|rb|rs|cs|php|json|ya?ml|toml|md|sql|sh)$/;

/** Is this word a code name? camelCase / PascalCase with an inner capital, snake_case, or a file name. */
function isCodeName(word: string): boolean {
  return /[a-z][A-Z]/.test(word) || /[A-Za-z0-9]_+[A-Za-z0-9]/.test(word) || FILE_EXT.test(word);
}

/**
 * The code names in a question, in the order they appear, without repeats (at most MAX_NAMES).
 * Anything in `backticks` counts (the user marked it as code); other words only if they look like code.
 * Plain words and all-caps words like "API" or "README" don't count: they're usually ordinary English.
 */
export function codeNames(text: string): string[] {
  const names: string[] = [];
  const add = (name: string) => {
    if (name.length >= 2 && !names.includes(name)) names.push(name);
  };
  // `backticked` text: keep only the name-like parts, so stray punctuation can't reach the search.
  for (const [, inside] of text.matchAll(/`([^`]+)`/g)) {
    for (const part of inside.match(/[A-Za-z0-9_$.-]+/g) ?? []) add(part.replace(/^[.-]+|[.-]+$/g, ""));
  }
  for (const raw of text.replace(/`[^`]*`/g, " ").split(/[^A-Za-z0-9_$.-]+/)) {
    const word = raw.replace(/^[.-]+|[.-]+$/g, ""); // "rag.ts." at the end of a sentence → "rag.ts"
    if (isCodeName(word)) add(word);
  }
  return names.slice(0, MAX_NAMES);
}

/**
 * Merges ranked lists into one with Reciprocal Rank Fusion: each chunk scores 1 / (60 + its rank) in every
 * list it's in, and the scores are added. A chunk near the top of both lists beats one at the top of only one.
 * Only ranks are used, so the two searches' very different scores never need to be compared.
 * Ties keep the order they were first seen in (vector results first). Returns the best k.
 */
export function mergeRanked(lists: Chunk[][], k: number): Chunk[] {
  const scores = new Map<string, { chunk: Chunk; score: number; first: number }>();
  let seen = 0;
  for (const list of lists) {
    list.forEach((chunk, i) => {
      const entry = scores.get(chunk.id) ?? { chunk, score: 0, first: seen++ };
      entry.score += 1 / (RRF_K + i + 1);
      scores.set(chunk.id, entry);
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.first - b.first)
    .slice(0, k)
    .map((e) => e.chunk);
}

/**
 * Finds the k best chunks for a question. `text` is where code names are looked for (the question, plus the
 * rewritten search query for follow-ups). `where` is an optional filter, e.g. "Ask about one folder" (scope.ts).
 * Returns the chunks and the names that were searched for (empty if vector search ran alone).
 */
export async function searchChunks(
  repoId: string,
  text: string,
  vector: number[],
  k: number,
  where?: string,
): Promise<{ chunks: Chunk[]; names: string[] }> {
  const names = HYBRID_SEARCH ? codeNames(text) : [];
  if (names.length === 0) return { chunks: await query(repoId, vector, k, where), names };

  // Each search returns twice as many as needed, so the merge has enough to choose from.
  const [byMeaning, byKeyword] = await Promise.all([
    query(repoId, vector, k * 2, where),
    keywordQuery(repoId, names.join(" "), k * 2, where).catch((err) => {
      console.error("Keyword search failed, using vector search only:", err instanceof Error ? err.message : err);
      return [] as Chunk[];
    }),
  ]);
  return { chunks: mergeRanked([byMeaning, byKeyword], k), names: byKeyword.length ? names : [] };
}
