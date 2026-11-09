// F5 — Report tab.
// Shows the repo's health report and lets the user generate a new one or download it as a Markdown file.
// The report is saved on the server, so it opens instantly the next time.
import { AlertCircle, Download, Info } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { generateReport, getReport, type HealthReport as Report, type Repo } from "../api";
import { CitationWarning, markdownComponents } from "./CitationLink";
import MermaidDiagram from "./MermaidDiagram";
import { linkCitations, type LinkTarget } from "../sourceLinks";

interface Props {
  repo: Repo;
}

// Links open in a new tab (from CitationLink), and ```mermaid blocks (the architecture map) are drawn as diagrams.
const reportComponents = {
  ...markdownComponents,
  code: ({ className, children, node: _node, ...rest }: React.HTMLAttributes<HTMLElement> & { node?: unknown }) =>
    className?.includes("language-mermaid") ? (
      <MermaidDiagram code={String(children).trim()} label="Architecture map: folders of code and the imports between them" />
    ) : (
      <code className={className} {...rest}>
        {children}
      </code>
    ),
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

  // No report yet: explain what it is and show the button.
  if (!report) {
    return (
      <div className="tab-page intro">
        <section className="panel intro-panel">
          <h2>A one-page summary you can forward</h2>
          <p className="lede">
            A one-page <strong>health report</strong> for leaders: what the project does, tech stack, structure, dependencies,
            risks, onboarding notes, and hotspots from the git history.
          </p>
          <p className="muted small row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
            <Info size={14} aria-hidden="true" style={{ flex: "none", marginTop: 3 }} />
            <span>Tip: run “Analyse history” in the Hotspots tab first, so the report includes hotspots.</span>
          </p>
          <div className="row">
            <button onClick={generate} disabled={generating}>
              {generating ? "Writing the report…" : "Generate report"}
            </button>
            {generating && (
              <span className="muted small" role="status">
                Writing the report… this usually takes 20–40 seconds.
              </span>
            )}
          </div>
          {errorLine}
        </section>
      </div>
    );
  }

  // Citations become GitHub links at the commit the report describes (F1).
  const target: LinkTarget = { owner: repo.owner, name: repo.name, ref: report.commitSha };
  const linkedMarkdown = linkCitations(report.markdown, target, report.sources);
  // The downloaded file can't show the ⚠ badge, so unverified citations are written out as "(⚠ unverified)".
  const exportMarkdown = linkCitations(report.markdown, target, report.sources, { forExport: true });
  const generatedAt = new Date(report.generatedAt).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="tab-page" style={{ gap: 20 }}>
      {/* Top line: when it was made, and the buttons. */}
      <div className="top-line report-toolbar">
        <p>Generated {generatedAt}</p>
        <div className="row">
          {/* The downloaded file has the same clickable GitHub links; unverified citations are marked in words. */}
          <button className="secondary" onClick={() => downloadFile(`${repo.owner}-${repo.name}-health-report.md`, exportMarkdown)}>
            <Download size={14} aria-hidden="true" />
            Download .md
          </button>
          <button onClick={generate} disabled={generating}>
            {generating ? "Regenerating…" : "Regenerate"}
          </button>
        </div>
      </div>
      {generating && (
        <p className="muted small report-toolbar" role="status">
          Writing a new report… this usually takes 20–40 seconds.
        </p>
      )}
      {error && <div className="report-toolbar">{errorLine}</div>}

      {/* The report itself, rendered like a document (no raw HTML). */}
      <article className="report-page">
        <CitationWarning markdown={report.markdown} sources={report.sources} />
        <div className="markdown">
          <ReactMarkdown components={reportComponents}>{linkedMarkdown}</ReactMarkdown>
        </div>
      </article>
    </div>
  );
}
