// Try-out script (Phase 2.6): lists your repos, then downloads one zip and prints its size.
// Run from the project root:  npx tsx server/scripts/tryGithub.ts [owner/repo]
import { downloadZipball, getLatestCommitSha, getRepo, listAccessibleRepos, parseRepoUrl } from "../src/githubClient.js";

const repos = await listAccessibleRepos();
const privateCount = repos.filter((r) => r.isPrivate).length;
console.log(`Found ${repos.length} repos (${repos.length - privateCount} public, ${privateCount} private):`);
for (const r of repos) {
  console.log(`  ${r.isPrivate ? "[private]" : "[public] "} ${r.owner}/${r.name}  (${r.sizeKb} KB)`);
}

// Download the repo given on the command line, or the first non-empty one.
const target = process.argv[2] ? parseRepoUrl(process.argv[2]) : null;
const pick = target ? await getRepo(target.owner, target.repo) : repos.find((r) => r.sizeKb > 0);
if (pick) {
  const sha = await getLatestCommitSha(pick.owner, pick.name, pick.defaultBranch);
  const zip = await downloadZipball(pick.owner, pick.name, sha);
  console.log(`\nDownloaded ${pick.owner}/${pick.name} @ ${sha.slice(0, 7)}: ${(zip.length / 1024).toFixed(1)} KB zip`);
}
