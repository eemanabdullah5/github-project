// F4 — Hotspots tab.
// Shows what the git history says about a repo (last 12 months):
//  1. headline numbers   2. chart of the 10 riskiest files   3. full table
//  4. files that change together   5. folders only one person works on
// The analysis runs when the user clicks "Analyse history" (it only uses GitHub, not the AI).
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
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
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

  if (loading) return <p className="muted">Loading…</p>;

  const button = (
    <button onClick={analyse} disabled={analysing}>
      {analysing ? "Analysing…" : report ? "Refresh" : "Analyse history"}
    </button>
  );

  // Not analysed yet: explain what this does and show the button.
  if (!report) {
    return (
      <div className="panel">
        <p>
          <strong>Hotspots</strong> show which files change most often and are most complex: that's usually where bugs and
          slow delivery come from. They also show files that change together, and areas only one person works on.
        </p>
        <p className="muted small">Reads the last 12 months of commits from GitHub. No code is sent to the AI.</p>
        {button}
        {analysing && <p className="muted small">Reading git history… this can take up to a minute or two for busy repos.</p>}
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  const target: LinkTarget = { owner: repo.owner, name: repo.name, ref: report.commitSha };
  const chartFiles = report.files.filter((f) => f.score > 0).slice(0, CHART_FILES);
  const riskyAreas = report.areas.filter((a) => a.singleContributor);

  return (
    <section className="hotspots">
      {/* Top line: what was analysed, and the Refresh button. */}
      <div className="row">
        <p className="muted small grow">
          Last 12 months · analysed {shortDate(report.generatedAt)}
          {report.reachedLimit && " · only the newest 500 commits were used"}
        </p>
        {button}
      </div>
      {error && <p className="error">{error}</p>}

      {/* 1. Headline numbers */}
      <div className="stat-row">
        <Stat label="Commits analysed" value={report.commitsAnalyzed} />
        <Stat label="Files changed" value={report.filesChanged} />
        <Stat label="Areas with one contributor" value={riskyAreas.length} />
      </div>

      {report.commitsAnalyzed === 0 && <p className="muted">No commits in the last 12 months, so there's nothing to show.</p>}
      {report.commitsAnalyzed > 0 && report.commitsAnalyzed < 10 && (
        <p className="muted small">Only {report.commitsAnalyzed} commits: results get more meaningful with more history.</p>
      )}

      {/* 2. Chart of the riskiest files */}
      {chartFiles.length > 0 && (
        <>
          <h3>Top hotspots</h3>
          <p className="muted small">Risk score = how often a file changes × how complex it is. The riskiest file is 100.</p>
          <HotspotChart files={chartFiles} target={target} />
        </>
      )}

      {/* 3. Full table (also the accessible version of the chart) */}
      {report.files.length > 0 && (
        <>
          <h3>All changed files</h3>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th className="num">Changes</th>
                  <th className="num">Complexity</th>
                  <th className="num">Lines</th>
                  <th className="num">People</th>
                  <th>Last changed</th>
                  <th className="num">Score</th>
                </tr>
              </thead>
              <tbody>
                {report.files.slice(0, TABLE_FILES).map((f) => (
                  <tr key={f.path}>
                    <td>
                      <a href={fileUrl(target, f.path)} target="_blank" rel="noopener noreferrer">
                        <code>{f.path}</code>
                      </a>
                    </td>
                    <td className="num">{f.changes}</td>
                    <td className="num">{f.complexity}</td>
                    <td className="num">{f.lines}</td>
                    <td className="num">{f.authors}</td>
                    <td>{shortDate(f.lastChanged)}</td>
                    <td className="num">{f.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.files.length > TABLE_FILES && (
            <p className="muted small">Showing the top {TABLE_FILES} of {report.filesChanged} files.</p>
          )}
        </>
      )}

      {/* 4. Files that change together */}
      <h3>Files that change together</h3>
      {report.coChange.length === 0 ? (
        <p className="muted small">No pair of files changed together 3 or more times.</p>
      ) : (
        <>
          <p className="muted small">Often changed in the same commit. This can mean a hidden dependency between them.</p>
          <ul className="plain-list">
            {report.coChange.map((p) => (
              <li key={`${p.a}|${p.b}`}>
                <code>{p.a}</code> ⇄ <code>{p.b}</code>
                <span className="muted">
                  {" "}
                  — together {p.count} times ({p.percent}%)
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* 5. Knowledge risk: no names, only counts */}
      <h3>Knowledge risk</h3>
      <p className="muted small">How many different people changed each top-level folder. No names are shown or stored.</p>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Area</th>
              <th className="num">Commits</th>
              <th className="num">People</th>
              <th className="num">Files</th>
              <th>Status</th>
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
                <td>{a.singleContributor ? <span className="warn">⚠ Only one person</span> : <span className="muted">OK</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="muted small">
        Skipped: {report.skipped.merges} merge commits and {report.skipped.bots} bot commits. {report.skipped.large} large
        commits (over 30 files) count for hotspots but were left out of "files that change together".
      </p>
    </section>
  );
}

// One headline number with its label.
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className="stat-value">{value.toLocaleString()}</div>
    </div>
  );
}

// Horizontal bar chart: one bar per file, length = risk score (0–100).
// Hover or keyboard-focus a row to see its details in a small tooltip.
function HotspotChart({ files, target }: { files: HotspotFile[]; target: LinkTarget }) {
  return (
    <div className="bar-chart" role="list" aria-label="Top hotspots by risk score">
      {files.map((f) => (
        <div
          key={f.path}
          className="bar-row"
          role="listitem"
          tabIndex={0}
          aria-label={`${f.path}: score ${f.score}, ${f.changes} changes, complexity ${f.complexity}`}
        >
          <a className="bar-label" href={fileUrl(target, f.path)} target="_blank" rel="noopener noreferrer" title={f.path}>
            {f.path}
          </a>
          <div className="bar-track">
            {/* At least 2% wide, so a tiny score is still visible. */}
            <div className="bar" style={{ width: `${Math.max(f.score, 2)}%` }} />
            <span className="bar-value">{f.score}</span>
          </div>
          <div className="bar-tooltip" role="tooltip">
            <strong>{f.path}</strong>
            <div>
              {f.changes} changes · complexity {f.complexity} · {f.lines} lines
            </div>
            <div>
              {f.authors} {f.authors === 1 ? "person" : "people"} · last changed {shortDate(f.lastChanged)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
