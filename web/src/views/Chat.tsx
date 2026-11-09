// View 2: Chat (PRD FR-3, FR-4, ARCHITECTURE §11).
// Header with the repo name, index status, short commit SHA and the Back / Re-index / Clear buttons.
// Answers stream in word by word, are rendered as Markdown with highlighted code, and list their sources.
// F1: file names in answers and in the Sources list are links that open the code on GitHub.
// F2: Executive / Technical buttons choose how detailed the answers are.
// F3: after each answer, 3 suggested follow-up questions appear as buttons.
// F4: a "Hotspots" tab next to the chat shows what the git history says about the repo.
// F5: a "Report" tab shows a one-page health report that can be downloaded.
// Phase 4: an "Architecture" tab shows the module map built from the import graph.
// The messages themselves live in App.tsx, so they are cleared when the user switches repo.
import { AlertCircle, ArrowLeft, ArrowRight, ArrowUp, Check, CircleDashed, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import { getStatus, startIndex, streamChat, type AnswerDepth, type ChatMessage, type Repo, type StatusResponse } from "../api";
import Architecture from "../components/Architecture";
import HealthReport from "../components/HealthReport";
import Hotspots from "../components/Hotspots";
import IndexProgress from "../components/IndexProgress";
import { CitationWarning, markdownComponents } from "../components/CitationLink";
import { linkCitations, sourceUrl, type LinkTarget } from "../sourceLinks";

/** The 4 example questions shown before the first message (PRD FR-4.5). */
const STARTER_QUESTIONS = [
  "Summarise this project and its tech stack",
  "How is it structured?",
  "What external services does it depend on?",
  "What are the main risks or tech debt?",
];

// F2: reads the answer style the user picked last time (saved in the browser).
// If they never picked one, use "technical", the full detailed answer.
function initialDepth(): AnswerDepth {
  return localStorage.getItem("answerDepth") === "executive" ? "executive" : "technical";
}

/** The tooltip and hint text for each answer style. */
const DEPTH_HINTS: Record<AnswerDepth, string> = {
  executive: "Short, plain-language answers for leaders. No code.",
  technical: "Full detail with code, for developers.",
};

/** How many past question/answer pairs are sent with each new question. */
const HISTORY_TURNS = 3;

interface Props {
  repo: Repo;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  onBack: () => void;
}

export default function Chat({ repo, messages, setMessages, onBack }: Props) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reindexing, setReindexing] = useState(false);
  const [depth, setDepth] = useState<AnswerDepth>(initialDepth); // F2: the selected answer style
  const [tab, setTab] = useState<"chat" | "hotspots" | "architecture" | "report">("chat"); // F4/F5/Phase 4: which tab is showing
  const bottomRef = useRef<HTMLDivElement>(null);

  /** Loads the index status and commit SHA for the header. */
  function loadStatus() {
    getStatus(repo.owner, repo.name)
      .then(setStatus)
      .catch((err) => setError(err.message));
  }

  useEffect(loadStatus, [repo.owner, repo.name]);

  // F2: whenever the answer style changes, save it so it's remembered next time.
  useEffect(() => localStorage.setItem("answerDepth", depth), [depth]);

  // Keep the newest message in view as the answer streams in.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  /** Changes the last message (the answer being streamed). */
  function updateLastMessage(change: (m: ChatMessage) => ChatMessage) {
    setMessages((prev) => [...prev.slice(0, -1), change(prev[prev.length - 1])]);
  }

  /** Sends a question, then fills in the answer as pieces arrive from the server. */
  async function ask(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    const history = messages.slice(-HISTORY_TURNS * 2);
    setInput("");
    setError("");
    setBusy(true);
    setMessages((prev) => [...prev, { role: "user", content: text }, { role: "assistant", content: "", sources: [] }]);
    try {
      await streamChat(repo.owner, repo.name, text, history, depth, {
        onSources: (sources) => updateLastMessage((m) => ({ ...m, sources })),
        onToken: (token) => updateLastMessage((m) => ({ ...m, content: m.content + token })),
        // F3: save the suggested questions on the answer, so they show under it.
        onFollowUps: (followUps) => updateLastMessage((m) => ({ ...m, followUps })),
      });
    } catch (err) {
      setError((err as Error).message);
      // Remove the empty answer if nothing arrived before the error.
      setMessages((prev) => (prev[prev.length - 1]?.content ? prev : prev.slice(0, -1)));
    } finally {
      setBusy(false);
    }
  }

  /** Starts a fresh index of this repo and shows progress in place. */
  async function reindex() {
    setError("");
    try {
      await startIndex(repo.owner, repo.name);
      setReindexing(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const shortSha = status?.manifest?.commitSha.slice(0, 7);
  // F1: which repo and version the GitHub links open.
  // We use the commit we indexed, so the line numbers match the code the AI read.
  // (If the status hasn't loaded yet, we fall back to the repo's default branch, e.g. main.)
  const linkTarget: LinkTarget = { owner: repo.owner, name: repo.name, ref: status?.manifest?.commitSha ?? repo.defaultBranch };
  const statusLabel = status ? { fresh: "Up to date", stale: "New commits since indexing", missing: "Not indexed" }[status.status] : "Checking…";

  const StatusIcon = status?.status === "fresh" ? Check : status?.status === "stale" ? TriangleAlert : CircleDashed;

  return (
    <>
      <div className="chat-bar">
        <div className="chat-bar-inner">
          <div className="chat-bar-top">
            <div className="chat-bar-left">
              <button className="ghost" onClick={onBack}>
                <ArrowLeft size={16} aria-hidden="true" />
                Back to repos
              </button>
              <span className="vsep" aria-hidden="true" />
              <div className="repo-heading">
                <h2>
                  {repo.owner}/{repo.name}
                </h2>
                <p>
                  <span className={`status ${status?.status ?? ""}`}>
                    {status && <StatusIcon size={13} strokeWidth={2.5} aria-hidden="true" />}
                    {statusLabel}
                  </span>
                  {shortSha && (
                    <>
                      <span aria-hidden="true">·</span>
                      <code className="small">{shortSha}</code>
                    </>
                  )}
                  {status?.manifest && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{status.manifest.fileCount} files</span>
                    </>
                  )}
                </p>
              </div>
            </div>
            <div className="row">
              <button className="secondary" onClick={reindex} disabled={reindexing || busy}>
                <RefreshCw size={14} aria-hidden="true" />
                Re-index
              </button>
              <button className="secondary" onClick={() => setMessages([])} disabled={busy || messages.length === 0}>
                <Trash2 size={14} aria-hidden="true" />
                Clear chat
              </button>
            </div>
          </div>

          {/* F4: tabs. The chat messages are kept while you look at Hotspots or the Report. */}
          <div className="tabs" role="tablist" aria-label="Repository views">
            {(
              [
                ["chat", "Chat"],
                ["hotspots", "Hotspots"],
                ["architecture", "Architecture"],
                ["report", "Report"],
              ] as const
            ).map(([key, label]) => (
              <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? "tab active" : "tab"} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {reindexing && (
        <div className="chat-progress">
          <IndexProgress
            onReady={() => {
              setReindexing(false);
              loadStatus();
            }}
            onFailed={(msg) => {
              setReindexing(false);
              setError(msg);
            }}
          />
        </div>
      )}

      {tab === "hotspots" && <Hotspots repo={repo} />}
      {tab === "architecture" && <Architecture repo={repo} />}
      {tab === "report" && <HealthReport repo={repo} />}

      {/* Everything below is the Chat tab. */}
      {tab === "chat" && (
        <main className="chat-column">
          <div className="messages" aria-busy={busy}>
            {messages.length === 0 && (
              <div className="starters">
                <p className="muted">Try one of these:</p>
                {STARTER_QUESTIONS.map((q) => (
                  <button key={q} className="secondary suggestion" onClick={() => ask(q)} disabled={busy || reindexing}>
                    {q}
                    <ArrowRight size={14} aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}

            {messages.map((m, i) => {
              const isLatest = i === messages.length - 1;
              const finished = !(busy && isLatest); // this answer has stopped streaming
              return m.role === "user" ? (
                <div key={i} className="message user">
                  <span className="message-label">You</span>
                  <p>{m.content}</p>
                </div>
              ) : (
                <article key={i} className="message assistant" aria-label="Answer">
                  <span className="message-label">Answer</span>
                  {m.content ? (
                    // No rehype-raw: raw HTML in model output is never rendered (ARCHITECTURE §13).
                    // F1: linkCitations turns [file:L10-L16] in the answer into GitHub links before showing it.
                    <div className="markdown">
                      <ReactMarkdown rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
                        {linkCitations(m.content, linkTarget, m.sources ?? [])}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p className="thinking">Thinking…</p>
                  )}
                  {/* Verified citations: warn once the answer has finished if any citation points to code the AI wasn't shown. */}
                  {finished && <CitationWarning markdown={m.content} sources={m.sources ?? []} />}
                  {/* Sources show once the answer has finished streaming. */}
                  {finished && m.sources && m.sources.length > 0 && (
                    <details className="sources">
                      <summary>Sources ({m.sources.length})</summary>
                      <ul>
                        {m.sources.map((s, j) => (
                          <li key={j}>
                            {/* F1: each source is a link to those lines on GitHub, opened in a new tab. */}
                            <a href={sourceUrl(linkTarget, s)} target="_blank" rel="noopener noreferrer">
                              {s.path}:L{s.startLine}-L{s.endLine}
                            </a>
                            {s.symbol && <span className="symbol">{s.symbol}</span>}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {/* F3: suggested questions. Only under the latest answer, and only after it has finished.
                      Clicking one asks it straight away. */}
                  {isLatest && !busy && m.followUps && m.followUps.length > 0 && (
                    <div className="follow-ups">
                      <span>Ask next:</span>
                      {m.followUps.map((q) => (
                        <button key={q} className="secondary suggestion" onClick={() => ask(q)} disabled={reindexing}>
                          {q}
                          <ArrowRight size={14} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
            <div ref={bottomRef} />
          </div>

          <div className="composer">
            {error && (
              <p className="error" role="alert">
                <AlertCircle size={16} aria-hidden="true" />
                <span>{error}</span>
              </p>
            )}

            {/* F2: the answer-style switch. The choice applies to the next question and is remembered. */}
            <div className="depth-row">
              <div className="segmented" role="radiogroup" aria-label="Answer style">
                {(["executive", "technical"] as const).map((d) => (
                  <button
                    key={d}
                    role="radio"
                    aria-checked={depth === d}
                    className="segment"
                    onClick={() => setDepth(d)}
                    disabled={busy}
                    title={DEPTH_HINTS[d]}
                  >
                    {d === "executive" ? "Executive" : "Technical"}
                  </button>
                ))}
              </div>
              <span className="depth-hint">{DEPTH_HINTS[depth]}</span>
            </div>

            <form
              className="ask-form"
              onSubmit={(e) => {
                e.preventDefault();
                ask(input);
              }}
            >
              <label htmlFor="question" className="sr-only">
                Ask a question about this repo
              </label>
              <input
                id="question"
                type="text"
                placeholder="Ask a question about this repo"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={reindexing || busy}
                autoComplete="off"
              />
              <button type="submit" disabled={busy || reindexing || !input.trim()}>
                {busy ? (
                  "Answering…"
                ) : (
                  <>
                    Send
                    <ArrowUp size={14} strokeWidth={2.25} aria-hidden="true" />
                  </>
                )}
              </button>
            </form>
          </div>
        </main>
      )}
    </>
  );
}
