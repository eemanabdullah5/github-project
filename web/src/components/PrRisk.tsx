// PR risk tab: pick a pull request, then see its risk score with reasons, what it changes, how far that
// spreads, which tests reach it, files usually changed with it, and suggested reviewers.
import { AlertCircle, AlertTriangle, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { getPrBriefing, listPullRequests, type PrBriefing, type PullRequestInfo, type Repo } from "../api";
import { HELP } from "../helpTexts";
import { githubLineUrl } from "../sourceLinks";
import { Stat } from "./Hotspots";
import { InfoHeading } from "./InfoHelp";

interface Props {
  repo: Repo;
}

/** Reads "https://github.com/o/r/pull/12", "#12" or "12"; null if it isn't a PR of this repo. */
function prNumber(input: string, repo: Repo): number | null {
  const text = input.trim();
  const url = text.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i);
  if (url) return url[1].toLowerCase() === repo.owner.toLowerCase() && url[2].toLowerCase() === repo.name.toLowerCase() ? Number(url[3]) : null;
  const num = text.match(/^#?(\d+)$/);
  return num && Number(num[1]) > 0 ? Number(num[1]) : null;
}

const LEVEL_LABEL = { low: "Low risk", medium: "Medium risk", high: "High risk" };

/** "10 Nov 2026" */
const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** " · complexity 6 → 14" (highlighted when it rose by 5+), or " · new, complexity 9". */
function ComplexityChange({ before, after }: { before: number | null; after: number }) {
  if (before === null) return <> · new, complexity {after}</>;
  const rise = after - before;
  return (
    <>
      {" "}
      · complexity{" "}
      <span className={rise >= 5 ? "pr-del" : undefined}>
        {before} → {after}
      </span>
    </>
  );
}

export default function PrRisk({ repo }: Props) {
  const [open, setOpen] = useState<PullRequestInfo[] | null>(null);
  const [input, setInput] = useState("");
  const [briefing, setBriefing] = useState<PrBriefing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Open PRs for the quick buttons.
  useEffect(() => {
    setOpen(null);
    setBriefing(null);
    listPullRequests(repo.owner, repo.name)
      .then(setOpen)
      .catch(() => setOpen([]));
  }, [repo.owner, repo.name]);

  async function check(number: number) {
    setError("");
    setLoading(true);
    setBriefing(null);
    try {
      setBriefing(await getPrBriefing(repo.owner, repo.name, number));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = prNumber(input, repo);
    if (n) check(n);
    else setError(`Use a pull request number like 12, or a link to a PR in ${repo.owner}/${repo.name}.`);
  }

  return (
    <div className="tab-page">
      {/* 1. Pick a PR */}
      <section className="panel" aria-label="Choose a pull request">
        <div className="section-head">
          <h2>Check a pull request</h2>
          <p>A risk score with its reasons, what the PR changes, how far that spreads, and who should review it.</p>
        </div>
        <form className="calls-picker-row" onSubmit={submit}>
          <label htmlFor="pr-input">Pull request</label>
          <input
            id="pr-input"
            type="text"
            placeholder="PR link or number, e.g. 12"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" disabled={loading || !input.trim()}>
            {loading ? "Checking…" : "Check"}
          </button>
        </form>
        {open && open.length > 0 && (
          <div className="calls-quick">
            <span className="muted small">Open PRs:</span>
            {open.slice(0, 8).map((p) => (
              <button key={p.number} className="secondary suggestion" onClick={() => check(p.number)} aria-pressed={briefing?.pr.number === p.number} title={p.title}>
                #{p.number} {p.title.length > 40 ? `${p.title.slice(0, 40)}…` : p.title}
              </button>
            ))}
          </div>
        )}
        {open?.length === 0 && <p className="muted small">No open pull requests. You can still check any PR, open or closed, by its number.</p>}
      </section>

      {error && (
        <p className="error" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
      {loading && (
        <p className="muted" role="status">
          Reading the PR and its code from GitHub… this takes a few seconds for big repos.
        </p>
      )}

      {briefing && <Briefing b={briefing} repo={repo} />}
    </div>
  );
}

/** The briefing for one PR. */
function Briefing({ b, repo }: { b: PrBriefing; repo: Repo }) {
  const { pr, risk } = b;
  const lineUrl = (path: string, line: number) => githubLineUrl({ owner: repo.owner, name: repo.name, ref: pr.headSha }, path, line, line);
  const fnName = (fn: { kind: string; qualified: string; file: string }) => (fn.kind === "top-level" ? `${fn.file.split("/").pop()} (top level)` : `${fn.qualified}()`);

  return (
    <>
      {/* 2. Which PR */}
      <div className="top-line">
        <p>
          <a href={pr.url} target="_blank" rel="noopener noreferrer">
            <strong>#{pr.number} {pr.title}</strong> <ExternalLink size={12} aria-hidden="true" />
          </a>{" "}
          · by {pr.author || "unknown"} · <span className="muted-pill">{pr.draft ? "draft" : pr.state}</span> · into <code>{pr.baseRef}</code> ·{" "}
          <span className="pr-add">+{pr.additions}</span> <span className="pr-del">−{pr.deletions}</span> in {pr.changedFiles} files
          {b.historyDate && <span className="muted"> · git history from {shortDate(b.historyDate)}</span>}
        </p>
      </div>

      {/* 3. Risk score and its reasons */}
      <section className={`panel pr-risk ${risk.level}`} aria-labelledby="pr-risk-title">
        <div className="pr-risk-head">
          <span className={`pr-level ${risk.level}`}>{LEVEL_LABEL[risk.level]}</span>
          <InfoHeading level={2} id="pr-risk-title" title={`${risk.score} point${risk.score === 1 ? "" : "s"}`} label="Risk score" help={HELP.pr.risk} />
        </div>
        {risk.reasons.length === 0 ? (
          <p className="muted">No risk rules apply: a small change, reached by tests, away from hotspots.</p>
        ) : (
          <ul className="pr-reasons">
            {risk.reasons.map((r) => (
              <li key={r.text}>
                <span className="pr-points">+{r.points}</span>
                <span>{r.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 4. Headline numbers */}
      <div className="stat-row">
        <Stat label="Changed functions" value={b.changedFunctions.length} help={HELP.pr.changedFunctions} />
        <Stat label="Functions affected" value={b.affected.functions} help={HELP.pr.affected} />
        <Stat label="Tests that reach it" value={b.tests.reaching.length} warn={b.changedFunctions.length && !b.tests.reaching.length ? "none" : undefined} />
        <Stat label="Untested changed functions" value={b.tests.untested.length} warn={b.tests.untested.length ? "not covered" : undefined} help={HELP.pr.untested} />
      </div>

      {b.tests.untested.length > 0 && (
        <p className="impact-warning" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>
            No test reaches {b.tests.untested.slice(0, 4).map(fnName).join(", ")}
            {b.tests.untested.length > 4 ? ` and ${b.tests.untested.length - 4} more` : ""}.
          </span>
        </p>
      )}

      <div className="calls-lists">
        {/* 5. Changed functions */}
        <section className="card calls-list" aria-label="Changed functions">
          <InfoHeading title="Changed functions" count={b.changedFunctions.length} help={HELP.pr.changedFunctions} />
          {b.changedFunctions.length === 0 ? (
            <p className="muted small">No Python, JavaScript or TypeScript functions changed.</p>
          ) : (
            <ul>
              {b.changedFunctions.slice(0, 30).map((c) => (
                <li key={c.fn.id}>
                  <div className="calls-item-main">
                    <strong>{fnName(c.fn)}</strong>
                    {c.tests === 0 && c.fn.kind !== "top-level" && <span className="warn-pill small-pill">no tests</span>}
                    <div className="muted small">
                      <a href={lineUrl(c.fn.file, c.fn.line)} target="_blank" rel="noopener noreferrer">
                        {c.fn.file}:L{c.fn.line}
                      </a>{" "}
                      · {c.affected} depend on it · {c.tests} test{c.tests === 1 ? "" : "s"}
                      {c.complexity && <ComplexityChange {...c.complexity} />}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {b.changedFunctions.length > 30 && <p className="muted small">{b.changedFunctions.length - 30} more not listed.</p>}
        </section>

        <div className="impact-side">
          {/* 6. Reviewers */}
          <section className="card calls-list" aria-label="Suggested reviewers">
            <InfoHeading title="Suggested reviewers" count={b.reviewers.length} help={HELP.pr.reviewers} />
            {b.reviewers.length === 0 ? (
              <p className="muted small">No one else changed these files recently.</p>
            ) : (
              <ul>
                {b.reviewers.map((r) => (
                  <li key={r.login}>
                    <a href={`https://github.com/${r.login}`} target="_blank" rel="noopener noreferrer">
                      @{r.login}
                    </a>
                    <span className="muted small">changed {r.files} of these files</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 7. Files that usually change with these */}
          <section className="card calls-list" aria-label="Usually changed together">
            <InfoHeading title="Usually changed with these" count={b.missingPartners.length} help={HELP.pr.partners} />
            {b.missingPartners.length === 0 ? (
              <p className="muted small">Nothing missing{b.notes.some((n) => n.includes("history")) ? " (git history not analysed)" : ""}.</p>
            ) : (
              <ul>
                {b.missingPartners.map((p) => (
                  <li key={`${p.changed}>${p.partner}`}>
                    <div className="calls-item-main">
                      <code>{p.partner}</code>
                      <div className="muted small">
                        changed with {p.changed} in {p.percent}% of its commits ({p.count} times)
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {/* 8. Files */}
      <section className="section" aria-label="Files changed">
        <div className="section-head">
          <InfoHeading level={2} title="Files changed" count={b.files.length} help={HELP.pr.files} />
        </div>
        <div className="card table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Change</th>
                <th scope="col" className="num">Lines</th>
                <th scope="col" className="num">Functions</th>
              </tr>
            </thead>
            <tbody>
              {b.files.map((f) => (
                <tr key={f.path}>
                  <td>
                    <code>{f.path}</code>
                    {f.hotspot >= 2 && <span className="warn-pill small-pill">hotspot</span>}
                    {f.isTest && <span className="muted-pill small-pill">test</span>}
                    {f.noDiff && <span className="muted-pill small-pill">no diff</span>}
                  </td>
                  <td>{f.status}</td>
                  <td className="num">
                    <span className="pr-add">+{f.additions}</span> <span className="pr-del">−{f.deletions}</span>
                  </td>
                  <td className="num">{f.functions.length || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 9. Notes about what couldn't be checked */}
      {b.notes.length > 0 && (
        <div className="footnote">
          {b.notes.map((n) => (
            <span key={n}>{n}</span>
          ))}
        </div>
      )}
    </>
  );
}
