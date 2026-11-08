// View 2: Chat (PRD FR-3, FR-4, ARCHITECTURE §11).
// Header with the repo name, index status, short commit SHA and the Back / Re-index / Clear buttons.
// Answers stream in word by word, are rendered as Markdown with highlighted code, and list their sources.
// F1: file names in answers and in the Sources list are links that open the code on GitHub.
// The messages themselves live in App.tsx, so they are cleared when the user switches repo.
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import { getStatus, startIndex, streamChat, type ChatMessage, type Repo, type StatusResponse } from "../api";
import IndexProgress from "../components/IndexProgress";
import { linkCitations, sourceUrl, type LinkTarget } from "../sourceLinks";

// F1: makes every link inside an answer open in a new tab, so the chat stays open.
const markdownComponents = {
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

/** The 4 example questions shown before the first message (PRD FR-4.5). */
const STARTER_QUESTIONS = [
  "Summarise this project and its tech stack",
  "How is it structured?",
  "What external services does it depend on?",
  "What are the main risks or tech debt?",
];

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
  const bottomRef = useRef<HTMLDivElement>(null);

  /** Loads the index status and commit SHA for the header. */
  function loadStatus() {
    getStatus(repo.owner, repo.name)
      .then(setStatus)
      .catch((err) => setError(err.message));
  }

  useEffect(loadStatus, [repo.owner, repo.name]);

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
      await streamChat(repo.owner, repo.name, text, history, {
        onSources: (sources) => updateLastMessage((m) => ({ ...m, sources })),
        onToken: (token) => updateLastMessage((m) => ({ ...m, content: m.content + token })),
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

  return (
    <section className="chat">
      <div className="chat-header">
        <button className="secondary" onClick={onBack}>← Back to repos</button>
        <div className="grow">
          <strong>{repo.owner}/{repo.name}</strong>
          <div className="muted small">
            {statusLabel}
            {shortSha && ` · ${shortSha}`}
            {status?.manifest && ` · ${status.manifest.fileCount} files`}
          </div>
        </div>
        <button className="secondary" onClick={reindex} disabled={reindexing || busy}>Re-index</button>
        <button className="secondary" onClick={() => setMessages([])} disabled={busy || messages.length === 0}>Clear chat</button>
      </div>

      {reindexing && (
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
      )}

      <div className="messages">
        {messages.length === 0 && (
          <div className="starters">
            <p className="muted">Try one of these:</p>
            {STARTER_QUESTIONS.map((q) => (
              <button key={q} className="secondary" onClick={() => ask(q)} disabled={busy || reindexing}>{q}</button>
            ))}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`message ${m.role}`}>
            {m.role === "user" ? (
              <p>{m.content}</p>
            ) : (
              <>
                {m.content ? (
                  // No rehype-raw: raw HTML in model output is never rendered (ARCHITECTURE §13).
                  // F1: linkCitations turns [file:L10-L16] in the answer into GitHub links before showing it.
                  <ReactMarkdown rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
                    {linkCitations(m.content, linkTarget, m.sources ?? [])}
                  </ReactMarkdown>
                ) : (
                  <p className="muted">Thinking…</p>
                )}
                {m.sources && m.sources.length > 0 && (
                  <details className="sources">
                    <summary>Sources ({m.sources.length})</summary>
                    <ul>
                      {m.sources.map((s, j) => (
                        <li key={j}>
                          {/* F1: each source is a link to those lines on GitHub, opened in a new tab. */}
                          <a href={sourceUrl(linkTarget, s)} target="_blank" rel="noopener noreferrer">
                            <code>{s.path}:L{s.startLine}-L{s.endLine}</code>
                          </a>
                          {s.symbol && <span className="muted"> {s.symbol}</span>}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {error && <p className="error">{error}</p>}

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <input
          className="grow"
          placeholder="Ask a question about this repo"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={reindexing}
        />
        <button type="submit" disabled={busy || reindexing || !input.trim()}>
          {busy ? "Answering…" : "Send"}
        </button>
      </form>
    </section>
  );
}
