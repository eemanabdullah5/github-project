// F4 — Hotspots tab.
// Shows what the git history says about a repo (last 12 months):
//  1. headline numbers   2. chart of the 10 riskiest files   3. full table
//  4. files that change together   5. folders only one person works on
// The analysis runs when the user clicks "Analyse history" (it only uses GitHub, not the AI).
import { AlertCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { analyzeHotspots, getHotspots, type HistoryReport, type HotspotFile, type Repo } from "../api";
import { githubLineUrl, type LinkTarget } from "../sourceLinks";

// How many files the chart and the table show.
const CHART_FILES = 10;
const TABLE_FILES = 25;

interface Props {
  repo: Repo;
}

// Shows a date like "8 Nov 2026".
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// Shortens a long path from the start, so the file name stays visible: "…/routers/submissions.py".
function shortPath(path: string, max = 36): string {
  if (path.length <= max) return path;
  const parts = path.split("/");
  let out = parts[parts.length - 1];
  if (out.length + 2 > max) return `…${out.slice(-(max - 1))}`; // the file name alone is too long
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i]}/${out}`;
    if (next.length + 2 > max) break;
    out = next;
  }
  return `…/${out}`;
}

// Link to a whole file on GitHub (line 1), at the version that was measured. Reuses F1.
function fileUrl(target: LinkTarget, path: string): string {
  return githubLineUrl(target, path, 1, 1).replace(/#L1$/, "");
}

export default function Hotspots({ repo }: Props) {
  const [report, setReport] = useState<HistoryReport | null>(null);
  const [loading, setLoading] = useState(true); // loading the saved report
  const [analysing, setAnalysing] = useState(false); // "Analyse history" is running
  const [error, setError] = useState("");

  // When the tab opens, load the saved report (if there is one).
  useEffect(() => {
    setLoading(true);
    getHotspots(repo.owner, repo.name)
      .then(setReport)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [repo.owner, repo.name]);

  // Runs the analysis on the server and shows the new report.
  async function analyse() {
    setAnalysing(true);
    setError("");
    try {
      setReport(await analyzeHotspots(repo.owner, repo.name));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAnalysing(false);
    }
  }

  if (loading) {
    return (
      <div className="tab-page">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const errorLine = error && (
    <p className="error" role="alert">
      <AlertCircle size={16} aria-hidden="true" />
      <span>{error}</span>
    </p>
  );

  // Not analysed yet: explain what this does and show the button.
  if (!report) {
    return (
      <div className="tab-page intro">
        <section className="panel intro-panel">
          <h2>Find the risky parts of the codebase</h2>
          <p className="lede">
            <strong>Hotspots</strong> show which files change most often and are most complex: that's usually where bugs and
            slow delivery come from. They also show files that change together, and areas only one person works on.
          </p>
          <p className="muted small">Reads the last 12 months of commits from GitHub. No code is sent to the AI.</p>
          <div className="row">
            <button onClick={analyse} disabled={analysing}>
              {analysing ? "Analysing…" : "Analyse history"}
            </button>
            {analysing && (
              <span className="muted small" role="status">
                Reading git history… this can take up to a minute or two for busy repos.
              </span>
            )}
          </div>
          {errorLine}
        </section>
      </div>
    );
  }

  const target: LinkTarget = { owner: repo.owner, name: repo.name, ref: report.commitSha };
  const chartFiles = report.files.filter((f) => f.score > 0).slice(0, CHART_FILES);
  const riskyAreas = report.areas.filter((a) => a.singleContributor);

  return (
    <div className="tab-page">
      {/* Top line: what was analysed, and the Refresh button. */}
      <div className="top-line">
        <p>
          Last 12 months · analysed {shortDate(report.generatedAt)}
          {report.reachedLimit && " · only the newest 500 commits were used"}
        </p>
        <button className="secondary" onClick={analyse} disabled={analysing}>
          <RefreshCw size={14} aria-hidden="true" />
          {analysing ? "Analysing…" : "Refresh"}
        </button>
      </div>
      {errorLine}

      {/* 1. Headline numbers */}
      <div className="stat-row">
        <Stat label="Commits analysed" value={report.commitsAnalyzed} />
        <Stat label="Files changed" value={report.filesChanged} />
        <Stat label="Areas with one contributor" value={riskyAreas.length} warn={riskyAreas.map((a) => a.area).join(", ")} />
      </div>

      {report.commitsAnalyzed === 0 && <p className="muted">No commits in the last 12 months, so there's nothing to show.</p>}
      {report.commitsAnalyzed > 0 && report.commitsAnalyzed < 10 && (
        <p className="muted small">Only {report.commitsAnalyzed} commits: results get more meaningful with more history.</p>
      )}

      {/* 2. Chart of the riskiest files */}
      {chartFiles.length > 0 && (
        <section className="panel chart-card" aria-labelledby="hs-top">
          <div className="section-head">
            <h2 id="hs-top">Top hotspots</h2>
            <p>Risk score = how often a file changes × how complex it is. The riskiest file is 100.</p>
          </div>
          <HotspotChart files={chartFiles} target={target} />
        </section>
      )}

      {/* 3. Full table (also the accessible version of the chart) */}
      {report.files.length > 0 && (
        <section className="section" aria-labelledby="hs-all">
          <div className="section-head">
            <h2 id="hs-all">All changed files</h2>
          </div>
          <div className="card table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col" className="num">Changes</th>
                  <th scope="col" className="num">Complexity</th>
                  <th scope="col" className="num">Lines</th>
                  <th scope="col" className="num">People</th>
                  <th scope="col" className="num">Last changed</th>
                  <th scope="col" className="num">Score</th>
                </tr>
              </thead>
              <tbody>
                {report.files.slice(0, TABLE_FILES).map((f) => (
                  <tr key={f.path}>
                    <td>
                      <a href={fileUrl(target, f.path)} target="_blank" rel="noopener noreferrer">
                        {f.path}
                      </a>
                    </td>
                    <td className="num">{f.changes}</td>
                    <td className="num">{f.complexity}</td>
                    <td className="num">{f.lines}</td>
                    <td className="num">{f.authors}</td>
                    <td className="num nowrap">{shortDate(f.lastChanged)}</td>
                    <td className="num">
                      <strong>{f.score}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.files.length > TABLE_FILES && (
            <p className="muted small">
              Showing the top {TABLE_FILES} of {report.filesChanged} files.
            </p>
          )}
        </section>
      )}

      <div className="two-col">
        {/* 4. Files that change together */}
        <section className="section" aria-labelledby="hs-pairs">
          <div className="section-head">
            <h2 id="hs-pairs">Files that change together</h2>
            <p>Often changed in the same commit. This can mean a hidden dependency between them.</p>
          </div>
          {report.coChange.length === 0 ? (
            <p className="card list-message">No pair of files changed together 3 or more times.</p>
          ) : (
            <ul className="card pair-list">
              {report.coChange.map((p) => (
                <li key={`${p.a}|${p.b}`}>
                  <span className="pair-files">
                    <a href={fileUrl(target, p.a)} target="_blank" rel="noopener noreferrer">{p.a}</a>
                    <span className="arrow" aria-label="and">⇄</span>
                    <a href={fileUrl(target, p.b)} target="_blank" rel="noopener noreferrer">{p.b}</a>
                  </span>
                  <span className="muted small">
                    Together {p.count} times ({p.percent}%)
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 5. Knowledge risk: no names, only counts */}
        <section className="section" aria-labelledby="hs-areas">
          <div className="section-head">
            <h2 id="hs-areas">Knowledge risk</h2>
            <p>How many different people changed each top-level folder. No names are shown or stored.</p>
          </div>
          <div className="card table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Area</th>
                  <th scope="col" className="num">Commits</th>
                  <th scope="col" className="num">People</th>
                  <th scope="col" className="num">Files</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {report.areas.map((a) => (
                  <tr key={a.area}>
                    <td>
                      <code>{a.area}</code>
                    </td>
                    <td className="num">{a.commits}</td>
                    <td className="num">{a.authors}</td>
                    <td className="num">{a.files}</td>
                    {/* Icon + words, so it doesn't rely on colour alone. */}
                    <td>
                      {a.singleContributor ? <span className="warn-pill">⚠ Only one person</span> : <span className="muted small">OK</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <p className="footnote">
        Skipped: {report.skipped.merges} merge commits and {report.skipped.bots} bot commits. {report.skipped.large} large{" "}
        {report.skipped.large === 1 ? "commit" : "commits"} (over 30 files) counted for hotspots but{" "}
        {report.skipped.large === 1 ? "was" : "were"} left out of “files that change together”.
      </p>
    </div>
  );
}

// One headline number with its label (and, optionally, which areas need attention).
export function Stat({ label, value, warn }: { label: string; value: number; warn?: string }) {
  return (
    <div className="card stat">
      <span className="stat-label">{label}</span>
      <span className="row">
        <span className="stat-value">{value.toLocaleString()}</span>
        {warn && <span className="warn-pill">⚠ {warn}</span>}
      </span>
    </div>
  );
}

// Horizontal bar chart: one bar per file, length = risk score (0–100), in the single accent colour.
// Hover a row, or tab to its file link, to see the details in a tooltip.
function HotspotChart({ files, target }: { files: HotspotFile[]; target: LinkTarget }) {
  return (
    <>
      <ul className="bar-chart" aria-label="Top hotspots by risk score" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {files.map((f) => (
          <li key={f.path} className="bar-row">
            <a
              className="bar-label"
              href={fileUrl(target, f.path)}
              target="_blank"
              rel="noopener noreferrer"
              title={f.path}
              aria-label={`${f.path}: score ${f.score}, ${f.changes} changes, complexity ${f.complexity}`}
            >
              {shortPath(f.path)}
            </a>
            <div className="bar-track" aria-hidden="true">
              {/* At least 2% wide, so a tiny score is still visible. 44px leaves room for the number. */}
              <div className="bar" style={{ width: `calc((100% - 44px) * ${Math.max(f.score, 2) / 100})` }} />
              <span className="bar-value">{f.score}</span>
            </div>
            <div className="bar-tooltip" role="tooltip">
              <strong>{f.path}</strong>
              <span>
                {f.changes} changes · complexity {f.complexity} · {f.lines} lines
              </span>
              <span className="tip-muted">
                {f.authors} {f.authors === 1 ? "person" : "people"} · last changed {shortDate(f.lastChanged)}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <div className="chart-axis" aria-hidden="true">
        <span />
        <div>
          <span>0</span>
          <span>50</span>
          <span>100</span>
        </div>
      </div>
    </>
  );
}
