// Try-out script (Phase 4.6): indexes a repo and prints progress, then prints its status.
// Needs the AI provider set up in .env (Gemini key, or Ollama with both models pulled).
// Run from the project root:  npx tsx server/scripts/indexRepo.ts owner/repo
import { parseRepoUrl } from "../src/githubClient.js";
import { checkIndexStatus, getJob, startIndexJob } from "../src/indexer.js";

if (!process.argv[2]) {
  console.error("Usage: npx tsx server/scripts/indexRepo.ts owner/repo");
  process.exit(1);
}

const { owner, repo } = parseRepoUrl(process.argv[2]);
startIndexJob(owner, repo);

// Print progress once a second until the job finishes.
let last = "";
while (true) {
  const job = getJob()!;
  const line = `${job.step} ${job.total ? `${job.done}/${job.total}` : ""}`;
  if (line !== last) console.log(line);
  last = line;
  if (job.step === "failed") {
    console.error("Failed:", job.error);
    process.exit(1);
  }
  if (job.step === "ready") break;
  await new Promise((r) => setTimeout(r, 1000));
}

const { status, manifest } = await checkIndexStatus(owner, repo);
console.log(`Status: ${status} — ${manifest?.fileCount} files, ${manifest?.chunkCount} chunks @ ${manifest?.commitSha.slice(0, 7)}`);
