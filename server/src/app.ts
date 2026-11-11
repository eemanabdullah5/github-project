// Builds the Express app: the HTTP API from ARCHITECTURE §4.2.
// Route handlers stay thin: read the inputs, call a module, send the result.
// Kept separate from index.ts so tests can start the app on any port.
import { existsSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { buildArchitecture } from "./architecture.js";
import { ROOT_DIR } from "./config.js";
import { AppError } from "./errors.js";
import { getRepo, listAccessibleRepos, parseRepoUrl, toRepoId } from "./githubClient.js";
import { analyzeHistory, loadHistory } from "./gitHistory.js";
import { getGraph, summarizeGraph } from "./importGraph.js";
import { checkIndexStatus, getJob, startIndexJob } from "./indexer.js";
import type { AnswerDepth } from "./prompts.js";
import { answer, suggestFollowUps } from "./rag.js";
import { generateReport, loadReport } from "./report.js";
import { listFolders } from "./scope.js";
import type { ChatMessage, Repo } from "./types.js";

/** The repo list, kept in memory so we don't ask GitHub again on every page load. */
let repoCache: Repo[] | null = null;

/** Reads :owner and :repo from the URL and checks they are valid GitHub names. */
function repoParams(req: Request): { owner: string; repo: string } {
  return parseRepoUrl(`${req.params.owner}/${req.params.repo}`);
}

export function createApp() {
  const app = express();
  app.use(express.json());

  // Simple check that the server is up.
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // All repos the token can access. ?refresh=1 asks GitHub again instead of using the cache.
  app.get("/api/repos", async (req, res) => {
    if (!repoCache || req.query.refresh === "1") {
      repoCache = await listAccessibleRepos();
    }
    res.json(repoCache);
  });

  // One repo, looked up by owner/name (used by the paste-a-URL box).
  app.get("/api/repos/:owner/:repo", async (req, res) => {
    const { owner, repo } = repoParams(req);
    res.json(await getRepo(owner, repo));
  });

  // Whether the repo's index is missing, fresh or stale, plus a short summary of it.
  app.get("/api/repos/:owner/:repo/status", async (req, res) => {
    const { owner, repo } = repoParams(req);
    const { status, manifest } = await checkIndexStatus(owner, repo);
    res.json({
      status,
      manifest: manifest && {
        commitSha: manifest.commitSha,
        branch: manifest.branch,
        indexedAt: manifest.indexedAt,
        fileCount: manifest.fileCount,
        chunkCount: manifest.chunkCount,
        // Phase 2: for the "Ask about one folder" picker. Files too, so a single file can be picked.
        folders: listFolders(manifest.fileTree),
        files: manifest.fileTree.split("\n").filter(Boolean),
      },
    });
  });

  // Starts indexing in the background. Returns 409 if another job is already running.
  app.post("/api/repos/:owner/:repo/index", (req, res) => {
    const { owner, repo } = repoParams(req);
    res.status(202).json(startIndexJob(owner, repo));
  });

  // F4: the saved hotspot report for a repo. 404 if it hasn't been analysed yet.
  app.get("/api/repos/:owner/:repo/hotspots", async (req, res) => {
    const { owner, repo } = repoParams(req);
    const history = await loadHistory(toRepoId(owner, repo));
    if (!history) throw new AppError("This repo's history hasn't been analysed yet.", 404);
    res.json(history.report);
  });

  // F4: analyse the repo's git history now ("Analyse history" button), then return the new report.
  app.post("/api/repos/:owner/:repo/hotspots", async (req, res) => {
    const { owner, repo } = repoParams(req);
    res.json(await analyzeHistory(owner, repo));
  });

  // F5: the saved health report for a repo. 404 if none has been generated yet.
  app.get("/api/repos/:owner/:repo/report", async (req, res) => {
    const { owner, repo } = repoParams(req);
    const report = await loadReport(toRepoId(owner, repo));
    if (!report) throw new AppError("No health report has been generated for this repo yet.", 404);
    res.json(report);
  });

  // F5: generate a new health report now ("Generate" / "Regenerate" button). Takes about 20-40 seconds.
  app.post("/api/repos/:owner/:repo/report", async (req, res) => {
    const { owner, repo } = repoParams(req);
    res.json(await generateReport(toRepoId(owner, repo)));
  });

  // Phase 4: the import graph (which file imports which) for the indexed commit, plus a short summary.
  // Built during indexing; for repos indexed before this feature it's built now (a few seconds).
  app.get("/api/repos/:owner/:repo/graph", async (req, res) => {
    const { owner, repo } = repoParams(req);
    const graph = await getGraph(owner, repo, toRepoId(owner, repo));
    res.json({ ...graph, summary: summarizeGraph(graph) });
  });

  // Phase 4: the architecture map (modules, the imports between them, cycles, hotspot colours, Mermaid diagram).
  // Built from the import graph; uses the F4 hotspots if the history has been analysed.
  app.get("/api/repos/:owner/:repo/architecture", async (req, res) => {
    const { owner, repo } = repoParams(req);
    const repoId = toRepoId(owner, repo);
    const graph = await getGraph(owner, repo, repoId);
    const history = (await loadHistory(repoId))?.report ?? null;
    res.json(buildArchitecture(graph, history));
  });

  // The current indexing job, for the progress panel (polled every second).
  app.get("/api/index-job", (_req, res) => {
    res.json(getJob());
  });

  // Chat: body is { question, history, depth, scope }. `scope` (optional) limits the search to a folder or file;
  // it's checked against the indexed files in rag.ts. Streams the answer as Server-Sent Events in this order:
  // "sources", then many "token", then "followups" (F3), then "done". Or "error" if something fails.
  app.post("/api/repos/:owner/:repo/chat", async (req, res) => {
    const { owner, repo } = repoParams(req);
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    const history: ChatMessage[] = Array.isArray(req.body?.history) ? req.body.history : [];
    // F2: the answer style from the toggle. Anything other than "executive" (even a typo) means "technical".
    const depth: AnswerDepth = req.body?.depth === "executive" ? "executive" : "technical";
    const scope = typeof req.body?.scope === "string" ? req.body.scope : ""; // Phase 2: "" = the whole repo
    if (!question) throw new AppError("Please type a question.", 400);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // Stop generating if the user leaves the page.
    let closed = false;
    res.on("close", () => (closed = true));

    try {
      const { sources, tokens, scope: checkedScope } = await answer(toRepoId(owner, repo), question, history, depth, scope);
      send("sources", sources);
      let answerText = ""; // F3: keep a copy of the full answer, to base the follow-up questions on
      for await (const token of tokens) {
        if (closed) break;
        answerText += token;
        send("token", token);
      }
      // F3: once the answer is complete, send 3 suggested follow-up questions (skipped if the user left).
      // Phase 2: if a folder or file was picked, the suggestions are about it too.
      if (!closed) send("followups", await suggestFollowUps(question, answerText, depth, checkedScope));
      send("done", {});
    } catch (err) {
      send("error", { error: userMessage(err) });
    }
    res.end();
  });

  // For normal use (after `npm run build`), Express also serves the built web app.
  const webDist = path.join(ROOT_DIR, "web", "dist");
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  }

  app.use(errorHandler);
  return app;
}

/** The message to show the user: the AppError's own message, or a generic one for anything else. */
function userMessage(err: unknown): string {
  if (err instanceof AppError) return err.message;
  // Log only the message: never the request, headers or config, which could hold the token.
  console.error("Unexpected error:", err instanceof Error ? err.message : err);
  return "Something went wrong on the server. Please try again.";
}

// Express recognises an error handler by its four parameters.
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  res.status(err instanceof AppError ? err.status : 500).json({ error: userMessage(err) });
}
