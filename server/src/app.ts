// Builds the Express app: the HTTP API from ARCHITECTURE §4.2.
// Route handlers stay thin: read the inputs, call a module, send the result.
// Kept separate from index.ts so tests can start the app on any port.
import { existsSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { buildArchitecture } from "./architecture.js";
import { focusGraph, focusMermaid, getCallGraph, listFunctions } from "./callGraph.js";
import {
  appendExchange,
  deleteConversation,
  deleteConversations,
  getConversation,
  isConversationId,
  listConversations,
  MAX_CONVERSATIONS,
  newConversationId,
} from "./chatHistory.js";
import { ROOT_DIR } from "./config.js";
import { getDependencies } from "./dependencies.js";
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

  // Dependency scan: every library and version from package.json, requirements.txt etc. (no AI).
  // Saved at indexing; for repos indexed before this feature it's scanned now (a few seconds).
  app.get("/api/repos/:owner/:repo/dependencies", async (req, res) => {
    const { owner, repo } = repoParams(req);
    res.json(await getDependencies(owner, repo, toRepoId(owner, repo)));
  });

  // Call graph: every function with how many call it and how many it calls, most-called first (for the picker).
  // Built at indexing; for repos indexed before the call graph, it's built now (a few seconds).
  app.get("/api/repos/:owner/:repo/calls", async (req, res) => {
    const { owner, repo } = repoParams(req);
    const graph = await getCallGraph(owner, repo, toRepoId(owner, repo));
    res.json({ commitSha: graph.commitSha, stats: graph.stats, functions: listFunctions(graph) });
  });

  // Call graph focus: one function's callers and callees, and its diagram. ?fn=<function id>&depth=1|2
  // Hotspot files are tinted in the diagram if the history has been analysed.
  app.get("/api/repos/:owner/:repo/calls/focus", async (req, res) => {
    const { owner, repo } = repoParams(req);
    const fn = typeof req.query.fn === "string" ? req.query.fn : "";
    if (!fn) throw new AppError("Pick a function.", 400);
    const depth = req.query.depth === "2" ? 2 : 1;
    const repoId = toRepoId(owner, repo);
    const graph = await getCallGraph(owner, repo, repoId);
    const view = focusGraph(graph, fn, depth);
    const history = (await loadHistory(repoId))?.report ?? null;
    res.json({ commitSha: graph.commitSha, ...view, mermaid: focusMermaid(view, history) });
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

  // Chat: body is { question, history, depth, scope, conversationId }. `scope` (optional) limits the search to a
  // folder or file; it's checked against the indexed files in rag.ts. Streams the answer as Server-Sent Events:
  // "conversation" (which saved chat this goes into), "sources", many "token", "followups" (F3), then "done".
  // Or "error" if something fails. The question and answer are saved once the answer has finished.
  app.post("/api/repos/:owner/:repo/chat", async (req, res) => {
    const { owner, repo } = repoParams(req);
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    const history: ChatMessage[] = Array.isArray(req.body?.history) ? req.body.history : [];
    // F2: the answer style from the toggle. Anything other than "executive" (even a typo) means "technical".
    const depth: AnswerDepth = req.body?.depth === "executive" ? "executive" : "technical";
    const scope = typeof req.body?.scope === "string" ? req.body.scope : ""; // Phase 2: "" = the whole repo
    if (!question) throw new AppError("Please type a question.", 400);
    // Saved chat history: continue the browser's conversation, or start a new one if it has none (or a bad id).
    const conversationId = isConversationId(req.body?.conversationId) ? req.body.conversationId : newConversationId();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // Stop generating if the user leaves the page.
    let closed = false;
    res.on("close", () => (closed = true));

    send("conversation", { id: conversationId });
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
      if (!closed) {
        const followUps = await suggestFollowUps(question, answerText, depth, checkedScope);
        send("followups", followUps);
        // Save the finished question and answer. Why only now: a half-streamed answer is never saved.
        // A failed save is logged but doesn't spoil the answer the user already has.
        await appendExchange(
          toRepoId(owner, repo),
          conversationId,
          { content: question, scope: checkedScope?.path },
          { content: answerText, sources, followUps },
        ).catch((err) => console.error("Chat not saved:", err instanceof Error ? err.message : err));
      }
      send("done", {});
    } catch (err) {
      send("error", { error: userMessage(err) });
    }
    res.end();
  });

  // Saved chat history: the repo's conversations (most recent first), one conversation, or delete some.
  app.get("/api/repos/:owner/:repo/chats", async (req, res) => {
    const { owner, repo } = repoParams(req);
    res.json(await listConversations(toRepoId(owner, repo)));
  });

  app.get("/api/repos/:owner/:repo/chats/:id", async (req, res) => {
    const { owner, repo } = repoParams(req);
    const conversation = isConversationId(req.params.id) ? await getConversation(toRepoId(owner, repo), req.params.id) : null;
    if (!conversation) throw new AppError("That chat doesn't exist (it may have been deleted).", 404);
    res.json(conversation);
  });

  // Delete several chats at once ("Delete selected"). Body: { ids: [...] }. Returns how many were deleted.
  // Why POST: a body on DELETE requests isn't reliably supported.
  app.post("/api/repos/:owner/:repo/chats/delete", async (req, res) => {
    const { owner, repo } = repoParams(req);
    const ids: unknown = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_CONVERSATIONS || !ids.every(isConversationId)) {
      throw new AppError("Pick at least one chat to delete.", 400);
    }
    res.json({ deleted: await deleteConversations(toRepoId(owner, repo), ids) });
  });

  app.delete("/api/repos/:owner/:repo/chats/:id", async (req, res) => {
    const { owner, repo } = repoParams(req);
    const deleted = isConversationId(req.params.id) && (await deleteConversation(toRepoId(owner, repo), req.params.id));
    if (!deleted) throw new AppError("That chat doesn't exist (it may have been deleted).", 404);
    res.json({ ok: true });
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
