// Chunking comparison (Phase 10.5, ARCHITECTURE §16, DECISIONS D8).
// For each test repo, it chunks the code two ways, "syntax + line" and "line only", embeds
// both, and checks how often the expected file shows up in the top 8 results (hit@8).
// Everything stays in memory: the real index in data/ is not touched.
// Needs Ollama running with EMBED_MODEL pulled.
//
// Run from the project root:  npx tsx server/scripts/evalRetrieval.ts questions.json
//
// questions.json lists about 15 questions per repo, each with the file that answers it.
// "line" is optional: if given, the chunk must also cover that line.
// [
//   { "repo": "owner/python-repo", "questions": [
//       { "question": "Where are passwords hashed?", "path": "app/auth.py", "line": 42 }
//   ] },
//   { "repo": "owner/ts-repo", "questions": [ … ] }
// ]
import { readFile } from "node:fs/promises";
import { chunkFile } from "../src/chunking/index.js";
import { lineChunker } from "../src/chunking/lineChunker.js";
import { TOP_K } from "../src/config.js";
import { downloadZipball, getLatestCommitSha, getRepo, parseRepoUrl } from "../src/githubClient.js";
import { checkRepoSize, extractSourceFiles } from "../src/ingestion.js";
import { embedDocuments, embedQuery } from "../src/llm.js";
import type { Chunk } from "../src/types.js";

interface Question {
  question: string;
  path: string;
  line?: number;
}

/** How alike two vectors are (1 = same direction). The same measure the vector store uses. */
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Percentage of questions whose expected file (and line, if given) is in the top K chunks. */
function hitRate(chunks: Chunk[], vectors: number[][], questions: Question[], queryVectors: number[][]): number {
  let hits = 0;
  questions.forEach((q, qi) => {
    const top = chunks
      .map((chunk, i) => ({ chunk, score: cosine(queryVectors[qi], vectors[i]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K);
    const hit = top.some(({ chunk }) => chunk.path === q.path && (q.line === undefined || (chunk.startLine <= q.line && q.line <= chunk.endLine)));
    if (hit) hits++;
  });
  return (100 * hits) / questions.length;
}

if (!process.argv[2]) {
  console.error("Usage: npx tsx server/scripts/evalRetrieval.ts questions.json");
  process.exit(1);
}

const suites = JSON.parse(await readFile(process.argv[2], "utf8")) as Array<{ repo: string; questions: Question[] }>;

for (const suite of suites) {
  const { owner, repo } = parseRepoUrl(suite.repo);
  const info = await getRepo(owner, repo);
  checkRepoSize(info);
  const sha = await getLatestCommitSha(owner, repo, info.defaultBranch);
  const files = extractSourceFiles(await downloadZipball(owner, repo, sha));

  const syntaxChunks = (await Promise.all(files.map(chunkFile))).flat();
  const lineChunks = files.flatMap(lineChunker);
  const queryVectors = await Promise.all(suite.questions.map((q) => embedQuery(q.question)));

  console.log(`\n${suite.repo} @ ${sha.slice(0, 7)} — ${files.length} files, ${suite.questions.length} questions`);
  const syntaxScore = hitRate(syntaxChunks, await embedDocuments(syntaxChunks.map((c) => c.text)), suite.questions, queryVectors);
  console.log(`  syntax + line: ${syntaxChunks.length} chunks, hit@${TOP_K} = ${syntaxScore.toFixed(0)}%`);
  const lineScore = hitRate(lineChunks, await embedDocuments(lineChunks.map((c) => c.text)), suite.questions, queryVectors);
  console.log(`  line only:     ${lineChunks.length} chunks, hit@${TOP_K} = ${lineScore.toFixed(0)}%`);
}

console.log("\nThe sample is small, so treat these results as directional only.");
