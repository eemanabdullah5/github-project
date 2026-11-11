// Indexer (ARCHITECTURE §4.1, §8.3): runs the background job that turns a repo into a searchable index.
// Steps: Download the zip → Process (pick files and cut them into chunks) → Embed (turn
// chunks into vectors) → Save. Only one job runs at a time. The UI polls getJob() for progress.
// Re-index only embeds chunks that changed; unchanged ones keep their saved vectors (reuseEmbeddings.ts).
import { buildCallGraph, saveCallGraph } from "./callGraph.js";
import { chunkFile } from "./chunking/index.js";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { downloadZipball, getLatestCommitSha, getRepo, toRepoId } from "./githubClient.js";
import { saveDependencies, scanDependencies } from "./dependencies.js";
import { buildImportGraph, saveGraph } from "./importGraph.js";
import { checkRepoSize, extractSourceFiles } from "./ingestion.js";
import { checkModels, embedDocuments } from "./llm.js";
import { planEmbedding } from "./reuseEmbeddings.js";
import type { IndexJob, IndexStatus, Manifest, SourceFile } from "./types.js";
import { loadManifest, loadSavedVectors, saveIndex } from "./vectorStore.js";

/** The current (or last finished) job. Lives in memory only, so a server restart forgets it. */
let job: IndexJob | null = null;

/** Returns the current job so the UI can show progress, or null if none has run yet. */
export function getJob(): IndexJob | null {
  return job;
}

/** True while a job is still working (not ready and not failed). */
function isRunning(): boolean {
  return job !== null && job.step !== "ready" && job.step !== "failed";
}

/**
 * Starts indexing a repo in the background and returns straight away.
 * Throws a 409 error if another repo is already being indexed.
 * Any failure during the job is saved in job.error for the UI to show.
 */
export function startIndexJob(owner: string, repo: string): IndexJob {
  if (isRunning()) {
    throw new AppError(`Another repo is being indexed (${job!.repoId}). Please wait for it to finish.`, 409);
  }
  const current: IndexJob = {
    repoId: toRepoId(owner, repo),
    step: "downloading",
    done: 0,
    total: 0,
    error: null,
    startedAt: new Date().toISOString(),
  };
  job = current;

  runJob(current, owner, repo).catch((err) => {
    current.step = "failed";
    current.error =
      err instanceof AppError ? err.message : "Indexing failed because of an unexpected error. Please try again.";
    if (!(err instanceof AppError)) console.error("Indexing error:", err instanceof Error ? err.message : err);
  });
  return current;
}

/** The actual work of the job. Updates `current` as it goes so the UI can show each step. */
async function runJob(current: IndexJob, owner: string, repo: string): Promise<void> {
  // Check the models first, so we don't download a repo only to fail at the embedding step.
  await checkModels();

  // 1. Download
  const info = await getRepo(owner, repo);
  if (info.sizeKb === 0) throw new AppError("This repo is empty, so there is nothing to index.", 400);
  checkRepoSize(info);
  const sha = await getLatestCommitSha(owner, repo, info.defaultBranch);
  const zip = await downloadZipball(owner, repo, sha);

  // 2. Process: pick the useful files and cut each one into chunks.
  current.step = "processing";
  const files = extractSourceFiles(zip);
  current.total = files.length;
  const chunks = [];
  for (const file of files) {
    chunks.push(...(await chunkFile(file)));
    current.done++;
  }
  if (chunks.length === 0) throw new AppError("No readable source files were found in this repo.", 400);

  // 3. Embed: turn each new or changed chunk into a vector. Unchanged chunks reuse their saved vector.
  current.step = "embedding";
  const plan = planEmbedding(chunks, await savedVectorsFor(current.repoId));
  current.done = 0;
  current.total = plan.toEmbed.length; // the progress bar counts only the chunks that need the AI
  current.reused = plan.reused;
  const fresh = await embedDocuments(
    plan.toEmbed.map((c) => c.text),
    (done) => (current.done = done),
  );
  const vectors = plan.combine(fresh);
  console.log(`Indexed ${current.repoId}: embedded ${fresh.length} of ${chunks.length} chunks, reused ${plan.reused}.`);

  // 4. Save the table, then the manifest last.
  const manifest: Manifest = {
    repoId: current.repoId,
    commitSha: sha,
    branch: info.defaultBranch,
    indexedAt: new Date().toISOString(),
    embedModel: config.embedModel,
    fileCount: files.length,
    chunkCount: chunks.length,
    fileTree: files.map((f) => f.path).join("\n"),
    readme: findReadme(files),
  };
  await saveIndex(current.repoId, chunks, vectors, manifest);

  // 5. Phase 4: build the import graph from the same files (local parsing, no AI, a few seconds).
  // A failure here must not fail the index: the graph is rebuilt the first time it's asked for.
  try {
    await saveGraph(await buildImportGraph(files, { repoId: current.repoId, commitSha: sha }));
  } catch (err) {
    console.error("Import graph failed:", err instanceof Error ? err.message : err);
  }

  // 6. Dependency scan: read package.json, requirements.txt etc. (no AI, instant).
  // Same rule: a failure must not fail the index, it's redone the first time it's asked for.
  try {
    await saveDependencies(scanDependencies(files, { repoId: current.repoId, commitSha: sha }));
  } catch (err) {
    console.error("Dependency scan failed:", err instanceof Error ? err.message : err);
  }

  // 7. Call graph: which function calls which (local parsing, no AI, a few seconds).
  // Same rule: a failure must not fail the index, it's rebuilt the first time it's asked for.
  try {
    await saveCallGraph(await buildCallGraph(files, { repoId: current.repoId, commitSha: sha }));
  } catch (err) {
    console.error("Call graph failed:", err instanceof Error ? err.message : err);
  }
  current.step = "ready";
}

/**
 * The previous index's vectors, so unchanged chunks don't have to be embedded again.
 * Empty (embed everything) if there's no previous index, or it was made with a different embedding model.
 * Why the model check: vectors from two models can't be mixed, they don't mean the same thing.
 * If reading them fails, it embeds everything instead of failing the index.
 */
async function savedVectorsFor(repoId: string): Promise<Map<string, number[]>> {
  const previous = await loadManifest(repoId);
  if (!previous || previous.embedModel !== config.embedModel) return new Map();
  try {
    return await loadSavedVectors(repoId);
  } catch (err) {
    console.error("Couldn't read the saved vectors, embedding everything:", err instanceof Error ? err.message : err);
    return new Map();
  }
}

/** Finds the README in the repo's top folder (any extension), or returns "" if there isn't one. */
function findReadme(files: SourceFile[]): string {
  return files.find((f) => /^readme(\.[a-z]+)?$/i.test(f.path))?.text ?? "";
}

/**
 * Tells the UI whether a repo's index can be used:
 *  - "missing": never indexed (no manifest)
 *  - "stale":   the repo has new commits, or the embedding model has changed since indexing
 *  - "fresh":   up to date
 */
export async function checkIndexStatus(
  owner: string,
  repo: string,
): Promise<{ status: IndexStatus; manifest: Manifest | null }> {
  const manifest = await loadManifest(toRepoId(owner, repo));
  if (!manifest) return { status: "missing", manifest: null };

  const info = await getRepo(owner, repo);
  const latestSha = await getLatestCommitSha(owner, repo, info.defaultBranch);
  const stale = latestSha !== manifest.commitSha || manifest.embedModel !== config.embedModel;
  return { status: stale ? "stale" : "fresh", manifest };
}
