// Try-out script (Phase 5.4): asks one question about an indexed repo and prints the streamed answer and sources.
// Needs the AI provider set up in .env (Gemini key or Ollama) and the repo already indexed (see indexRepo.ts).
// Run from the project root:  npx tsx server/scripts/ask.ts owner/repo "Which function handles login?"
import { parseRepoUrl, toRepoId } from "../src/githubClient.js";
import { answer } from "../src/rag.js";

const [target, question] = process.argv.slice(2);
if (!target || !question) {
  console.error('Usage: npx tsx server/scripts/ask.ts owner/repo "your question"');
  process.exit(1);
}

const { owner, repo } = parseRepoUrl(target);
const { sources, tokens } = await answer(toRepoId(owner, repo), question, []);
for await (const piece of tokens) process.stdout.write(piece);

console.log("\n\nSources:");
for (const s of sources) console.log(`  ${s.path}:L${s.startLine}-L${s.endLine}${s.symbol ? ` (${s.symbol})` : ""}`);
