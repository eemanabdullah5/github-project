// Search evaluation: how often does search find the right file? Runs fixed test questions against the REAL index.
// Why: search has changed a lot (hybrid search, folder scope, reused vectors). This gives one number to compare
// before and after any change, instead of checking a few questions by hand.
//
// For each question it runs both searches the chat can use, and records where the right file first appears:
//  - meaning only: vector search, as before hybrid search
//  - hybrid:       what the chat really uses (adds keyword search when the question names code)
// "Found" = the right file is in the top 8 chunks (the 8 the AI is given). "Top 3" = it's in the first 3.
//
// Questions: server/eval/questions.json. Read-only: nothing in data/ changes.
// Cost: one small Gemini embedding per question, no chat calls (about 40 calls, under a minute).
//
// Run from the project root:   npm run eval
// One repo only:               npm run eval -- eemanabdullah5/ai_agent_oop
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HYBRID_SEARCH, TOP_K } from "../src/config.js";
import { searchChunks } from "../src/hybridSearch.js";
import { embedQuery } from "../src/llm.js";
import { resolveScope, scopeFilter } from "../src/scope.js";
import type { Chunk } from "../src/types.js";
import { loadManifest, query } from "../src/vectorStore.js";

interface Question {
  kind: "plain" | "name" | "folder";
  q: string;
  expect: string[]; // the file(s) that answer it: any one counts
  scope?: string; // for "folder" questions: the "Search in" folder
}

/** Where the first right file is in the results (1 = top), or null if it isn't in the top 8. */
function rankOf(chunks: Chunk[], expect: string[]): number | null {
  const i = chunks.findIndex((c) => expect.includes(c.path));
  return i < 0 ? null : i + 1;
}

/** Turns a question into a vector, retrying if Gemini is busy. Why: one busy moment shouldn't spoil the whole run. */
async function embedWithRetry(text: string): Promise<number[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await embedQuery(text);
    } catch (err) {
      if (attempt >= 4) throw err;
      console.log(`   (AI busy, retrying in ${attempt * 10} s…)`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 10_000));
    }
  }
}

/** "17/20 (85%)" */
const share = (n: number, total: number) => `${n}/${total} (${total ? Math.round((100 * n) / total) : 0}%)`;

const here = path.dirname(fileURLToPath(import.meta.url));
const { repos } = JSON.parse(await readFile(path.join(here, "..", "eval", "questions.json"), "utf8")) as {
  repos: Array<{ repo: string; questions: Question[] }>;
};
const only = process.argv[2];
if (!HYBRID_SEARCH) console.log("Note: HYBRID_SEARCH is off in .env, so the hybrid column is the same as meaning only.\n");

for (const { repo, questions } of repos.filter((r) => !only || r.repo === only)) {
  const manifest = await loadManifest(repo);
  if (!manifest) {
    console.log(`\n${repo}: not indexed, skipped.`);
    continue;
  }
  console.log(`\n${repo} (indexed commit ${manifest.commitSha.slice(0, 7)}, ${questions.length} questions)\n`);

  // Expected files that aren't in the index: the question is out of date (the code moved), not a search failure.
  const indexed = new Set(manifest.fileTree.split("\n"));
  for (const q of questions) {
    const missing = q.expect.filter((f) => !indexed.has(f));
    if (missing.length === q.expect.length) console.log(`   ⚠ out of date: "${q.q}" expects ${missing.join(", ")}, which isn't in the index`);
  }

  const results: Array<{ q: Question; meaning: number | null; hybrid: number | null; foundInstead: string[] }> = [];
  for (const q of questions) {
    const vector = await embedWithRetry(q.q);
    const scope = q.scope ? resolveScope(q.scope, manifest.fileTree) : null;
    const where = scope ? scopeFilter(scope) : undefined;
    const meaning = await query(repo, vector, TOP_K, where);
    const { chunks: hybrid } = await searchChunks(repo, q.q, vector, TOP_K, where);
    const result = {
      q,
      meaning: rankOf(meaning, q.expect),
      hybrid: rankOf(hybrid, q.expect),
      foundInstead: [...new Set(hybrid.map((c) => c.path))].slice(0, 3),
    };
    results.push(result);
    const mark = (r: number | null) => (r === null ? "  ✗ " : `#${r}`.padStart(4));
    console.log(`   ${mark(result.meaning)} ${mark(result.hybrid)}   [${q.kind}] ${q.q}`);
  }

  // Summary, overall and per kind of question.
  console.log("\n   columns above: meaning only, hybrid (#n = where the right file first appeared, ✗ = not in the top 8)\n");
  console.log("   " + "kind".padEnd(8) + "found (meaning)".padEnd(19) + "found (hybrid)".padEnd(19) + "top 3 (hybrid)");
  for (const kind of ["plain", "name", "folder", "all"] as const) {
    const group = results.filter((r) => kind === "all" || r.q.kind === kind);
    if (!group.length) continue;
    const found = (key: "meaning" | "hybrid") => group.filter((r) => r[key] !== null).length;
    const top3 = group.filter((r) => r.hybrid !== null && r.hybrid <= 3).length;
    console.log(
      "   " + kind.padEnd(8) + share(found("meaning"), group.length).padEnd(19) + share(found("hybrid"), group.length).padEnd(19) + share(top3, group.length),
    );
  }

  const misses = results.filter((r) => r.hybrid === null);
  if (misses.length) {
    console.log("\n   Not found (hybrid), and what came up instead:");
    for (const m of misses) console.log(`   - "${m.q.q}" expected ${m.q.expect[0]}; got ${m.foundInstead.join(", ")}`);
  }
}
