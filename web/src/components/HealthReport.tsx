// F5 — Report tab.
// Shows the repo's health report and lets the user generate a new one or download it as a Markdown file.
// The report is saved on the server, so it opens instantly the next time.
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { generateReport, getReport, type HealthReport as Report, type Repo } from "../api";
import { linkCitations, type LinkTarget } from "../sourceLinks";

interface Props {
  repo: Repo;
}

// Makes every link in the report open in a new tab (same as in chat answers).
const markdownComponents = {
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

// Saves some text as a file in the user's Downloads folder.
// It makes a temporary link to the text and clicks it, which is the usual way to download from a web page.
function downloadFile(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export default function HealthReport({ repo }: Props) {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true); // loading the saved report
  const [generating, setGenerating] = useState(false); // "Generate" is running
  const [error, setError] = useState("");

  // When the tab opens, load the saved report (if there is one).
  useEffect(() => {
    setLoading(true);
    getReport(repo.owner, repo.name)
      .then(setReport)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [repo.owner, repo.name]);

  // Asks the server for a new report and shows it.
  async function generate() {
    setGenerating(true);
    setError("");
    try {
      setReport(await generateReport(repo.owner, repo.name));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  if (loading) return <p className="muted">Loading…</p>;

  const button = (
    <button onClick={generate} disabled={generating}>
      {generating ? "Generating…" : report ? "Regenerate" : "Generate report"}
    </button>
  );

  // No report yet: explain what it is and show the button.
  if (!report) {
    return (
      <div className="panel">
        <p>
          A one-page <strong>health report</strong> for leaders: what the project does, tech stack, structure, dependencies,
          risks, onboarding notes, and hotspots from the git history.
        </p>
        <p className="muted small">Tip: run "Analyse history" in the Hotspots tab first, so the report includes hotspots.</p>
        {button}
        {generating && <p className="muted small">Writing the report… this usually takes 20-40 seconds.</p>}
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  // Citations become GitHub links at the commit the report describes (F1).
  const target: LinkTarget = { owner: repo.owner, name: repo.name, ref: report.commitSha };
  const linkedMarkdown = linkCitations(report.markdown, target, report.sources);

  return (
    <section className="report">
      {/* Top line: when it was made, and the buttons. */}
      <div className="row">
        <p className="muted small grow">Generated {new Date(report.generatedAt).toLocaleString()}</p>
        {/* The downloaded file has the same clickable GitHub links. */}
        <button className="secondary" onClick={() => downloadFile(`${repo.owner}-${repo.name}-health-report.md`, linkedMarkdown)}>
          Download .md
        </button>
        {button}
      </div>
      {generating && <p className="muted small">Writing a new report… this usually takes 20-40 seconds.</p>}
      {error && <p className="error">{error}</p>}

      {/* The report itself, shown the same way as chat answers (no raw HTML). */}
      <div className="report-body">
        <ReactMarkdown components={markdownComponents}>{linkedMarkdown}</ReactMarkdown>
      </div>
    </section>
  );
}
