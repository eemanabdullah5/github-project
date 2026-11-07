// Try-out script (Phase 3.5): downloads a repo and prints file and chunk counts plus a few sample chunks.
// Run from the project root:  npx tsx server/scripts/tryIngest.ts owner/repo
import { chunkFile } from "../src/chunking/index.js";
import { downloadZipball, getLatestCommitSha, getRepo, parseRepoUrl } from "../src/githubClient.js";
import { checkRepoSize, extractSourceFiles } from "../src/ingestion.js";

if (!process.argv[2]) {
  console.error("Usage: npx tsx server/scripts/tryIngest.ts owner/repo");
  process.exit(1);
}

const { owner, repo } = parseRepoUrl(process.argv[2]);
const info = await getRepo(owner, repo);
checkRepoSize(info);
const sha = await getLatestCommitSha(owner, repo, info.defaultBranch);
const files = extractSourceFiles(await downloadZipball(owner, repo, sha));
const chunks = files.flatMap(chunkFile);

console.log(`${owner}/${repo} @ ${sha.slice(0, 7)}: ${files.length} files, ${chunks.length} chunks\n`);
console.log("Files:", files.map((f) => f.path).join(", "), "\n");
for (const c of chunks.slice(0, 3)) {
  console.log("-".repeat(60));
  console.log(c.text.slice(0, 500));
}
