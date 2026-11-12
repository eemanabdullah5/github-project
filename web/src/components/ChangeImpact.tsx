// Change impact section of the Calls tab: what a change to the selected function affects, and which tests reach it.
import { AlertTriangle, Crosshair } from "lucide-react";
import { useEffect, useState } from "react";
import { getCallImpact, type ChangeImpact as Impact, type ImpactItem, type Repo } from "../api";
import { Stat } from "./Hotspots";
import { InfoHeading } from "./InfoHelp";
import { HELP } from "../helpTexts";

interface Props {
  repo: Repo;
  fnId: string;
  nameOf: (id: string) => string;
  lineUrl: (path: string, line: number) => string;
  onGo: (id: string) => void;
}

/** "Agent.remember()" or "demo.py (top level)". */
const shortName = (item: ImpactItem) =>
  item.fn.kind === "top-level" ? `${item.fn.file.split("/").pop()} (top level)` : `${item.fn.qualified}()`;

/** Heading for one distance group. */
const stepLabel = (d: number) => (d === 1 ? "Direct callers" : `${d} steps away`);

export default function ChangeImpact({ repo, fnId, nameOf, lineUrl, onGo }: Props) {
  const [impact, setImpact] = useState<Impact | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setImpact(null);
    setError("");
    getCallImpact(repo.owner, repo.name, fnId)
      .then(setImpact)
      .catch((err) => setError(err.message));
  }, [repo.owner, repo.name, fnId]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!impact) return <p className="muted" role="status">Working out the change impact…</p>;

  const { totals, target } = impact;
  const name = target.kind === "top-level" ? "this code" : `${target.qualified}()`;
  // Group affected functions by distance: 1, 2, 3…
  const groups = new Map<number, ImpactItem[]>();
  for (const item of impact.affected) groups.set(item.distance, [...(groups.get(item.distance) ?? []), item]);

  /** One affected function with its path link and a button to centre the diagram on it. */
  const row = (item: ImpactItem) => (
    <li key={item.fn.id}>
      <div className="calls-item-main">
        <strong>{shortName(item)}</strong>
        {!item.certain && <span className="warn-pill small-pill">possible</span>}
        <div className="muted small">
          {item.fn.file} · calls {nameOf(item.via)} at{" "}
          <a href={lineUrl(item.fn.file, item.line)} target="_blank" rel="noopener noreferrer">
            L{item.line}
          </a>
        </div>
      </div>
      <button className="secondary calls-go" onClick={() => onGo(item.fn.id)} title={`Centre the diagram on ${shortName(item)}`}>
        <Crosshair size={14} aria-hidden="true" />
        Show its calls
      </button>
    </li>
  );

  return (
    <section className="panel impact" aria-labelledby="impact-title">
      <div className="section-head">
        <InfoHeading
          level={2}
          id="impact-title"
          title={`If you change ${name}`}
          help={HELP.impact.section}
        />
      </div>

      <div className="stat-row">
        <Stat label="Functions affected" value={totals.affected} warn={totals.certain < totals.affected ? `${totals.affected - totals.certain} possible` : undefined} />
        <Stat label="Files" value={totals.files} warn={totals.hotspotFiles ? `${totals.hotspotFiles} hotspot${totals.hotspotFiles === 1 ? "" : "s"}` : undefined} />
        <Stat label="Tests that reach it" value={totals.tests} warn={totals.tests === 0 ? "none" : undefined} />
        <Stat
          label="Furthest caller (steps)"
          value={totals.maxDistance}
          help={HELP.impact.furthest}
        />
      </div>

      {totals.tests === 0 && (
        <p className="impact-warning" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>No test reaches {name}. A mistake here won't be caught by the test suite.</span>
        </p>
      )}

      {impact.entryPoints.length > 0 && (
        <div className="impact-entry">
          <span className="muted small">Reaches {impact.entryPoints.length} entry point{impact.entryPoints.length === 1 ? "" : "s"} (code nothing else calls):</span>
          {impact.entryPoints.map((item) => (
            <button key={item.fn.id} className="secondary suggestion" onClick={() => onGo(item.fn.id)}>
              {shortName(item)} <span className="muted small">{item.fn.file}</span>
            </button>
          ))}
        </div>
      )}

      {totals.affected === 0 ? (
        <p className="muted">Nothing in the repo calls it, so a change only affects its own file{totals.tests ? " and its tests" : ""}.</p>
      ) : (
        <div className="calls-lists">
          <section className="card calls-list" aria-label="Affected functions">
            <InfoHeading title="Affected functions" count={totals.affected} help={HELP.impact.affected} />
            {[...groups].map(([distance, items]) => (
              <details key={distance} className="impact-group" open={distance <= 2}>
                <summary>
                  {stepLabel(distance)} <span className="muted small">({items.length})</span>
                </summary>
                <ul>{items.map(row)}</ul>
              </details>
            ))}
            {impact.more.affected > 0 && <p className="muted small">{impact.more.affected} more not listed.</p>}
          </section>

          <div className="impact-side">
            <section className="card calls-list" aria-label="Tests that reach it">
              <InfoHeading title="Tests that reach it" count={totals.tests} help={HELP.impact.tests} />
              {impact.tests.length === 0 ? <p className="muted small">None found.</p> : <ul>{impact.tests.map(row)}</ul>}
            </section>

            <section className="card calls-list" aria-label="Files affected">
              <InfoHeading title="Files" count={totals.files} help={HELP.impact.files} />
              <ul>
                {impact.files.map((f) => (
                  <li key={f.file}>
                    <div className="calls-item-main">
                      <code>{f.file}</code>
                      {f.hotspot > 0 && <span className="warn-pill small-pill">hotspot</span>}
                      {f.file === target.file && <span className="muted-pill small-pill">its own file</span>}
                    </div>
                    <span className="muted small">{f.functions ? `${f.functions} affected` : ""}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      )}

      <p className="muted small">
        Built from the call graph, so calls to it through libraries, callbacks or dynamic code aren't counted. "Possible" means the path uses a call matched by method name only.
      </p>
    </section>
  );
}
